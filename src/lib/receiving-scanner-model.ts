import type { InventoryItem } from './db/types';
import { normalizeSerialInput } from './inventory-serial-normalization';

/** Scanner MODEL identity is the entire normalized PN. The RPC owns create races. */
export class ScannerModelResolver {
  private catalog: InventoryItem[];
  private pending = new Map<string, Promise<InventoryItem>>();

  constructor(items: InventoryItem[], private createItem: (key: string, unit: string, requiresSerial: boolean) => Promise<InventoryItem>) {
    this.catalog = [...items];
  }

  resolve(raw: string): Promise<InventoryItem> {
    const key = normalizeSerialInput(raw);
    if (!key) return Promise.reject(new Error('型號不可為空白。'));
    const existing = this.exactItem(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.createItem(key, '台', true).then(item => {
      this.assertUsable(key, item);
      this.catalog = [...this.catalog.filter(old => old.id !== item.id), item];
      return item;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }

  private exactItem(key: string): InventoryItem | undefined {
    const canonical = this.catalog.filter(item => item.canonical_identity_key && normalizeSerialInput(item.canonical_identity_key) === key);
    const matches = canonical.length ? canonical : this.catalog.filter(item => normalizeSerialInput(item.code) === key);
    if (matches.length > 1) throw new Error(`型號 ${key} 對應多個品項，請確認品項資料。`);
    const item = matches[0];
    if (item) this.assertUsable(key, item);
    return item;
  }

  private assertUsable(key: string, item: InventoryItem) {
    if (normalizeSerialInput(item.canonical_identity_key || '') !== key && normalizeSerialInput(item.code) !== key)
      throw new Error(`型號 ${key} 未取得相同識別碼的品項。`);
    if (!item.is_active || !item.requires_serial) throw new Error(`型號 ${key} 的品項不適用於序號收貨。`);
  }
}
