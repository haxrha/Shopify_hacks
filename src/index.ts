import express from 'express';
import { config } from './config.ts';
import { linq } from './linq/client.ts';
import { claimWebhookEvent } from './db.ts';
import { refreshLineReputations } from './linq/health.ts';
import { handleLinqEvent } from './webhooks/linq.ts';
import { handleStripeEvent } from './webhooks/stripe.ts';
import { getStripe, isStripeConfigured } from './split/stripe.ts';
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
  const rawBody = request.body.toString('utf8');
  // `event_type` and `event_id` are what the 2026-02-03 envelope actually uses; the
  // others are kept only so an older payload shape still routes somewhere.
  let event: {
    event_type?: string;
    event_id?: string;
    type?: string;
    event?: string;
    data?: unknown;
  };

  if (config.linq.webhookSecret) {
    try {
      event = linq.webhooks.unwrap(rawBody, {
        headers: request.headers as Record<string, string>,
      }) as typeof event;
    } catch (error) {
      console.warn('[linq] rejected webhook with an invalid signature', error);
      response.status(400).send('invalid signature');
      return;
    }
  } else {
    // Unverified path for `linq webhooks listen --forward-to`, which relays events
    // from localhost and may not carry signature headers. Only safe because the
    // listener is the sole thing that can reach this port.
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      response.status(400).send('invalid json');
      return;
    }
  }

  const eventId = event.event_id ?? request.headers['webhook-id'];
  if (typeof eventId === 'string' && !claimWebhookEvent(eventId, 'linq')) {
    // Delivery is at-least-once, so a duplicate is expected, not an error.
    response.status(200).send('duplicate');
    return;
  }

  // Ack before processing. Linq times out at 10s and retries on 5xx, and an order
  // round-trip through dd-cli can take longer than that.
  response.status(200).send('ok');

  const eventType = event.event_type ?? event.type ?? event.event ?? '';

  // Logged on every inbound: an unrecognised event type is otherwise indistinguishable
  // from no delivery at all, which hid a routing bug behind a silently healthy server.
  if (!eventType) {
    console.warn(`[linq] event with no recognisable type; keys: ${Object.keys(event).join(', ')}`);
  } else {
    console.log(`[linq] ${eventType}`);
  }

  try {
    await handleLinqEvent(eventType, event.data ?? event);
  } catch (error) {
    console.error(`[linq] handler failed for ${eventType}`, error);
  }
});

app.post('/webhooks/stripe', express.raw({ type: '*/*' }), async (request, response) => {
  const stripeConfig = config.stripe;
  if (!stripeConfig) {
    response.status(503).send('stripe not configured');
    return;
  }

  const signature = request.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    response.status(400).send('missing signature');
    return;
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(request.body, signature, stripeConfig.webhookSecret);
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

  if (!config.linq.webhookSecret) {
    console.warn(
      '[startup] LINQ_WEBHOOK_SECRET is unset — inbound webhooks are NOT signature-verified.\n' +
        '          Fine for `linq webhooks listen --forward-to` on localhost. Do not expose this port.',
    );
  }
  if (!isStripeConfigured()) {
    console.warn('[startup] Stripe is not configured — bill splitting is disabled');
  }

  app.listen(config.port, () => {
    console.log(`[startup] listening on :${config.port}`);
    console.log(`[startup] forward events with:`);
    console.log(`          linq webhooks listen --forward-to http://localhost:${config.port}/webhooks/linq`);
  });
}

void start();
