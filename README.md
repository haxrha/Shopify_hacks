# shopify_hack
Try out web app:https://one-meal-path.base44.app/
A group-chat food ordering agent. Someone texts an iMessage group thread, the agent
builds a DoorDash cart and posts a checkout link, and Stripe collects each person's
share afterwards.

- **Linq Partner API v3** — iMessage/RCS/SMS transport and inbound webhooks
- **DoorDash CLI (`dd-cli`)** — restaurant search, cart building, checkout URLs
- **Stripe Checkout** — one payment link per person for their share

```
group chat  ──▶  Linq webhook  ──▶  intent parsing  ──▶  dd-cli  ──▶  checkout URL
                                          │                              │
                                          └──────▶  Stripe split  ◀──────┘
```

## The agent never spends money

It builds a cart and hands back a DoorDash checkout URL. A human opens that link and
pays. Nothing in this codebase completes a purchase, which is deliberate: a group
thread is a shared surface, and anyone in it can type.

Two more guardrails follow from that:

- An order needs an explicit trigger — a verb (`order pad thai`) or a message
  addressed to the bot (`/sushi`, `@chow sushi`). A bare food item mentioned in
  passing does nothing. See `src/agent/intent.ts`.
- Quantities above 10 are clamped to 1, so a typo can't order fifty burritos.

## Setup

### 1. Install and sign in to dd-cli

```bash
bash ~/Downloads/dd-cli-v0.2.2-darwin-arm64/install.sh
dd-cli login
```

Every dd-cli subcommand is gated behind sign-in, including `--help`. For a headless
deploy, run `dd-cli export-token` on a desktop machine and set `DD_CLI_ACCESS_TOKEN`.

### 2. Configure

```bash
cp .env.example .env
npm install
```

Fill in `LINQ_API_KEY`, `STRIPE_SECRET_KEY`, and `PUBLIC_BASE_URL`.

### 3. Expose the service and register webhooks

Linq requires an HTTPS target, so a tunnel is needed for local work:

```bash
ngrok http 3000               # copy the https URL into PUBLIC_BASE_URL
npm run setup:webhook         # prints the signing secret → LINQ_WEBHOOK_SECRET
npm run setup:line            # creates the contact card on every line
stripe listen --forward-to localhost:3000/webhooks/stripe
```

### 4. Run

```bash
npm run dev
```

Then add the Linq line to an iMessage group and text it `order pad thai`.

## Commands in chat

| Message | What happens |
| --- | --- |
| `order pad thai`, `/sushi`, `@chow 2 burritos` | Builds a cart, replies with a checkout link |
| `split` | Creates a Stripe payment link per participant and DMs each one |
| `status` | Reports who still owes |
| `cancel` | Drops the current draft order |
| `STOP` | Opts the sender out — see below |

## Deliverability and compliance

The service is built against Linq's Best Practices, Chat Health, and Phone Reputation
guidance. The load-bearing decisions:

**One outbound path.** Every message leaves through `sendToChat` or
`sendToRecipients` in `src/linq/send.ts`. No feature can bypass the gates by calling
the API directly.

**Opt-out is enforced locally, because in a group chat nothing else will.** Linq
blocks opted-out recipients on direct messages across every line, but its docs are
explicit that *group threads are never blocked*. Since this product lives in group
chats, `src/linq/optout.ts` is the entire enforcement mechanism. It implements both
Linq's exact keyword rule (whole message, case-sensitive, with `OPT OUT` as the
documented casing exception) and conversational stop intent, which Linq does not
detect at all. On an opt-out in a group, the member is removed from the thread; if
the group is too small to remove anyone, the agent halts there entirely.

**A `2024` rejection is honored, never retried.** `handleSendError` records the
opt-out and marks the chat `OPTED_OUT`. The single courtesy message allowed through
with `override_optout: true` is marked as sent *before* the request goes out, so a
failure can't produce a second override.

**Opt-ins aren't tracked locally.** Linq clears an opt-out as soon as the recipient
replies with anything that isn't itself a keyword, and the webhook handler mirrors
that rather than keeping separate state.

**Sends never name a line.** `sendToRecipients` posts to `/v3/messages` with `to` and
no `from`, which is what lets Linq reuse a recipient's healthy line, load-balance new
chats, and fail over off a flagged line. `GET /v3/available_number` is called only
from `src/linq/onboarding.ts`, never on the send path.

**Health and reputation gate every send.** Chat health is cached from the webhook
stream; line reputation is refreshed at startup and on `phone_number.status_updated`.
`CRITICAL` pauses, `AT_RISK` slows. Users are never migrated off an `AT_RISK` line to
escape the status.

**Cadence backs off.** After an unanswered outbound the ladder is one follow-up after
24h, one more after 72h, then a halt. Any reply resets it.

**Volume limits live in the send path.** 7,000 messages/line/day, 40 new
conversations/line/day, and a ramp ceiling of 2× the line's recent daily average
(floored so a new line can start). There is no bulk-import or campaign path that can
open an audience at once.

## Verify

```bash
npm test        # opt-out keyword rules and intent parsing
npm run typecheck
```

To re-run Linq's own integration audit, use the prompt published on their
[Best Practices page](https://docs.linqapp.com/getting-started/best-practices/).

## Known gaps

- **dd-cli flag names are unverified.** The CLI requires login before it will print
  help for any subcommand, so the invocations in `src/doordash/order.ts` come from
  the shipped quickstart rather than from `--help`. They are all defined in one
  `COMMANDS` object — check them against the real help output after signing in.
- **Stop-intent detection is regex-based.** It catches clear phrasings; an LLM
  classifier behind the same `detectsStopIntent` interface would catch more.
- **Bill splitting is even.** No itemised per-person attribution yet.
