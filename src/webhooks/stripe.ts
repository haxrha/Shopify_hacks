import type Stripe from 'stripe';
import { text } from '../linq/client.ts';
import { sendToChat } from '../linq/send.ts';
import { db } from '../db.ts';
import { formatCents, markSharedPaid, outstandingShares } from '../split/stripe.ts';

/**
 * Stripe event handling.
 *
 * Payment state is only ever advanced from a verified webhook, never from the
 * browser hitting the success URL — a user can navigate to that page without paying.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  if (event.type !== 'checkout.session.completed') return;

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== 'paid') return;

  const share = markSharedPaid(session.id);
  if (!share) {
    console.warn(`[stripe] no share matches session ${session.id}`);
    return;
  }

  const order = db
    .prepare('SELECT chat_id, store_name FROM orders WHERE id = ?')
    .get(share.order_id) as { chat_id: string; store_name: string | null } | undefined;
  if (!order) return;

  const remaining = outstandingShares(share.order_id);
  if (remaining.length > 0) {
    console.log(`[stripe] ${share.handle} paid; ${remaining.length} share(s) outstanding`);
    return;
  }

  // Only announce once everyone has settled, rather than one message per payment —
  // a group thread doesn't need a running commentary, and each send counts against
  // the chat's inbound:outbound ratio.
  await sendToChat(
    order.chat_id,
    [
      text(
        `Everyone's paid up for ${order.store_name ?? 'the order'} — thanks! ${formatCents(
          totalFor(share.order_id),
        )} settled.`,
      ),
    ],
    { isReplyToInbound: true },
  );
}

function totalFor(orderId: string): number {
  const row = db
    .prepare('SELECT SUM(amount_cents) AS total FROM order_shares WHERE order_id = ?')
    .get(orderId) as { total: number | null } | undefined;
  return row?.total ?? 0;
}
