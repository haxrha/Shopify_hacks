import { runDdCli } from './ddcli.ts';

/**
 * The ordering flow: search → menu → cart → checkout URL.
 *
 * VERIFY AFTER LOGIN: dd-cli gates every subcommand — including `--help` — behind
 * `dd-cli login`, so the flag names below come from the shipped quickstart and skill
 * file rather than from the CLI's own help output. Once signed in, run
 * `dd-cli cart add-items --help` and friends and correct anything that differs.
 * Every invocation is defined in COMMANDS so there is one place to fix.
 */
const COMMANDS = {
  search: (query: string) => ['search', '--query', query],
  menu: (storeId: string) => ['menu', '--store-id', storeId],
  cartAddItems: (storeId: string, itemId: string, quantity: number) => [
    'cart',
    'add-items',
    '--store-id',
    storeId,
    '--item-id',
    itemId,
    '--quantity',
    String(quantity),
  ],
  cartShow: (cartUuid: string) => ['cart', 'show', '--cart-uuid', cartUuid],
  checkoutUrl: (cartUuid: string) => ['order', 'checkout-url', '--cart-uuid', cartUuid],
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

export interface Store {
  id: string;
  name: string;
}

export interface MenuItem {
  id: string;
  name: string;
  priceCents: number | undefined;
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

export async function searchRestaurants(query: string): Promise<Store[]> {
  const response = await runDdCli(COMMANDS.search(query));
  return pickArray(response, ['stores', 'results', 'restaurants', 'items'])
    .map((entry): Store | undefined => {
      const id = pick<string>(entry, ['store_id', 'id', 'storeId']);
      const name = pick<string>(entry, ['store_name', 'name', 'storeName']);
      return id && name ? { id: String(id), name } : undefined;
    })
    .filter((store): store is Store => store !== undefined);
}

export async function getMenu(storeId: string): Promise<MenuItem[]> {
  const response = await runDdCli(COMMANDS.menu(storeId));
  return pickArray(response, ['items', 'menu_items', 'menu'])
    .map((entry): MenuItem | undefined => {
      const id = pick<string>(entry, ['item_id', 'id', 'itemId']);
      const name = pick<string>(entry, ['name', 'item_name', 'title']);
      if (!id || !name) return undefined;
      return { id: String(id), name, priceCents: readPriceCents(entry) };
    })
    .filter((item): item is MenuItem => item !== undefined);
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
  const stores = await searchRestaurants(request);
  const store = stores[0];
  if (!store) throw new Error(`No stores found for "${request}"`);

  const menu = await getMenu(store.id);
  if (menu.length === 0) throw new Error(`No menu items available at ${store.name}`);

  const best = menu
    .map((item) => ({ item, score: scoreMatch(item.name, request) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score === 0) {
    throw new Error(`Nothing on the ${store.name} menu matched "${request}"`);
  }

  const cartResponse = await runDdCli(COMMANDS.cartAddItems(store.id, best.item.id, quantity));
  const cartUuid = pick<string>(cartResponse, ['cart_uuid', 'cartUuid', 'id', 'cart_id']);
  if (!cartUuid) throw new Error('dd-cli did not return a cart id');

  const cart = await runDdCli(COMMANDS.cartShow(cartUuid));
  const checkout = await runDdCli(COMMANDS.checkoutUrl(cartUuid));
  const checkoutUrl = pick<string>(checkout, ['checkout_url', 'checkoutUrl', 'url']);
  if (!checkoutUrl) throw new Error('dd-cli did not return a checkout URL');

  return {
    store,
    item: best.item,
    quantity,
    cartUuid: String(cartUuid),
    checkoutUrl,
    subtotalCents: pick<number>(cart, ['subtotal_cents', 'subtotalCents']),
    totalCents:
      pick<number>(cart, ['total_cents', 'totalCents']) ??
      (best.item.priceCents !== undefined ? best.item.priceCents * quantity : undefined),
  };
}
