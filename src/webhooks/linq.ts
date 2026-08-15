import { randomUUID } from 'node:crypto';
import { linq, text, type MessagePart } from '../linq/client.ts';
import { classifyInbound, matchesOptOutKeyword, textFromParts } from '../linq/optout.ts';
import { cacheChatHealth, cacheLineReputation } from '../linq/health.ts';
import { sendOptOutCourtesy, sendToChat } from '../linq/send.ts';
import { maybeShareContactCard } from '../linq/contactCard.ts';
import { recordInbound } from '../linq/volume.ts';
import { parseIntent } from '../agent/intent.ts';
import { buildOrderDraft } from '../doordash/order.ts';
import { DdCliAuthError } from '../doordash/ddcli.ts';
import { createSplitCharges, formatCents, outstandingShares } from '../split/stripe.ts';
import {
  clearOptOut,
  db,
  getChat,
  getOptOut,
  now,
  recordOptOut,
  upsertChat,
  type HealthStatus,
  type Reputation,
} from '../db.ts';

/**
 * Inbound Linq event handling.
 *
 * Ordering inside `handleMessageReceived` is deliberate: opt-out classification runs
 * before any intent parsing or reply, so a "stop texting me" can never be answered
 * with a menu.
 */

interface InboundMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  parts?: unknown[];
  sender_handle?: { handle?: string };
  reconciled_at?: string;
  chat: {
    id: string;
    is_group?: boolean | null;
    owner_handle?: { handle?: string } | null;
    health_status?: { status?: string };
  };
}

export async function handleLinqEvent(eventType: string, data: unknown): Promise<void> {
  switch (eventType) {
    case 'message.received':
      await handleMessageReceived(data as InboundMessage);
      return;
    case 'phone_number.status_updated':
      handlePhoneNumberStatusUpdated(data);
      return;
    default:
      // Chat and message lifecycle events still carry health, which is worth caching.
      cacheHealthFromEvent(data);
  }
}

function cacheHealthFromEvent(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const chat = (data as { chat?: { id?: string; health_status?: { status?: string } } }).chat;
  if (chat?.id && chat.health_status?.status) {
    cacheChatHealth(chat.id, chat.health_status.status as HealthStatus);
  }
}

/**
 * Reacts to a line's reputation changing, so gating uses current data rather than
 * whatever was cached at startup.
 */
function handlePhoneNumberStatusUpdated(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const payload = data as {
    phone_number?: string;
    reputation?: { status?: string };
    status?: string;
  };
  const number = payload.phone_number;
  const status = payload.reputation?.status ?? payload.status;
  if (!number || !status) return;

  cacheLineReputation(number, status as Reputation);
  console.log(`[linq] line ${number} reputation is now ${status}`);
}

async function handleMessageReceived(message: InboundMessage): Promise<void> {
  if (message.direction !== 'inbound') return;

  // Reconciled messages arrive late and out of order. They're genuine history, not a
  // live inbound, so they must not trigger a reply.
  if (message.reconciled_at) {
    console.log(`[linq] skipping reconciled message ${message.id}`);
    return;
  }

  const chatId = message.chat.id;
  const isGroup = message.chat.is_group === true;
  const sender = message.sender_handle?.handle;
  const body = textFromParts(message.parts as { type?: string; value?: string | null }[]);

  if (message.chat.health_status?.status) {
    cacheChatHealth(chatId, message.chat.health_status.status as HealthStatus);
  }

  const existing = getChat(chatId);
  upsertChat(chatId, {
    is_group: isGroup ? 1 : 0,
    line: message.chat.owner_handle?.handle ?? existing?.line ?? null,
    last_inbound_at: now(),
    inbound_count: (existing?.inbound_count ?? 0) + 1,
    // A reply resets the back-off ladder and un-halts the conversation.
    unanswered_outbound: 0,
    halted: 0,
  });
  recordInbound(message.chat.owner_handle?.handle ?? existing?.line ?? null);

  if (!sender) return;

  const classification = classifyInbound(body);
  if (classification.optedOut) {
    await handleOptOut(chatId, sender, isGroup, classification.reason);
    return;
  }

  // Any inbound that isn't an opt-out keyword opts the sender back in. This mirrors
  // Linq clearing the status, rather than tracking opt-ins ourselves.
  if (!matchesOptOutKeyword(body) && getOptOut(sender)) {
    clearOptOut(sender);
    console.log(`[linq] ${sender} replied — opt-out cleared`);
  }

  await routeIntent(chatId, sender, body, isGroup);

  // Sharing is safe here: an outbound already exists in this chat by now, and the
  // helper enforces the once-a-day cap itself.
  await maybeShareContactCard(chatId);
}

