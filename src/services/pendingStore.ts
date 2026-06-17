import { AnalysisResult, TodoItem, TaskSource } from '../types/analysis.js';
import { Conflict } from './planStore.js';
import { v4 as uuidv4 } from 'uuid';

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
  | { type: 'awaiting_image_followup'; chatId: number; imageData: any; expiresAt: number };

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
    createdAt: Date.now(),
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

export function setAwaitingImageFollowup(userId: number, chatId: number, imageData: any) {
  userFlows.set(userId, {
    type: 'awaiting_image_followup',
    chatId,
    imageData,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
}

export function getAwaitingImageFollowup(userId: number): { imageData: any } | undefined {
  const state = userFlows.get(userId);
  if (state && state.type === 'awaiting_image_followup') {
    if (Date.now() > state.expiresAt) {
      userFlows.delete(userId);
      return undefined;
    }
    return { imageData: state.imageData };
  }
  return undefined;
}

export function clearAwaitingImageFollowup(userId: number) {
  const state = userFlows.get(userId);
  if (state && state.type === 'awaiting_image_followup') {
    userFlows.delete(userId);
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
  if (state && Date.now() - state.createdAt > 5 * 60 * 1000) {
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
  const now = Date.now();
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
