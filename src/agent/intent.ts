/**
 * Group-chat intent parsing.
 *
 * A group chat is full of messages that aren't for the agent, and every false
 * positive here spends someone's money and burns a reply into a thread that Linq is
 * scoring for engagement. So an order needs an explicit trigger — a verb or an
 * address to the bot — rather than any message that happens to name a food.
 */

export type Intent =
  | { kind: 'order'; query: string; quantity: number }
  | { kind: 'split' }
  | { kind: 'cancel' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'none' };

const BOT_PREFIX = /^\s*(?:\/|@?(?:chow|bot|agent)\b[:,]?\s*)/i;
const ORDER_VERB = /^\s*(?:order|get|grab|buy|deliver|i\s+want|can\s+i\s+get|lemme\s+get)\b/i;

const LEADING_QUANTITY = /^\s*(\d{1,2})\s*x?\s+/i;
const FILLER = /^\s*(?:me|us|some|a|an|the)\s+/i;

function parseQuantity(text: string): { quantity: number; rest: string } {
  const stripped = text.replace(FILLER, '');
  const match = LEADING_QUANTITY.exec(stripped);
  if (!match?.[1]) return { quantity: 1, rest: stripped.trim() };

  const quantity = Number(match[1]);
  const rest = stripped.slice(match[0].length).trim();
  // Guard against a runaway order from a typo like "50 burritos".
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 10) {
    return { quantity: 1, rest };
  }
  return { quantity, rest };
}

export function parseIntent(rawText: string): Intent {
  const text = rawText.trim();
  if (text.length === 0) return { kind: 'none' };

  const addressed = BOT_PREFIX.test(text);
  const body = addressed ? text.replace(BOT_PREFIX, '').trim() : text;

  if (/^(help|commands|what can you do)\b/i.test(body)) return { kind: 'help' };
  if (/^(split|splitwise|split the bill|venmo)\b/i.test(body)) return { kind: 'split' };
  if (/^(cancel|nevermind|never mind|stop the order)\b/i.test(body)) return { kind: 'cancel' };
  if (/^(status|where('?s| is) (my|the) (order|food))\b/i.test(body)) return { kind: 'status' };

  const verbMatch = ORDER_VERB.exec(body);
  if (verbMatch) {
    const { quantity, rest } = parseQuantity(body.slice(verbMatch[0].length));
    if (rest.length > 0) return { kind: 'order', query: rest, quantity };
    return { kind: 'help' };
  }

  // A bare food item counts only when the message is addressed to the bot, so
  // ordinary group chatter can't trigger a purchase.
  if (addressed && body.length > 0) {
    const { quantity, rest } = parseQuantity(body);
    if (rest.length > 0) return { kind: 'order', query: rest, quantity };
  }

  return { kind: 'none' };
}