/**
 * Stops all outbound to a recipient.
 *
 * Linq blocks opted-out recipients on direct messages across every line, but group
 * threads are explicitly never blocked. So in a group the only way to actually stop
 * reaching someone is to take them out of the thread — or, when the group is too
 * small for that, to stop the agent in that thread entirely.
 */
async function handleOptOut(
  chatId: string,
  handle: string,
  isGroup: boolean,
  reason: string,
): Promise<void> {
  recordOptOut(handle, reason, chatId);
  console.log(`[linq] opt-out recorded for ${handle} (${reason})`);

  if (!isGroup) {
    await sendOptOutCourtesy(handle, chatId);
    return;
  }

  try {
    await linq.chats.participants.remove(chatId, { handle });
    console.log(`[linq] removed ${handle} from group ${chatId} after opt-out`);
  } catch (error) {
    // Groups must keep at least three members, so removal can legitimately fail.
    // Halting the agent is the only remaining way to honor the request.
    upsertChat(chatId, { halted: 1 });
    console.warn(
      `[linq] could not remove ${handle} from group ${chatId} — halting the chat instead`,
      error,
    );
  }
}

async function routeIntent(
  chatId: string,
  sender: string,
  body: string,
  isGroup: boolean,
): Promise<void> {
  const intent = parseIntent(body);

  switch (intent.kind) {
    case 'none':
      return;
    case 'help':
      await reply(chatId, sender, [
        text(
          'Tell me what you want and I\'ll build a DoorDash cart: try "order pad thai". Say "split" and I\'ll send everyone their share, or "status" to see what\'s outstanding.',
        ),
      ]);
      return;
    case 'status':
      await handleStatus(chatId, sender);
      return;
    case 'cancel':
      db.prepare("UPDATE orders SET status = 'canceled' WHERE chat_id = ? AND status = 'draft'").run(
        chatId,
      );
      await reply(chatId, sender, [text("Cancelled — nothing was charged. Want anything else?")]);
      return;
    case 'split':
      await handleSplit(chatId, sender, isGroup);
      return;
    case 'order':
      await handleOrder(chatId, sender, intent.query, intent.quantity);
      return;
  }
}

