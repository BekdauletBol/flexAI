import OpenAI from 'openai';
import { config } from '../config.js';
import { groq, GROQ_MODEL, hasGroq } from './groq.js';
import { logger } from '../logger.js';

const githubModelsClient = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 60000,
  maxRetries: 1,
});

/** Vision content block — used for image analysis */
export interface ImageContentBlock {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

/** Text content block */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentPart = ImageContentBlock | TextContentBlock;

export interface CallLLMOptions {
  preferGitHub?: boolean;
  timeout?: number;
  fallbackModel?: string;
  hasImage?: boolean;
  [key: string]: any;
}

function pickProvider(preferGitHub?: boolean): { client: OpenAI; model: string; provider: string } {
  if (preferGitHub) {
    return { client: githubModelsClient, model: config.openaiModel, provider: 'github' };
  }
  if (hasGroq) {
    return { client: groq, model: GROQ_MODEL, provider: 'groq' };
  }
  return { client: githubModelsClient, model: config.openaiModel, provider: 'github' };
}

function pickFallback(
  primaryProvider: string,
  preferGitHub?: boolean,
): { client: OpenAI; model: string; provider: string } | null {
  if (primaryProvider === 'groq') {
    return { client: githubModelsClient, model: config.openaiModel, provider: 'github' };
  }
  if (hasGroq && !preferGitHub) {
    return { client: groq, model: GROQ_MODEL, provider: 'groq' };
  }
  return null;
}

/** Pick the right vision-capable model for the given provider */
function pickVisionModel(provider: string): string {
  if (provider === 'github') {
    // gpt-4o supports vision on GitHub Models
    return config.openaiModel.startsWith('gpt-4') ? config.openaiModel : 'gpt-4o';
  }
  // Groq doesn't support vision — but this shouldn't be called when hasImage=true
  return config.openaiModel;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function callLLM(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  options: CallLLMOptions = {},
): Promise<{ content: string; provider: string; model: string }> {
  const { preferGitHub, timeout = 60000, fallbackModel, hasImage, ...params } = options;

  // Vision requests always go through GitHub Models — Groq has no vision support
  const useGitHub = preferGitHub || hasImage;

  const primary = pickProvider(useGitHub);
  const model = hasImage ? pickVisionModel(primary.provider) : primary.model;

  const requestParams: any = {
    model,
    messages: messages as any,
    ...params,
  };

  // Vision requests need higher max_tokens for structured JSON responses
  if (hasImage && !params.max_tokens) {
    requestParams.max_tokens = 2048;
  }

  try {
    const response = await withTimeout(
      primary.client.chat.completions.create(requestParams),
      timeout,
    ) as any;

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    logger.debug(
      { provider: primary.provider, model },
      '[LLM] Primary provider responded',
    );
    return { content, provider: primary.provider, model };
  } catch (primaryError: any) {
    logger.warn(
      { provider: primary.provider, model, error: primaryError?.message },
      '[LLM] Primary provider failed',
    );

    // Vision requests have no fallback (Groq doesn't support images)
    if (hasImage) {
      throw new Error(
        `[LLM] Vision request failed on ${primary.provider}: ${primaryError?.message}. No fallback available (Groq doesn't support vision).`,
      );
    }

    const fallback = pickFallback(primary.provider, preferGitHub);
    if (!fallback) {
      throw new Error(
        `[LLM] Both providers failed. Primary (${primary.provider}): ${primaryError?.message}. No fallback available.`,
      );
    }

    const fallbackMdl = fallbackModel || fallback.model;
    try {
      const fallbackResponse = await withTimeout(
        fallback.client.chat.completions.create({
          model: fallbackMdl,
          messages: messages as any,
          ...params,
        }),
        timeout,
      ) as any;

      const fallbackContent = fallbackResponse.choices[0]?.message?.content;
      if (!fallbackContent) throw new Error('Empty fallback response');

      logger.info(
        { primary: primary.provider, fallback: fallback.provider, fallbackModel: fallbackMdl },
        '[LLM] Fallback provider responded successfully',
      );
      return { content: fallbackContent, provider: fallback.provider, model: fallbackMdl };
    } catch (fallbackError: any) {
      throw new Error(
        `[LLM] Both providers failed. Primary (${primary.provider}): ${primaryError?.message}. ` +
        `Fallback (${fallback.provider}): ${fallbackError?.message}`,
      );
    }
  }
}
