import { linq } from './client.ts';
import {
  getChat,
  getLineReputation,
  setLineReputation,
  upsertChat,
  now,
  type HealthStatus,
  type Reputation,
} from '../db.ts';

/**
 * Chat health and line reputation gating.
 *
 * The health status arrives on every chat-bearing webhook, so the cheap path is to
 * cache it from the webhook stream and read the cache as a pre-send check. We fall
 * back to a live read only when we've never seen the chat.
 */

export function cacheChatHealth(chatId: string, status: HealthStatus): void {
  const existing = getChat(chatId);
  if (existing?.health_status === status) return;
  upsertChat(chatId, { health_status: status, health_updated_at: now() });
}

export async function getChatHealth(chatId: string): Promise<HealthStatus> {
  const cached = getChat(chatId);
  if (cached?.health_updated_at) return cached.health_status;

  const chat = await linq.chats.retrieve(chatId);
  const status = (chat.health_status?.status ?? 'HEALTHY') as HealthStatus;
  cacheChatHealth(chatId, status);
  return status;
}

/**
 * Refreshes every line's reputation from GET /v3/phone_numbers.
 *
 * Called on startup and on the phone_number.status_updated webhook, not per send —
 * the cached value is what the send path reads.
 */
export async function refreshLineReputations(): Promise<void> {
  const response = await linq.phoneNumbers.list();
  for (const line of response.phone_numbers) {
    const reputation = (line.reputation?.status ?? 'HEALTHY') as Reputation;
    setLineReputation(line.phone_number, reputation);
  }
}

export function cacheLineReputation(phoneNumber: string, reputation: Reputation): void {
  setLineReputation(phoneNumber, reputation);
}

export type HealthGate =
  | { action: 'send' }
  | { action: 'slow'; reason: string }
  | { action: 'block'; reason: string };

/**
 * Pre-send gate on the chat's own health.
 *
 * OPTED_OUT is terminal and never resumes from here — Linq clears it when the
 * recipient replies again, which arrives as a webhook and updates the cache.
 */
export function gateOnChatHealth(status: HealthStatus): HealthGate {
  switch (status) {
    case 'HEALTHY':
      return { action: 'send' };
    case 'AT_RISK':
      return { action: 'slow', reason: 'chat health is AT_RISK' };
    case 'CRITICAL':
      return { action: 'block', reason: 'chat health is CRITICAL — pausing until it recovers' };
    case 'OPTED_OUT':
      return { action: 'block', reason: 'chat health is OPTED_OUT — terminal' };
  }
}

/**
 * Pre-send gate on the sending line's reputation.
 *
 * Note what this deliberately does not do: it never moves an existing conversation
 * to a different line to escape an AT_RISK status. Linq's guidance is to improve
 * engagement and let the line recover. Slowing down is the correct response.
 */
export function gateOnLineReputation(line: string | null): HealthGate {
  if (!line) return { action: 'send' };
  const reputation = getLineReputation(line);
  if (!reputation || reputation === 'HEALTHY') return { action: 'send' };
  if (reputation === 'AT_RISK') return { action: 'slow', reason: `line ${line} is AT_RISK` };
  return { action: 'block', reason: `line ${line} is CRITICAL — pausing sends on it` };
}

/** Lines safe to onboard a new user onto. */
export function healthyLines(lines: readonly string[]): string[] {
  return lines.filter((line) => (getLineReputation(line) ?? 'HEALTHY') === 'HEALTHY');
}
