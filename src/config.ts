import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

export const config = {
  port: num('PORT', 3000),

  linq: {
    apiKey: required('LINQ_API_KEY'),
    webhookSecret: required('LINQ_WEBHOOK_SECRET'),
    /**
     * Pinned so payload shape can't shift under us. The v2 message payload is what
     * `src/webhooks/linq.ts` reads: `direction`, `sender_handle`, `chat.health_status`.
     */
    webhookVersion: optional('LINQ_WEBHOOK_VERSION', '2026-02-03'),
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  },

  ddCli: {
    binary: optional('DD_CLI_BINARY', 'dd-cli'),
    /**
     * dd-cli reads this itself. We pass it through explicitly so the subprocess works
     * in headless deploys where there is no OS keychain.
     */
    accessToken: process.env.DD_CLI_ACCESS_TOKEN,
    timeoutMs: num('DD_CLI_TIMEOUT_MS', 60_000),
  },

  /** Public base URL of this service, used to build Stripe return URLs. */
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000'),

  databasePath: optional('DATABASE_PATH', 'data/app.sqlite'),

  /**
   * Deliverability limits from Linq's Best Practices and Phone Reputation guides.
   * These are the thresholds the send pipeline enforces before anything leaves.
   */
  limits: {
    /** Messages per line per rolling day, inbound + outbound. Guideline is ~7,000. */
    messagesPerLinePerDay: num('LIMIT_MESSAGES_PER_LINE_PER_DAY', 7_000),
    /** Brand-new conversations opened per line in a rolling 24h. Guideline is <50. */
    newConversationsPerLinePerDay: num('LIMIT_NEW_CONVERSATIONS_PER_LINE_PER_DAY', 40),
    /**
     * A line's daily volume may not exceed this multiple of its recent daily average.
     * Prevents a quiet line jumping several-fold in one day.
     */
    rampMultiplier: num('LIMIT_RAMP_MULTIPLIER', 2),
    /** Floor below which ramp limiting doesn't apply, so a brand-new line can start. */
    rampFloor: num('LIMIT_RAMP_FLOOR', 50),
    /** Re-share the contact card at most this often per chat. */
    contactCardReshareHours: num('CONTACT_CARD_RESHARE_HOURS', 24),
  },

  /**
   * Cadence back-off ladder from the Chat Health guide: after no reply, wait a day,
   * send one follow-up, wait a few days, send one more, then a final opt-out offer,
   * then halt entirely.
   */
  cadence: {
    maxUnansweredOutbound: num('CADENCE_MAX_UNANSWERED_OUTBOUND', 3),
    firstFollowUpHours: num('CADENCE_FIRST_FOLLOWUP_HOURS', 24),
    secondFollowUpHours: num('CADENCE_SECOND_FOLLOWUP_HOURS', 72),
  },
} as const;

export type Config = typeof config;
