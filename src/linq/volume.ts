import { config } from '../config.ts';
import {
  getChat,
  getLineDaily,
  getRecentDailyAverage,
  incrementLineCounters,
  now,
} from '../db.ts';

/**
 * Volume, ramp, and cadence limits.
 *
 * These are deliberately enforced in the send path rather than at the campaign
 * layer, so there is no code path that can bypass them — including anything that
 * tries to open a whole audience at once.
 */

export type VolumeGate = { allowed: true } | { allowed: false; reason: string };

export function gateOnVolume(line: string | null, isNewConversation: boolean): VolumeGate {
  if (!line) return { allowed: true };

  const today = getLineDaily(line);
  const { messagesPerLinePerDay, newConversationsPerLinePerDay, rampMultiplier, rampFloor } =
    config.limits;

  if (today.message_count >= messagesPerLinePerDay) {
    return {
      allowed: false,
      reason: `line ${line} hit the daily message cap (${messagesPerLinePerDay})`,
    };
  }

  if (isNewConversation && today.new_conversations >= newConversationsPerLinePerDay) {
    return {
      allowed: false,
      reason: `line ${line} hit the daily new-conversation cap (${newConversationsPerLinePerDay}) — first contact must spread across days and lines`,
    };
  }

  // Ramp: don't let a quiet line jump several-fold in a single day. The floor lets a
  // brand-new line start from nothing without tripping the multiplier.
  const recentAverage = getRecentDailyAverage(line);
  const rampCeiling = Math.max(rampFloor, Math.ceil(recentAverage * rampMultiplier));
  if (today.message_count >= rampCeiling) {
    return {
      allowed: false,
      reason: `line ${line} would exceed its ramp ceiling (${rampCeiling}/day, recent average ${recentAverage.toFixed(1)})`,
    };
  }

  return { allowed: true };
}

export function recordSend(line: string | null, isNewConversation: boolean): void {
  if (!line) return;
  incrementLineCounters(line, {
    messages: 1,
    newConversations: isNewConversation ? 1 : 0,
  });
}

/** Inbound counts toward the line's daily total too. */
export function recordInbound(line: string | null): void {
  if (!line) return;
  incrementLineCounters(line, { messages: 1 });
}

/**
 * Back-off ladder from the Chat Health guide. After an unanswered outbound, wait a
 * day before one follow-up, a few days before one more, then halt entirely rather
 * than keep messaging someone who isn't replying.
 */
export function gateOnCadence(chatId: string): VolumeGate {
  const chat = getChat(chatId);
  if (!chat) return { allowed: true };
  if (chat.halted) return { allowed: false, reason: 'chat is halted — awaiting a reply' };

  const unanswered = chat.unanswered_outbound;
  if (unanswered === 0) return { allowed: true };

  const { maxUnansweredOutbound, firstFollowUpHours, secondFollowUpHours } = config.cadence;
  if (unanswered >= maxUnansweredOutbound) {
    return {
      allowed: false,
      reason: `${unanswered} unanswered outbound messages — halted until they reply`,
    };
  }

  const lastOutbound = chat.last_outbound_at;
  if (!lastOutbound) return { allowed: true };

  const requiredHours = unanswered === 1 ? firstFollowUpHours : secondFollowUpHours;
  const elapsedHours = (now() - lastOutbound) / 3_600_000;
  if (elapsedHours < requiredHours) {
    return {
      allowed: false,
      reason: `backing off — ${elapsedHours.toFixed(1)}h since last unanswered send, need ${requiredHours}h`,
    };
  }

  return { allowed: true };
}

/**
 * A reply resets the ladder. This is what "let replies set your pace" means in
 * practice: engagement is the only thing that reopens the cadence.
 */
export function isReplyExpected(chatId: string): boolean {
  const chat = getChat(chatId);
  return (chat?.unanswered_outbound ?? 0) > 0;
}
