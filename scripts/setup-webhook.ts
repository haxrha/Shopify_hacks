/**
 * Registers this service's inbound webhook with Linq.
 *
 * Run once per environment:  npm run setup:webhook
 *
 * The payload version is pinned in the URL. Without it the subscription silently
 * takes whatever version is latest at creation time, and the handler in
 * src/webhooks/linq.ts reads the v2 shape specifically.
 */
import { config } from '../src/config.ts';
import { linq } from '../src/linq/client.ts';

const EVENTS = [
  'message.received',
  'phone_number.status_updated',
  'chat.created',
  'participant.added',
  'participant.removed',
] as const;

async function main(): Promise<void> {
  const url = `${config.publicBaseUrl}/webhooks/linq?version=${config.linq.webhookVersion}`;

  const existing = await linq.webhookSubscriptions.list().catch(() => null);
  const duplicate = existing?.subscriptions.find(
    (subscription) => subscription.target_url === url,
  );

  if (duplicate) {
    console.log(`Subscription already exists for ${url} (id ${duplicate.id})`);
    return;
  }

  const created = await linq.webhookSubscriptions.create({
    target_url: url,
    subscribed_events: [...EVENTS],
  });

  console.log(`Created webhook subscription for ${url}`);
  console.log(JSON.stringify(created, null, 2));
  console.log(
    '\nCopy the signing secret above into LINQ_WEBHOOK_SECRET — signature verification fails without it.',
  );
}

main().catch((error: unknown) => {
  console.error('Failed to create the webhook subscription:', error);
  process.exit(1);
});
