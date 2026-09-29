import { classifySerialFormat, normalizeSerialInput } from './inventory-serial-normalization';
import type { InventoryItem } from './db/types';
import { isStructuralMetadataToken, parseScannedPayload } from './receiving-scanned-payload';

export type ScannerKind = 'MODEL' | 'SERIAL' | 'UNKNOWN';
export interface ScannerCode { raw: string; normalized: string; kind: ScannerKind; itemId?: string }

export function scannerCounts(codes: ScannerCode[]) {
  return {
    total: codes.length,
    model: codes.filter(code => code.kind === 'MODEL').length,
    serial: codes.filter(code => code.kind === 'SERIAL').length,
    unknown: codes.filter(code => code.kind === 'UNKNOWN').length,
  };
}

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
    const payload = parseScannedPayload(raw);
    const classified = payload.candidates.map(candidate => classifyScannerCode(candidate, this.items));
    const recognized = classified.filter(code => code.kind !== 'UNKNOWN');
    const unresolved = classified.filter(code => code.kind === 'UNKNOWN' && !isStructuralMetadataToken(code.raw));
    const incoming = payload.composite
      ? [...recognized, ...(unresolved.length || !recognized.length ? [{ raw: payload.raw, normalized: normalizeSerialInput(payload.raw), kind: 'UNKNOWN' as const }] : [])]
      : classified;
    let added = false;
    for (const code of incoming) {
      if (!code.normalized || this.seen.has(code.normalized)) continue;
      this.seen.add(code.normalized);
      this.codes.push(code);
      this.pending.push(code);
      added = true;
    }
    if (!added) return false;
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
