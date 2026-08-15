import { randomUUID } from 'node:crypto';
import { linq, isOptOutRejection, type MessagePart } from './client.ts';
import { gateOnChatHealth, gateOnLineReputation, getChatHealth } from './health.ts';
import { gateOnCadence, gateOnVolume, recordSend } from './volume.ts';
import {
  getChat,
  getOptOut,
  markCourtesySent,
  now,
  recordOptOut,
  upsertChat,
} from '../db.ts';

/**
 * The single outbound path.
 *
 * Nothing in this codebase calls the Linq send endpoints directly — everything goes
 * through here so the opt-out, health, reputation, cadence, and volume gates cannot
 * be bypassed by a new feature.
 */

export type BlockReason =
  | 'optout'
  | 'health'
  | 'reputation'
  | 'cadence'
  | 'volume'
  | 'error';

export type SendResult =
  | { sent: true; chatId: string; messageId: string | undefined }
  | { sent: false; blockedBy: BlockReason; reason: string };

export interface SendOptions {
  /**
   * Handles this message will reach. Used for the opt-out gate. For a group chat,
   * pass every participant — Linq does not block group threads, so this list is the
   * only opt-out enforcement that happens.
   */
  recipients?: readonly string[];
  /** Skips the cadence back-off. Only legitimate for a direct reply to an inbound. */
  isReplyToInbound?: boolean;
  isNewConversation?: boolean;
}

function firstOptedOutRecipient(recipients: readonly string[] | undefined): string | undefined {
  if (!recipients) return undefined;
  return recipients.find((handle) => getOptOut(handle) !== undefined);
}

/** Sends into an existing chat, running every gate first. */
export async function sendToChat(
  chatId: string,
  parts: MessagePart[],
  options: SendOptions = {},
): Promise<SendResult> {
  const optedOut = firstOptedOutRecipient(options.recipients);
  if (optedOut) {
    return {
      sent: false,
      blockedBy: 'optout',
      reason: `${optedOut} has opted out — no outbound, including courtesy messages`,
    };
  }

  if (!options.isReplyToInbound) {
    const cadence = gateOnCadence(chatId);
    if (!cadence.allowed) return { sent: false, blockedBy: 'cadence', reason: cadence.reason };
  }

  const health = gateOnChatHealth(await getChatHealth(chatId));
  if (health.action === 'block') {
    return { sent: false, blockedBy: 'health', reason: health.reason };
  }

  const chat = getChat(chatId);
  const line = chat?.line ?? null;

  const reputation = gateOnLineReputation(line);
  if (reputation.action === 'block') {
    return { sent: false, blockedBy: 'reputation', reason: reputation.reason };
  }

  // AT_RISK on either the chat or the line means slow down. Combined with an
  // unanswered outbound, that is enough to hold this send.
  const shouldSlow = health.action === 'slow' || reputation.action === 'slow';
  if (shouldSlow && !options.isReplyToInbound && (chat?.unanswered_outbound ?? 0) > 0) {
    return {
      sent: false,
      blockedBy: 'health',
      reason: `slowing down (${health.action === 'slow' ? health.reason : reputation.action === 'slow' ? reputation.reason : ''}) with an unanswered outbound pending`,
    };
  }

  const volume = gateOnVolume(line, options.isNewConversation ?? false);
  if (!volume.allowed) return { sent: false, blockedBy: 'volume', reason: volume.reason };

  try {
    const response = await linq.chats.messages.send(chatId, {
      message: { parts, idempotency_key: randomUUID() },
    });

    recordSend(line, options.isNewConversation ?? false);
    upsertChat(chatId, {
      last_outbound_at: now(),
      first_outbound_at: chat?.first_outbound_at ?? now(),
      outbound_count: (chat?.outbound_count ?? 0) + 1,
      unanswered_outbound: (chat?.unanswered_outbound ?? 0) + 1,
    });

    return { sent: true, chatId, messageId: response.message?.id };
  } catch (error) {
    return handleSendError(error, options.recipients, chatId);
  }
}

/**
 * Opens or continues a conversation without naming a line.
 *
 * No `from` is passed, which is what lets Linq reuse the recipient's existing
 * healthy line, load-balance new chats across the pool, and fail over off a flagged
 * line on its own. Pinning a line here would opt us out of all three.
 */
export async function sendToRecipients(
  recipients: readonly string[],
  parts: MessagePart[],
): Promise<SendResult> {
  const optedOut = firstOptedOutRecipient(recipients);
  if (optedOut) {
    return {
      sent: false,
      blockedBy: 'optout',
      reason: `${optedOut} has opted out — no outbound`,
    };
  }

  try {
    const response = await linq.messages.create({
      to: [...recipients],
      message: { parts, idempotency_key: randomUUID() },
    });

    const chatId = response.chat_id;
    const line = response.from ?? null;
    const isNew = response.created_new_chat === true;

    if (chatId) {
      upsertChat(chatId, {
        line,
        last_outbound_at: now(),
        first_outbound_at: now(),
        outbound_count: 1,
        unanswered_outbound: 1,
      });
    }
    recordSend(line, isNew);

    return { sent: true, chatId: chatId ?? '', messageId: response.message?.id };
  } catch (error) {
    return handleSendError(error, recipients, undefined);
  }
}

/**
 * The one message allowed through to an opted-out recipient.
 *
 * `override_optout` applies only to this request and does not lift the block. Each
 * use is recorded against the API key, so this is guarded to fire exactly once per
 * opt-out and is never placed anywhere that retries.
 */
export async function sendOptOutCourtesy(handle: string, chatId: string): Promise<SendResult> {
  const optOut = getOptOut(handle);
  if (!optOut) {
    return { sent: false, blockedBy: 'optout', reason: `${handle} is not opted out` };
  }
  if (optOut.courtesy_sent_at) {
    return {
      sent: false,
      blockedBy: 'optout',
      reason: `courtesy message already sent to ${handle}`,
    };
  }

  // Marked before the send, not after: a failure here must not leave the door open
  // for a second override on the next attempt.
  markCourtesySent(handle);

  try {
    const response = await linq.chats.messages.send(chatId, {
      override_optout: true,
      message: {
        parts: [
          {
            type: 'text',
            value:
              "You've been unsubscribed and won't get any more messages from us. Reply any time if you'd like to start again.",
          },
        ],
        idempotency_key: randomUUID(),
      },
    });
    return { sent: true, chatId, messageId: response.message?.id };
  } catch (error) {
    // Not retried. A failed courtesy message is an acceptable loss; a retry loop
    // burning overrides against the account is not.
    console.error(`[send] courtesy message to ${handle} failed`, error);
    return { sent: false, blockedBy: 'error', reason: 'courtesy send failed' };
  }
}

function handleSendError(
  error: unknown,
  recipients: readonly string[] | undefined,
  chatId: string | undefined,
): SendResult {
  if (isOptOutRejection(error)) {
    // Authoritative: the recipient opted out and Linq refused the send. Record it so
    // our own gate matches, and do not retry.
    for (const handle of recipients ?? []) {
      recordOptOut(handle, 'rejected by Linq with error 2024', chatId ?? null);
    }
    if (chatId) upsertChat(chatId, { health_status: 'OPTED_OUT', health_updated_at: now() });
    return {
      sent: false,
      blockedBy: 'optout',
      reason: 'Linq rejected the send with 2024 — recipient opted out',
    };
  }

  console.error('[send] failed', error);
  return { sent: false, blockedBy: 'error', reason: 'send failed' };
}
