import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../config.ts';
import { db, now } from '../db.ts';

/**
 * Stripe is optional. Ordering works without it; only bill splitting needs it, so
 * the client is built lazily and callers check `isStripeConfigured` first rather
 * than the whole app failing to boot over an unset key.
 */
let client: Stripe | undefined;

export function isStripeConfigured(): boolean {
  return config.stripe !== undefined;
}

export function getStripe(): Stripe {
  if (!config.stripe) {
    throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  }
  client ??= new Stripe(config.stripe.secretKey, { apiVersion: '2026-07-29.dahlia' });
  return client;
}

export interface Share {
  id: string;
  handle: string;
  amountCents: number;
  paymentUrl: string;
}

export interface ShareRow {
  id: string;
  order_id: string;
  handle: string;
  amount_cents: number;
  stripe_session_id: string | null;
  payment_url: string | null;
  status: string;
  paid_at: number | null;
}

/**
 * Splits an amount into whole cents across n people.
 *
 * The remainder is distributed one cent at a time rather than rounded, so the shares
 * always sum to exactly the total and nobody is silently short-changed.
 */
export function splitEvenly(totalCents: number, people: number): number[] {
  if (people <= 0) return [];
  const base = Math.floor(totalCents / people);
  const remainder = totalCents % people;
  return Array.from({ length: people }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Creates one Stripe Checkout session per participant for their share of an order.
 *
 * Each participant gets their own URL — a single shared link would let one person
 * pay twice and leave another unbilled.
 */
export async function createSplitCharges(
  orderId: string,
  storeName: string,
  totalCents: number,
  participants: readonly string[],
): Promise<Share[]> {
  const amounts = splitEvenly(totalCents, participants.length);
  const shares: Share[] = [];

  for (const [index, handle] of participants.entries()) {
    const amountCents = amounts[index] ?? 0;
    if (amountCents <= 0) continue;

    const shareId = randomUUID();
    const session = await getStripe().checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: amountCents,
              product_data: { name: `Your share — ${storeName}` },
            },
          },
        ],
        success_url: `${config.publicBaseUrl}/split/thanks?share=${shareId}`,
        cancel_url: `${config.publicBaseUrl}/split/canceled?share=${shareId}`,
        metadata: { share_id: shareId, order_id: orderId, handle },
      },
      // Retrying this call must not create a second session for the same person.
      { idempotencyKey: `share:${shareId}` },
    );

    db.prepare(
      `INSERT INTO order_shares (id, order_id, handle, amount_cents, stripe_session_id, payment_url, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(shareId, orderId, handle, amountCents, session.id, session.url);

    shares.push({ id: shareId, handle, amountCents, paymentUrl: session.url ?? '' });
  }

  return shares;
}

export function markSharedPaid(sessionId: string): ShareRow | undefined {
  const share = db
    .prepare('SELECT * FROM order_shares WHERE stripe_session_id = ?')
    .get(sessionId) as ShareRow | undefined;
  if (!share || share.status === 'paid') return share;

  db.prepare("UPDATE order_shares SET status = 'paid', paid_at = ? WHERE id = ?").run(
    now(),
    share.id,
  );
  return { ...share, status: 'paid', paid_at: now() };
}

export function getShares(orderId: string): ShareRow[] {
  return db.prepare('SELECT * FROM order_shares WHERE order_id = ?').all(orderId) as ShareRow[];
}

export function outstandingShares(orderId: string): ShareRow[] {
  return getShares(orderId).filter((share) => share.status !== 'paid');
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
