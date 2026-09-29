import { classifySerialFormat, normalizeSerialInput } from './inventory-serial-normalization';
import type { InventoryItem } from './db/types';

export type ScannerKind = 'MODEL' | 'SERIAL' | 'UNKNOWN';
export interface ScannerCode { raw: string; normalized: string; kind: ScannerKind; itemId?: string }

export function classifyScannerCode(raw: string, items: InventoryItem[]): ScannerCode {
  const normalized = normalizeSerialInput(raw);
  const models = items.filter(item => normalizeSerialInput(item.code) === normalized);
  const serial = classifySerialFormat(normalized) !== 'unknown';
  // An overlapping model and serial must be resolved by a human.
  if (models.length === 1 && !serial) return { raw, normalized, kind: 'MODEL', itemId: models[0].id };
  if (!models.length && serial) return { raw, normalized, kind: 'SERIAL' };
  return { raw, normalized, kind: 'UNKNOWN' };
}

/** Session-wide exact deduplication. Repeated camera frames never create extra work. */
export class ScannerSession {
  private seen = new Set<string>();
  private pending: ScannerCode[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private items: InventoryItem[], private onBatch: (codes: ScannerCode[]) => void | Promise<void>,
    private onChange: (codes: ScannerCode[]) => void, private quietMs = 450) {}
  readonly codes: ScannerCode[] = [];
  add(raw: string) {
    if (this.disposed) return false;
    const code = classifyScannerCode(raw, this.items);
    if (!code.normalized || this.seen.has(code.normalized)) return false;
    this.seen.add(code.normalized);
    this.codes.push(code);
    this.pending.push(code);
    this.onChange([...this.codes]);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
    return true;
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.pending; this.pending = [];
    if (batch.length) void Promise.resolve(this.onBatch(batch)).catch(() => this.retry(batch.filter(code => code.kind === 'SERIAL')));
  }
  private retry(codes: ScannerCode[]) {
    if (this.disposed) return;
    const failed = new Set(codes.map(code => code.normalized));
    failed.forEach(code => this.seen.delete(code));
    for (let i = this.codes.length - 1; i >= 0; i--) if (failed.has(this.codes[i].normalized)) this.codes.splice(i, 1);
    this.onChange([...this.codes]);
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.timer = undefined; this.pending = []; }
}
