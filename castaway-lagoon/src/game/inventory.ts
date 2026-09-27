import { ITEM_ORDER, ITEMS, type ItemId } from './items.ts';

// Counts by item id. Tools are held once; everything else stacks.

export interface InventoryEntry {
  id: ItemId;
  count: number;
}

export class Inventory {
  private readonly counts = new Map<ItemId, number>();

  add(id: ItemId, count: number): number {
    if (!Number.isInteger(count) || count <= 0) throw new Error(`inventory add of '${id}' needs a positive whole count, got ${count}`);
    const have = this.count(id);
    const next = ITEMS[id].tool ? 1 : have + count;
    this.counts.set(id, next);
    return next - have;
  }

  /** Removes up to `count`; returns how many were actually removed. */
  remove(id: ItemId, count: number): number {
    if (!Number.isInteger(count) || count <= 0) throw new Error(`inventory remove of '${id}' needs a positive whole count, got ${count}`);
    const have = this.count(id);
    const taken = Math.min(have, count);
    if (have - taken === 0) this.counts.delete(id);
    else this.counts.set(id, have - taken);
    return taken;
  }

  count(id: ItemId): number {
    return this.counts.get(id) ?? 0;
  }

  has(id: ItemId): boolean {
    return this.count(id) > 0;
  }

  /** Entries in catalogue order, for the inventory screen. */
  entries(): InventoryEntry[] {
    const out: InventoryEntry[] = [];
    for (const id of ITEM_ORDER) {
      const n = this.count(id);
      if (n > 0) out.push({ id, count: n });
    }
    return out;
  }
}
