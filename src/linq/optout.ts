/**
 * Opt-out detection.
 *
 * Two independent things live here, and conflating them is the classic bug:
 *
 * 1. `matchesOptOutKeyword` mirrors Linq's server-side rule exactly. Linq uses this
 *    same rule to set a chat to OPTED_OUT and to reject sends with 403 / code 2024.
 *    It is deliberately narrow.
 * 2. `detectsStopIntent` catches conversational stop requests ("stop texting me").
 *    Linq does NOT block these, so nothing upstream will save us — every send guard
 *    in this codebase depends on it.
 *
 * This matters more than usual here because the product is a group chat, and Linq's
 * opt-out enforcement covers direct messages only. In a group thread we are the
 * entire enforcement mechanism.
 */

/**
 * Whole-message, case-sensitive keywords, per the Chat Health guide. `STOP` counts,
 * `please stop` does not, and `stop` does not.
 */
const EXACT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'CANCEL', 'END', 'QUIT']);

/**
 * The documented exception: `OPT OUT` matches in any casing, with or without the
 * space or a hyphen.
 */
const OPT_OUT_VARIANT = /^opt[\s-]?out$/i;

/**
 * Conversational stop requests. Linq does not act on these, so we do. Kept
 * deliberately tight — a false positive silently ends a conversation, so phrases
 * requiring a clear first-person stop request are preferred over bare negativity.
 */
const STOP_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(stop|quit|cease)\s+(texting|messaging|contacting|bothering|spamming)\s+(me|us)\b/i,
  /\b(don'?t|do\s+not|never)\s+(text|message|contact|msg)\s+(me|us)\b/i,
  /\b(take|remove|delete)\s+(me|us)\s+(off|from)\b/i,
  /\bremove\s+(me|us)\b/i,
  /\b(leave|lose)\s+(me|us)\s+alone\b/i,
  /\bunsubscribe\s+(me|us)\b/i,
  /\b(no\s+more|stop\s+sending)\s+(texts?|messages?|msgs?)\b/i,
  /\bi\s+(don'?t|do\s+not)\s+want\s+(any\s+more|anymore|more|these)\b/i,
  /\b(opt|take)\s+me\s+out\b/i,
  /\bstop\s+it\b/i,
  /\bplease\s+stop\b/i,
];

export type OptOutMatch =
  | { optedOut: false }
  | { optedOut: true; kind: 'keyword'; reason: string }
  | { optedOut: true; kind: 'intent'; reason: string };

/**
 * True when the message is an opt-out keyword by Linq's exact rule.
 *
 * Also used to decide re-opt-in: any inbound that is NOT a keyword clears the
 * opt-out, matching Linq's own behavior.
 */
export function matchesOptOutKeyword(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return EXACT_KEYWORDS.has(trimmed) || OPT_OUT_VARIANT.test(trimmed);
}

/** True when the message reads as a clear request to stop, short of a keyword. */
export function detectsStopIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return STOP_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function classifyInbound(text: string): OptOutMatch {
  if (matchesOptOutKeyword(text)) {
    return { optedOut: true, kind: 'keyword', reason: `opt-out keyword: ${text.trim()}` };
  }
  if (detectsStopIntent(text)) {
    return { optedOut: true, kind: 'intent', reason: `stop intent: ${text.trim().slice(0, 120)}` };
  }
  return { optedOut: false };
}

/** Concatenates the text parts of an inbound message into one string for matching. */
export function textFromParts(
  parts: ReadonlyArray<{ type?: string; value?: string | null }> | undefined,
): string {
  if (!parts) return '';
  return parts
    .filter((part) => part.type === 'text' && typeof part.value === 'string')
    .map((part) => part.value as string)
    .join(' ')
    .trim();
}
