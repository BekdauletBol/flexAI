import PQueue from 'p-queue';
import { logger } from '../logger.js';

export const voiceQueue = new PQueue({ concurrency: 5 });

voiceQueue.on('active', () => {
  logger.info({ queueSize: voiceQueue.size, pending: voiceQueue.pending }, 'Voice queue: job started');
});

voiceQueue.on('completed', () => {
  logger.debug({ queueSize: voiceQueue.size, pending: voiceQueue.pending }, 'Voice queue: job completed');
});

voiceQueue.on('error', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Voice queue: unhandled error');
});

let activeJobs = 0;

export function getQueueStats() {
  return {
    size: voiceQueue.size,
    pending: voiceQueue.pending,
    active: activeJobs,
  };
}
