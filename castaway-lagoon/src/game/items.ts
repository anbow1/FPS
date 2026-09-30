// The item catalogue. The inventory holds counts by id; names, descriptions
// and icon keys live here so the HUD and logic agree.

export type ItemId =
  | 'stone'
  | 'rifle'
  | 'ammo762'
  | 'knife'
  | 'herb'
  | 'hibiscus'
  | 'aloe'
  | 'coconut'
  | 'beans'
  | 'flare'
  | 'canteen'
  | 'rope'
  | 'backpack'
  | 'lamp'
  | 'lighter'
  | 'fishhooks';

export interface ItemSpec {
  name: string;
  description: string;
  /** Tools occupy one slot and never stack. */
  tool: boolean;
}

export const ITEMS: Record<ItemId, ItemSpec> = {
  stone: { name: 'Stone', description: 'A smooth beach pebble. Good for throwing — flat ones skip.', tool: false },
  rifle: { name: 'AK-47', description: 'Worn 7.62×39 mm rifle, wooden furniture, 30-round magazine. Press 1.', tool: true },
  ammo762: { name: '7.62 Rounds', description: 'Loose 7.62×39 mm cartridges for the AK.', tool: false },
  knife: { name: 'Survival Knife', description: 'Clip-point blade, cord-wrapped grip. Press 2. Cuts plants cleanly.', tool: true },
  herb: { name: 'Jungle Herb', description: 'Broad green medicinal leaves. Crushed, they help wounds close.', tool: false },
  hibiscus: { name: 'Hibiscus Flower', description: 'Red tropical bloom. Brewed into a sour, bright tea.', tool: false },
  aloe: { name: 'Aloe Leaf', description: 'Thick leaf full of cooling gel — sunburn relief.', tool: false },
  coconut: { name: 'Coconut', description: 'Fresh coconut. Water and meat, if you can crack it.', tool: false },
  beans: { name: 'Canned Beans', description: 'Dented tin from the supply crate. Still sealed.', tool: false },
  flare: { name: 'Signal Flare', description: 'Red hand flare. Someone might be watching the sky.', tool: false },
  canteen: { name: 'Canteen', description: 'Dented aluminium canteen, half full of rainwater.', tool: false },
  rope: { name: 'Rope Coil', description: 'Ten metres of frayed nylon rope.', tool: false },
  backpack: { name: 'Backpack', description: 'Worn canvas backpack, straps repaired with fishing line. Everything you carry rides in it.', tool: false },
  lamp: { name: 'Kerosene Lamp', description: 'Hurricane lamp from the shelter. L lights it or puts it out; water puts it out too.', tool: false },
  lighter: { name: 'Lighter', description: 'Half-empty disposable lighter. Enough for a fire or two.', tool: false },
  fishhooks: { name: 'Fishhook Tin', description: 'A dozen hooks and a spool of line in an old tobacco tin.', tool: false },
};

export const ITEM_ORDER: readonly ItemId[] = ['rifle', 'knife', 'stone', 'ammo762', 'herb', 'hibiscus', 'aloe', 'coconut', 'beans', 'flare', 'canteen', 'rope', 'backpack', 'lamp', 'lighter', 'fishhooks'];

export function isItemId(v: string): v is ItemId {
  return Object.hasOwn(ITEMS, v);
}
