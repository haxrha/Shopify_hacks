/**
 * One-time line setup: creates the contact card recipients see, on every line.
 *
 * Run once per environment, and again only when the profile changes:
 *   npm run setup:line
 *
 * Deliberately a script rather than something the send path calls. Card creation is
 * per-line setup, and sharing is what happens per-chat (see src/linq/contactCard.ts).
 */
import { linq } from '../src/linq/client.ts';
import { ensureContactCard } from '../src/linq/contactCard.ts';
import { refreshLineReputations } from '../src/linq/health.ts';
import { getLineReputation } from '../src/db.ts';

const PROFILE = {
  firstName: process.env.CONTACT_CARD_FIRST_NAME ?? 'Chow',
  lastName: process.env.CONTACT_CARD_LAST_NAME ?? 'Bot',
  imageUrl: process.env.CONTACT_CARD_IMAGE_URL,
};

async function main(): Promise<void> {
  const { phone_numbers: lines } = await linq.phoneNumbers.list();
  if (lines.length === 0) {
    console.log('No lines are provisioned on this account yet.');
    return;
  }

  await refreshLineReputations();

  for (const line of lines) {
    await ensureContactCard(line.phone_number, PROFILE);
    console.log(
      `${line.phone_number}  contact card ready  (reputation: ${getLineReputation(line.phone_number) ?? 'unknown'})`,
    );
  }

  console.log(`\nDone — ${lines.length} line(s) configured as "${PROFILE.firstName} ${PROFILE.lastName}".`);
}

main().catch((error: unknown) => {
  console.error('Line setup failed:', error);
  process.exit(1);
});