async function handleOrder(
  chatId: string,
  sender: string,
  query: string,
  quantity: number,
): Promise<void> {
  try {
    const draft = await buildOrderDraft(query, quantity);
    const orderId = randomUUID();

    db.prepare(
      `INSERT INTO orders (id, chat_id, requested_by, query, store_name, cart_uuid, checkout_url, total_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    ).run(
      orderId,
      chatId,
      sender,
      query,
      draft.store.name,
      draft.cartUuid,
      draft.checkoutUrl,
      draft.totalCents ?? null,
      now(),
    );

    const price = draft.totalCents !== undefined ? ` — ${formatCents(draft.totalCents)}` : '';
    const quantityLabel = quantity > 1 ? `${quantity}x ` : '';

    // One message, with the URL inline. A `link` part would render a rich preview but
    // has to be the only part in its message, which would cost a second outbound and
    // push the inbound:outbound ratio the wrong way.
    await reply(chatId, sender, [
      text(
        `Got a cart ready at ${draft.store.name}: ${quantityLabel}${draft.item.name}${price}.\n\nTap to review and pay: ${draft.checkoutUrl}\n\nOnce it's placed, say "split" and I'll send everyone their share.`,
      ),
    ]);
  } catch (error) {
    if (error instanceof DdCliAuthError) {
      console.error('[order] dd-cli is not signed in');
      await reply(chatId, sender, [
        text("I can't reach DoorDash right now — my end needs a re-login. Try again shortly?"),
      ]);
      return;
    }
    const detail = error instanceof Error ? error.message : 'something went wrong';
    await reply(chatId, sender, [text(`I couldn't build that order: ${detail}. Want to try a different dish?`)]);
  }
}

async function handleSplit(chatId: string, sender: string, isGroup: boolean): Promise<void> {
  const order = db
    .prepare("SELECT * FROM orders WHERE chat_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1")
    .get(chatId) as { id: string; store_name: string | null; total_cents: number | null } | undefined;

  if (!order) {
    await reply(chatId, sender, [text("I don't have a recent order for this chat. Want to order something?")]);
    return;
  }
  if (!order.total_cents) {
    await reply(chatId, sender, [
      text("I don't have a total for that order yet — check out first and I'll split it."),
    ]);
    return;
  }

  const participants = await activeParticipants(chatId, isGroup);
  if (participants.length === 0) {
    await reply(chatId, sender, [text("I couldn't work out who's in this chat to split with.")]);
    return;
  }

  const shares = await createSplitCharges(
    order.id,
    order.store_name ?? 'DoorDash',
    order.total_cents,
    participants,
  );

  const perPerson = shares[0]?.amountCents ?? 0;
  await reply(chatId, sender, [
    text(
      `Splitting ${formatCents(order.total_cents)} across ${shares.length} — about ${formatCents(perPerson)} each. Sending everyone their link now.`,
    ),
  ]);

  // Each person's link goes to them directly. `sendToRecipients` runs the opt-out
  // gate per handle, so anyone who opted out is skipped rather than billed.
  const { sendToRecipients } = await import('../linq/send.ts');
  for (const share of shares) {
    if (!share.paymentUrl) continue;
    await sendToRecipients(
      [share.handle],
      [text(`Your share of ${order.store_name ?? 'the order'}: ${formatCents(share.amountCents)}\n${share.paymentUrl}`)],
    );
  }
}

async function handleStatus(chatId: string, sender: string): Promise<void> {
  const order = db
    .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(chatId) as { id: string; store_name: string | null; status: string } | undefined;

  if (!order) {
    await reply(chatId, sender, [text("No orders here yet. Hungry?")]);
    return;
  }

  const outstanding = outstandingShares(order.id);
  if (outstanding.length === 0) {
    await reply(chatId, sender, [text(`Everyone's settled up for ${order.store_name ?? 'that order'}.`)]);
    return;
  }

  const total = outstanding.reduce((sum, share) => sum + share.amount_cents, 0);
  await reply(chatId, sender, [
    text(`Still waiting on ${outstanding.length} ${outstanding.length === 1 ? 'person' : 'people'} — ${formatCents(total)} outstanding.`),
  ]);
}

/** Chat participants, excluding our own line and anyone who has opted out. */
async function activeParticipants(chatId: string, isGroup: boolean): Promise<string[]> {
  if (!isGroup) return [];
  const chat = await linq.chats.retrieve(chatId);
  return (chat.handles ?? [])
    .filter((participant) => participant.is_me !== true && !participant.left_at)
    .map((participant) => participant.handle)
    .filter((handle): handle is string => typeof handle === 'string')
    .filter((handle) => getOptOut(handle) === undefined);
}

/**
 * Replies to an inbound. Marked `isReplyToInbound` so the cadence back-off doesn't
 * suppress it — backing off applies to us initiating, not to answering someone.
 */
async function reply(chatId: string, sender: string, parts: MessagePart[]): Promise<void> {
  const result = await sendToChat(chatId, parts, {
    recipients: [sender],
    isReplyToInbound: true,
  });
  if (!result.sent) {
    console.warn(`[linq] reply to ${chatId} blocked by ${result.blockedBy}: ${result.reason}`);
  }
}
