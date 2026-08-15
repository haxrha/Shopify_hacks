import { runDdCli } from './ddcli.ts';

/**
 * The ordering flow: locate → search → menu → cart → preview → checkout URL.
 *
 * Flag names here were verified against `dd-cli <command> --help` after signing in.
 * Three things about the real CLI drive the shape of this module:
 *
 *   1. `--intent` is required on every command, including reads like `address list`.
 *   2. `cart add-items` takes a `--menu-id` and a JSON array, not a single `--item-id`.
 *      The menu id comes from the `menu` response and must match the store.
 *   3. `cart show` returns no pricing. Totals come from `order preview`.
 */

/**
 * dd-cli requires a two-line intent string describing who the call is for and why.
 * DoorDash reviews these, and their guidance is to describe the goal rather than
 * restate the command, and to keep personal details out.
 */
function intentFor(request: string): string {
  return [
    'Summary: Help a group chat order a shared meal together',
    `user prompt/purpose: "${request}"`,
  ].join('\n');
}

const COMMANDS = {
  addressList: (intent: string) => ['address', 'list', '--intent', intent],
  search: (query: string, intent: string, at: LatLng | undefined, limit: number) => [
    'search',
    '--query',
    query,
    '--limit',
    String(limit),
    ...(at ? ['--lat', String(at.lat), '--lng', String(at.lng)] : []),
    '--intent',
    intent,
  ],
  menu: (storeId: string, intent: string) => ['menu', '--store-id', storeId, '--intent', intent],
  cartAddItems: (storeId: string, menuId: string, itemsJson: string, intent: string) => [
    'cart',
    'add-items',
    '--store-id',
    storeId,
    '--menu-id',
    menuId,
    '--items-json',
    itemsJson,
    '--intent',
    intent,
  ],
  orderPreview: (cartUuid: string, intent: string) => [
    'order',
    'preview',
    '--cart-uuid',
    cartUuid,
    '--intent',
    intent,
  ],
  checkoutUrl: (cartUuid: string, intent: string) => [
    'order',
    'checkout-url',
    '--cart-uuid',
    cartUuid,
    '--intent',
    intent,
  ],
} as const;

/** Reads the first present key from a loosely-typed CLI response. */
function pick<T>(source: unknown, keys: readonly string[]): T | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key] as T;
  }
  return undefined;
}

