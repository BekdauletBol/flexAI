import { AnalysisResult, TodoItem, TaskSource } from '../types/analysis.js';
import { Conflict } from './planStore.js';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';

export interface PendingVoiceNote {
  id: string;
  chatId: number;
  userId: number;
  analysis: AnalysisResult;
  conflicts: Conflict[];
  phase: 'conflict' | 'reminder';
  createdAt: number;
  resolvedTodos: TodoItem[];
  reminderIndex: number;
  conflictIndex?: number;
  source: TaskSource;
}

const pendingNotes = new Map<string, PendingVoiceNote>();

export type UserFlowState = 
  | { type: 'awaiting_reschedule'; pendingId: string; conflictIndex?: number; customField?: 'date' | 'time' }
  | { type: 'awaiting_custom_reminder'; pendingId: string; taskIndex: number }
  | { type: 'awaiting_clarification'; transcript: string; chatId: number; statusMsgId: number }
  | { type: 'awaiting_image_followup'; chatId: number; imageData: any; expiresAt: number }
  | { type: 'awaiting_reminder_conflict_confirm'; userId: number; taskName: string; reminderMinutes: number; scheduledAtUtc: string; conflicts: any[] };

const userFlows = new Map<number, UserFlowState>();

export interface UserState {
  flow: 'reschedule' | 'delete' | 'picker' | null;
  pendingTaskId?: string;
  pendingTasks?: any[]; // using any[] or StoredPlan/TodoItem based on what's available
  step?: string;
}

const userStates = new Map<number, UserState>();

export function getUserState(userId: number): UserState | undefined {
  return userStates.get(userId);
}

export function setUserState(userId: number, state: UserState) {
  userStates.set(userId, state);
}

export function clearUserState(userId: number) {
  userStates.delete(userId);
}

export function savePending(data: Omit<PendingVoiceNote, 'id' | 'createdAt'>): string {
  const id = uuidv4();
  const pending: PendingVoiceNote = {
    ...data,
    id,
    createdAt: DateTime.now().toMillis(),
  };
  
  // Replace any existing pending note for this user
  for (const [key, val] of pendingNotes.entries()) {
    if (val.userId === data.userId) {
      pendingNotes.delete(key);
    }
  }
  
  pendingNotes.set(id, pending);
  return id;
}

export function getPending(id: string): PendingVoiceNote | undefined {
  return pendingNotes.get(id);
}

export function deletePending(id: string) {
  pendingNotes.delete(id);
}

export function getUserPending(userId: number): PendingVoiceNote | undefined {
  for (const pending of pendingNotes.values()) {
    if (pending.userId === userId) {
      return pending;
    }
  }
  return undefined;
}

export function setUserFlowState(userId: number, state: UserFlowState) {
  userFlows.set(userId, state);
}

export function getUserFlowState(userId: number): UserFlowState | undefined {
  return userFlows.get(userId);
}

export function clearUserFlowState(userId: number) {
  userFlows.delete(userId);
}

export interface AwaitingVoiceState {
  chatId: number;
  userId: number;
  imageData: any;
  expiresAt: number;
}

// Keyed by chat_id — blocks report/cached responses until follow-up voice/text arrives
const chatAwaitingVoice = new Map<number, AwaitingVoiceState>();

export function setAwaitingImageFollowup(userId: number, chatId: number, imageData: any) {
  const expiresAt = DateTime.now().toMillis() + 10 * 60 * 1000;
  userFlows.set(userId, {
    type: 'awaiting_image_followup',
    chatId,
    imageData,
    expiresAt,
  });
  chatAwaitingVoice.set(chatId, { chatId, userId, imageData, expiresAt });
}

export function isAwaitingVoiceFollowup(chatId: number): boolean {
  const state = chatAwaitingVoice.get(chatId);
  if (!state) return false;
  if (DateTime.now().toMillis() > state.expiresAt) {
    chatAwaitingVoice.delete(chatId);
    return false;
  }
  return true;
}

export function getAwaitingVoiceFollowup(chatId: number): AwaitingVoiceState | undefined {
  const state = chatAwaitingVoice.get(chatId);
  if (!state) return undefined;
  if (DateTime.now().toMillis() > state.expiresAt) {
    chatAwaitingVoice.delete(chatId);
    return undefined;
  }
  return state;
}

export function getAwaitingImageFollowup(userId: number): { imageData: any; chatId?: number } | undefined {
  const state = userFlows.get(userId);
  if (state && state.type === 'awaiting_image_followup') {
    if (DateTime.now().toMillis() > state.expiresAt) {
      userFlows.delete(userId);
      chatAwaitingVoice.delete(state.chatId);
      return undefined;
    }
    return { imageData: state.imageData, chatId: state.chatId };
  }
  return undefined;
}

export function clearAwaitingImageFollowup(userId: number) {
  const state = userFlows.get(userId);
  if (state && state.type === 'awaiting_image_followup') {
    chatAwaitingVoice.delete(state.chatId);
    userFlows.delete(userId);
  }
}

export function clearAwaitingVoiceFollowup(chatId: number) {
  const state = chatAwaitingVoice.get(chatId);
  if (state) {
    chatAwaitingVoice.delete(chatId);
    const flow = userFlows.get(state.userId);
    if (flow && flow.type === 'awaiting_image_followup' && flow.chatId === chatId) {
      userFlows.delete(state.userId);
    }
  }
}

// ─── Interactive Reschedule State ──────────────────────────────────────────────

export interface RescheduleState {
  taskId: string;
  taskName: string;
  currentDate: string;
  currentTime: string;
  pendingId?: string;
  conflictIndex?: number;
  selectedDate?: string;
  selectedTime?: string;
  chatId: number;
  lang: string;
  createdAt: number;
}

const rescheduleStates = new Map<number, RescheduleState>();

export function setRescheduleState(userId: number, state: RescheduleState) {
  rescheduleStates.set(userId, state);
}

export function getRescheduleState(userId: number): RescheduleState | undefined {
  const state = rescheduleStates.get(userId);
  if (state && DateTime.now().toMillis() - state.createdAt > 5 * 60 * 1000) {
    rescheduleStates.delete(userId);
    return undefined;
  }
  return state;
}

export function clearRescheduleState(userId: number) {
  rescheduleStates.delete(userId);
}

// Cleanup task (runs every minute)
setInterval(() => {
  const now = DateTime.now().toMillis();
  for (const [id, note] of pendingNotes.entries()) {
    if (now - note.createdAt > 10 * 60 * 1000) { // 10 minutes
      pendingNotes.delete(id);
    }
  }
  for (const [userId, state] of rescheduleStates.entries()) {
    if (now - state.createdAt > 5 * 60 * 1000) {
      rescheduleStates.delete(userId);
    }
  }
}, 60 * 1000);
