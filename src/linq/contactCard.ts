import { config } from '../config.ts';
import { getChat, now, upsertChat } from '../db.ts';
import { linq } from './client.ts';

/**
 * Contact card setup and sharing.
 *
 * Setup is once per line (POST), with later edits going through PATCH. Sharing is a
 * separate, dedicated endpoint and is rate-limited to roughly once a day per chat,
 * because there is no signal telling us whether the recipient saved the card.
 */

export interface ContactCardProfile {
  firstName: string;
  lastName?: string;
  imageUrl?: string;
}

/**
 * Creates the card for a line if it doesn't exist yet, otherwise updates it.
 *
 * Intended for initial setup and deliberate profile changes — not something to call
 * on the send path.
 */
export async function ensureContactCard(
  phoneNumber: string,
  profile: ContactCardProfile,
): Promise<void> {
  const existing = await linq.contactCard.retrieve({ phone_number: phoneNumber }).catch(() => null);

  const hasCard =
    existing !== null &&
    Array.isArray((existing as { contact_cards?: unknown[] }).contact_cards) &&
    ((existing as { contact_cards: unknown[] }).contact_cards.length ?? 0) > 0;

  if (hasCard) {
    await linq.contactCard.update({
      phone_number: phoneNumber,
      first_name: profile.firstName,
      last_name: profile.lastName,
      image_url: profile.imageUrl,
    });
    return;
  }

  await linq.contactCard.create({
    phone_number: phoneNumber,
    first_name: profile.firstName,
    last_name: profile.lastName,
    image_url: profile.imageUrl,
  });
}

/**
 * Shares the card into a chat, if it's appropriate to do so.
 *
 * Two conditions, both from the Best Practices flow: there must already be at least
 * one outbound message in the chat, and we re-share at most once a day.
 */
export async function maybeShareContactCard(chatId: string): Promise<boolean> {
  const chat = getChat(chatId);
  if (!chat?.first_outbound_at) return false;

  const lastShared = chat.contact_card_shared_at;
  const cooldownMs = config.limits.contactCardReshareHours * 3_600_000;
  if (lastShared && now() - lastShared < cooldownMs) return false;

  try {
    await linq.chats.shareContactCard(chatId);
    upsertChat(chatId, { contact_card_shared_at: now() });
    return true;
  } catch (error) {
    console.error(`[contact-card] share failed for chat ${chatId}`, error);
    return false;
  }
}