/** Finds the first array in a response, whatever the envelope calls it. */
function pickArray(source: unknown, keys: readonly string[]): unknown[] {
  const direct = pick<unknown[]>(source, keys);
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(source)) return source;
  if (typeof source === 'object' && source !== null) {
    for (const value of Object.values(source as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Searches an arbitrarily nested response for the first usable value of a key. */
function pickDeep<T>(source: unknown, keys: readonly string[]): T | undefined {
  const direct = pick<T>(source, keys);
  if (direct !== undefined) return direct;
  if (Array.isArray(source)) {
    for (const entry of source) {
      const found = pickDeep<T>(entry, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof source === 'object' && source !== null) {
    for (const value of Object.values(source as Record<string, unknown>)) {
      const found = pickDeep<T>(value, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Store {
  id: string;
  name: string;
}

export interface MenuItem {
  id: string;
  name: string;
  priceCents: number | undefined;
}

export interface Menu {
  menuId: string;
  items: MenuItem[];
}

export interface OrderDraft {
  store: Store;
  item: MenuItem;
  quantity: number;
  cartUuid: string;
  checkoutUrl: string;
  subtotalCents: number | undefined;
  totalCents: number | undefined;
}

/**
 * Resolves the consumer's default delivery coordinates.
 *
 * Without this the CLI falls back to env DD_LAT/DD_LNG and finally a Cupertino
 * default, which would quietly search the wrong city. The default entry can sit
 * anywhere in the list, so the whole array is scanned.
 */
export async function defaultLocation(request: string): Promise<LatLng | undefined> {
  const response = await runDdCli(COMMANDS.addressList(intentFor(request))).catch(() => undefined);
  if (!response) return undefined;

  const addresses = pickArray(response, ['addresses', 'results', 'items']);
  const preferred =
    addresses.find((entry) => pick<boolean>(entry, ['is_default', 'isDefault']) === true) ??
    addresses[0];

  const lat = pick<number | string>(preferred, ['lat', 'latitude']);
  const lng = pick<number | string>(preferred, ['lng', 'longitude']);
  if (lat === undefined || lng === undefined) return undefined;

  const parsed = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng) ? parsed : undefined;
}

/** Raised when DoorDash has no delivery address to search around. */
export class NeedsAddressError extends Error {
  constructor() {
    super(
      'The DoorDash account has no delivery address. Add one in the DoorDash app ' +
        'or with `dd-cli address set`, otherwise every search returns zero stores.',
    );
    this.name = 'NeedsAddressError';
  }
}

export async function searchRestaurants(
  query: string,
  at?: LatLng,
  limit = 5,
): Promise<Store[]> {
  const response = await runDdCli(COMMANDS.search(query, intentFor(query), at, limit));

  // Interactively, DoorDash answers this by rendering an address picker. There is no
  // widget in a group chat, so it surfaces as an empty result set unless called out.
  if (pick<boolean>(response, ['needs_address']) === true) throw new NeedsAddressError();

  return pickArray(response, ['stores', 'results', 'restaurants', 'items'])
    .map((entry): Store | undefined => {
      const id = pick<string | number>(entry, ['store_id', 'id', 'storeId']);
      const name = pick<string>(entry, ['store_name', 'name', 'storeName']);
      return id !== undefined && name ? { id: String(id), name } : undefined;
    })
    .filter((store): store is Store => store !== undefined);
}

/**
 * Returns the store's menu id alongside its items.
 *
 * The menu id is not optional bookkeeping — `cart add-items` rejects a request
 * whose menu id does not match the store.
 */
export async function getMenu(storeId: string, request: string): Promise<Menu> {
  const response = await runDdCli(COMMANDS.menu(storeId, intentFor(request)));

  const menuId = pickDeep<string | number>(response, ['menu_id', 'menuId']);
  if (menuId === undefined) throw new Error(`dd-cli returned no menu_id for store ${storeId}`);

  const items = pickArray(response, ['items', 'menu_items', 'menu'])
    .map((entry): MenuItem | undefined => {
      const id = pick<string | number>(entry, ['item_id', 'id', 'itemId']);
      const name = pick<string>(entry, ['name', 'item_name', 'title']);
      if (id === undefined || !name) return undefined;
      return { id: String(id), name, priceCents: readPriceCents(entry) };
    })
    .filter((item): item is MenuItem => item !== undefined);

  return { menuId: String(menuId), items };
}

function readPriceCents(entry: unknown): number | undefined {
  const cents = pick<number>(entry, ['price_cents', 'priceCents', 'unit_price_cents']);
  if (typeof cents === 'number') return cents;
  const price = pick<number | string>(entry, ['price', 'display_price', 'unit_price']);
  if (typeof price === 'number') return Math.round(price * 100);
  if (typeof price === 'string') {
    const parsed = Number(price.replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(parsed)) return Math.round(parsed * 100);
  }
  return undefined;
}

/** Scores a menu item against the requested text; higher is better. */
function scoreMatch(itemName: string, request: string): number {
  const item = itemName.toLowerCase();
  const query = request.toLowerCase().trim();
  if (item === query) return 100;
  if (item.includes(query)) return 80;
  const words = query.split(/\s+/).filter((word) => word.length > 2);
  if (words.length === 0) return 0;
  const hits = words.filter((word) => item.includes(word)).length;
  return (hits / words.length) * 60;
}

/**
 * Turns a plain-text request ("pad thai") into a ready-to-pay checkout URL.
 *
 * Stops at the URL deliberately. The agent never completes a purchase — a human
 * opens the link and pays, which keeps the spend decision with a person rather than
 * with whoever typed into the group chat.
 */
export async function buildOrderDraft(request: string, quantity = 1): Promise<OrderDraft> {
  const intent = intentFor(request);

  const stores = await searchRestaurants(request, await defaultLocation(request));
  const store = stores[0];
  if (!store) throw new Error(`No stores found for "${request}"`);

  const menu = await getMenu(store.id, request);
  if (menu.items.length === 0) throw new Error(`No menu items available at ${store.name}`);

  const best = menu.items
    .map((item) => ({ item, score: scoreMatch(item.name, request) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score === 0) {
    throw new Error(`Nothing on the ${store.name} menu matched "${request}"`);
  }

  // item_name is required alongside item_id; the CLI rejects entries missing either.
  const itemsJson = JSON.stringify([
    { item_id: best.item.id, item_name: best.item.name, quantity },
  ]);

  const cartResponse = await runDdCli(
    COMMANDS.cartAddItems(store.id, menu.menuId, itemsJson, intent),
  );
  const cartUuid = pickDeep<string>(cartResponse, ['cart_uuid', 'cartUuid', 'cart_id']);
  if (!cartUuid) throw new Error('dd-cli did not return a cart id');

  // Pricing lives on the preview; `cart show` deliberately omits it.
  const preview = await runDdCli(COMMANDS.orderPreview(String(cartUuid), intent));

  const checkout = await runDdCli(COMMANDS.checkoutUrl(String(cartUuid), intent));
  const checkoutUrl = pickDeep<string>(checkout, ['checkout_url', 'checkoutUrl', 'url']);
  if (!checkoutUrl) throw new Error('dd-cli did not return a checkout URL');

  return {
    store,
    item: best.item,
    quantity,
    cartUuid: String(cartUuid),
    checkoutUrl,
    subtotalCents: pickDeep<number>(preview, ['subtotal_cents', 'subtotalCents', 'subtotal']),
    totalCents:
      pickDeep<number>(preview, ['total_cents', 'totalCents', 'order_total_cents', 'total']) ??
      (best.item.priceCents !== undefined ? best.item.priceCents * quantity : undefined),
  };
}
