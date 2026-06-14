import { AnalysisResult, TodoItem } from '../types/analysis.js';
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
}

const pendingNotes = new Map<string, PendingVoiceNote>();

export type UserFlowState = 
  | { type: 'awaiting_reschedule'; pendingId: string; conflictIndex?: number; customField?: 'date' | 'time' }
  | { type: 'awaiting_custom_reminder'; pendingId: string; taskIndex: number };

const userFlows = new Map<number, UserFlowState>();

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
