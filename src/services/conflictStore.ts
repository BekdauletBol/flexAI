import { randomBytes } from 'crypto';

interface ConflictEntry {
  newId: string;
  existingId: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const store = new Map<string, ConflictEntry>();

function generateKey(): string {
  return randomBytes(4).toString('hex'); // 8 hex chars
}

/** Store a conflict pair and return a short key for use in callback_data */
export function storeConflict(newId: string, existingId: string): string {
  const key = generateKey();
  store.set(key, { newId, existingId, expiresAt: Date.now() + TTL_MS });
  return key;
}

/** Resolve a short key back to { newId, existingId }. Returns null if expired/missing. */
export function resolveConflictKey(key: string): { newId: string; existingId: string } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { newId: entry.newId, existingId: entry.existingId };
}

/** Periodic cleanup (optional — call from scheduler or let GC handle) */
export function cleanupConflictStore(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}
