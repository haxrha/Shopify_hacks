import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Webhook deduplication. Linq delivers at-least-once, so every handler is keyed
  -- on webhook-id before it does any work.
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id    TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- Recipients who asked us to stop. Linq enforces opt-out for direct messages on
  -- its side, but explicitly does NOT block group threads, so this table is the
  -- only thing standing between a stop request and the next group send.
  CREATE TABLE IF NOT EXISTS opt_outs (
    handle           TEXT PRIMARY KEY,
    opted_out_at     INTEGER NOT NULL,
    reason           TEXT NOT NULL,
    source_chat_id   TEXT,
    courtesy_sent_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS chats (
    chat_id                 TEXT PRIMARY KEY,
    is_group                INTEGER NOT NULL DEFAULT 0,
    line                    TEXT,
    health_status           TEXT NOT NULL DEFAULT 'HEALTHY',
    health_updated_at       INTEGER,
    first_outbound_at       INTEGER,
    last_outbound_at        INTEGER,
    last_inbound_at         INTEGER,
    inbound_count           INTEGER NOT NULL DEFAULT 0,
    outbound_count          INTEGER NOT NULL DEFAULT 0,
    unanswered_outbound     INTEGER NOT NULL DEFAULT 0,
    contact_card_shared_at  INTEGER,
    halted                  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS lines (
    phone_number TEXT PRIMARY KEY,
    reputation   TEXT NOT NULL DEFAULT 'HEALTHY',
    updated_at   INTEGER
  );

  -- Per-line, per-day counters backing the volume, new-conversation, and ramp limits.
  CREATE TABLE IF NOT EXISTS line_daily (
    line               TEXT NOT NULL,
    day                TEXT NOT NULL,
    message_count      INTEGER NOT NULL DEFAULT 0,
    new_conversations  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (line, day)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL,
    requested_by  TEXT NOT NULL,
    query         TEXT NOT NULL,
    store_name    TEXT,
    cart_uuid     TEXT,
    checkout_url  TEXT,
    total_cents   INTEGER,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_shares (
    id                TEXT PRIMARY KEY,
    order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    handle            TEXT NOT NULL,
    amount_cents      INTEGER NOT NULL,
    stripe_session_id TEXT,
    payment_url       TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    paid_at           INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_order_shares_order ON order_shares(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_shares_session ON order_shares(stripe_session_id);
  CREATE INDEX IF NOT EXISTS idx_orders_chat ON orders(chat_id);
`);

export type HealthStatus = 'HEALTHY' | 'AT_RISK' | 'CRITICAL' | 'OPTED_OUT';
export type Reputation = 'HEALTHY' | 'AT_RISK' | 'CRITICAL';

export interface ChatRow {
  chat_id: string;
  is_group: number;
  line: string | null;
  health_status: HealthStatus;
  health_updated_at: number | null;
  first_outbound_at: number | null;
  last_outbound_at: number | null;
  last_inbound_at: number | null;
  inbound_count: number;
  outbound_count: number;
  unanswered_outbound: number;
  contact_card_shared_at: number | null;
  halted: number;
}

export interface OptOutRow {
  handle: string;
  opted_out_at: number;
  reason: string;
  source_chat_id: string | null;
  courtesy_sent_at: number | null;
}

export const now = (): number => Date.now();

/** UTC day key, so rolling-day counters don't shift with the host timezone. */
export function dayKey(at: number = now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Records a webhook event id. Returns false if we've already handled it, which is
 * the caller's signal to ack and stop.
 */
export function claimWebhookEvent(eventId: string, source: string): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO webhook_events (event_id, source, received_at) VALUES (?, ?, ?)')
    .run(eventId, source, now());
  return result.changes > 0;
}

export function getChat(chatId: string): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as ChatRow | undefined;
}

export function upsertChat(chatId: string, patch: Partial<Omit<ChatRow, 'chat_id'>>): void {
  db.prepare('INSERT OR IGNORE INTO chats (chat_id) VALUES (?)').run(chatId);
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const assignments = entries.map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE chats SET ${assignments} WHERE chat_id = ?`).run(
    ...entries.map(([, v]) => v),
    chatId,
  );
}

export function getOptOut(handle: string): OptOutRow | undefined {
  return db.prepare('SELECT * FROM opt_outs WHERE handle = ?').get(handle) as OptOutRow | undefined;
}

export function recordOptOut(handle: string, reason: string, sourceChatId: string | null): void {
  db.prepare(
    `INSERT INTO opt_outs (handle, opted_out_at, reason, source_chat_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET opted_out_at = excluded.opted_out_at, reason = excluded.reason`,
  ).run(handle, now(), reason, sourceChatId);
}

export function markCourtesySent(handle: string): void {
  db.prepare('UPDATE opt_outs SET courtesy_sent_at = ? WHERE handle = ?').run(now(), handle);
}

/**
 * Clears an opt-out. Linq re-opts a recipient in the moment they reply again, so we
 * mirror that rather than maintaining our own opt-in state.
 */
export function clearOptOut(handle: string): void {
  db.prepare('DELETE FROM opt_outs WHERE handle = ?').run(handle);
}

export function setLineReputation(phoneNumber: string, reputation: Reputation): void {
  db.prepare(
    `INSERT INTO lines (phone_number, reputation, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone_number) DO UPDATE SET reputation = excluded.reputation, updated_at = excluded.updated_at`,
  ).run(phoneNumber, reputation, now());
}

export function getLineReputation(phoneNumber: string): Reputation | undefined {
  const row = db.prepare('SELECT reputation FROM lines WHERE phone_number = ?').get(phoneNumber) as
    | { reputation: Reputation }
    | undefined;
  return row?.reputation;
}

export function incrementLineCounters(
  line: string,
  delta: { messages?: number; newConversations?: number },
): void {
  const day = dayKey();
  db.prepare('INSERT OR IGNORE INTO line_daily (line, day) VALUES (?, ?)').run(line, day);
  db.prepare(
    `UPDATE line_daily
     SET message_count = message_count + ?, new_conversations = new_conversations + ?
     WHERE line = ? AND day = ?`,
  ).run(delta.messages ?? 0, delta.newConversations ?? 0, line, day);
}

export function getLineDaily(line: string, day: string = dayKey()): {
  message_count: number;
  new_conversations: number;
} {
  const row = db
    .prepare('SELECT message_count, new_conversations FROM line_daily WHERE line = ? AND day = ?')
    .get(line, day) as { message_count: number; new_conversations: number } | undefined;
  return row ?? { message_count: 0, new_conversations: 0 };
}

/** Mean daily message count over the preceding `days`, excluding today. */
export function getRecentDailyAverage(line: string, days = 7): number {
  const row = db
    .prepare(
      `SELECT AVG(message_count) AS avg_count FROM (
         SELECT message_count FROM line_daily
         WHERE line = ? AND day < ?
         ORDER BY day DESC LIMIT ?
       )`,
    )
    .get(line, dayKey(), days) as { avg_count: number | null } | undefined;
  return row?.avg_count ?? 0;
}
