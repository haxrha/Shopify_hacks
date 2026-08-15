import { linq } from './client.ts';
import { healthyLines, refreshLineReputations } from './health.ts';

/**
 * New-user onboarding.
 *
 * GET /v3/available_number exists for exactly this: handing a *new* user the best
 * available line and a contact card to save, with successive calls cycling through
 * the pool so signups spread evenly across it.
 *
 * It is not a per-message call, and nothing on the send path imports this module.
 * Calling it before each send would defeat the automatic load-balancing and failover
 * that `sendToRecipients` relies on.
 */

export interface OnboardingLine {
  /** E.164 line to show the new user, e.g. on a signup screen or deeplink. */
  phoneNumber: string;
  /** Time-limited .vcf so they can save the contact before messaging. */
  vcfUrl: string;
  /** `sms:` deeplink that opens Messages with the line pre-filled. */
  deeplink: string;
}

/**
 * Picks the line to show a user who is signing up.
 *
 * `exclude_from` keeps unhealthy lines out of the selection so new users always land
 * on a healthy line. Existing conversations are never migrated to chase a status —
 * this only affects who gets onboarded where.
 */
export async function getOnboardingLine(recipientHandle?: string): Promise<OnboardingLine> {
  await refreshLineReputations();

  const all = await linq.phoneNumbers.list();
  const allNumbers = all.phone_numbers.map((line) => line.phone_number);
  const healthy = new Set(healthyLines(allNumbers));
  const excludeFrom = allNumbers.filter((number) => !healthy.has(number));

  const response = await linq.availableNumber.retrieve({
    ...(excludeFrom.length > 0 && excludeFrom.length < allNumbers.length
      ? { exclude_from: excludeFrom }
      : {}),
    ...(recipientHandle ? { to: [recipientHandle] } : {}),
  });

  return {
    phoneNumber: response.phone_number,
    vcfUrl: response.vcf_url,
    deeplink: `sms:${response.phone_number}`,
  };
}
