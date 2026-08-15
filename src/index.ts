import express from 'express';
import { config } from './config.ts';
import { linq } from './linq/client.ts';
import { claimWebhookEvent } from './db.ts';
import { refreshLineReputations } from './linq/health.ts';
import { handleLinqEvent } from './webhooks/linq.ts';
import { handleStripeEvent } from './webhooks/stripe.ts';
import { stripe } from './split/stripe.ts';
import { isAuthenticated } from './doordash/ddcli.ts';

const app = express();

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

/**
 * Linq inbound webhook.
 *
 * The raw body is required: `unwrap` verifies the Standard Webhooks signature over
 * the exact bytes, and parsing then re-serializing would change them.
 */
app.post('/webhooks/linq', express.raw({ type: '*/*' }), async (request, response) => {
  let event: { type?: string; event?: string; data?: unknown };
  try {
    event = linq.webhooks.unwrap(request.body.toString('utf8'), {
      headers: request.headers as Record<string, string>,
    }) as typeof event;
  } catch (error) {
    console.warn('[linq] rejected webhook with an invalid signature', error);
    response.status(400).send('invalid signature');
    return;
  }

  const eventId = request.headers['webhook-id'];
  if (typeof eventId === 'string' && !claimWebhookEvent(eventId, 'linq')) {
    // Delivery is at-least-once, so a duplicate is expected, not an error.
    response.status(200).send('duplicate');
    return;
  }

  // Ack before processing. Linq times out at 10s and retries on 5xx, and an order
  // round-trip through dd-cli can take longer than that.
  response.status(200).send('ok');

  const eventType = event.type ?? event.event ?? '';
  try {
    await handleLinqEvent(eventType, event.data ?? event);
  } catch (error) {
    console.error(`[linq] handler failed for ${eventType}`, error);
  }
});

app.post('/webhooks/stripe', express.raw({ type: '*/*' }), async (request, response) => {
  const signature = request.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    response.status(400).send('missing signature');
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, signature, config.stripe.webhookSecret);
  } catch (error) {
    console.warn('[stripe] rejected webhook with an invalid signature', error);
    response.status(400).send('invalid signature');
    return;
  }

  if (!claimWebhookEvent(event.id, 'stripe')) {
    response.status(200).send('duplicate');
    return;
  }

  response.status(200).send('ok');

  try {
    await handleStripeEvent(event);
  } catch (error) {
    console.error(`[stripe] handler failed for ${event.type}`, error);
  }
});

app.get('/split/thanks', (_request, response) => {
  response.type('html').send('<h1>Thanks — you&rsquo;re settled up.</h1><p>You can close this tab.</p>');
});

app.get('/split/canceled', (_request, response) => {
  response.type('html').send('<h1>Payment canceled</h1><p>No charge was made.</p>');
});

async function start(): Promise<void> {
  try {
    await refreshLineReputations();
    console.log('[startup] line reputations loaded');
  } catch (error) {
    console.warn('[startup] could not load line reputations', error);
  }

  if (!(await isAuthenticated())) {
    console.warn('[startup] dd-cli is not signed in — ordering will fail until `dd-cli login` is run');
  }

  app.listen(config.port, () => {
    console.log(`[startup] listening on :${config.port}`);
    console.log(`[startup] Linq webhook   → ${config.publicBaseUrl}/webhooks/linq`);
    console.log(`[startup] Stripe webhook → ${config.publicBaseUrl}/webhooks/stripe`);
  });
}

void start();
