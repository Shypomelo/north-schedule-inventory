import type { InventoryItem } from './db/types';
import { classifyScannerCode, type ScannerCode } from './receiving-scanner-session';
import { parseScannedPayload, isStructuralMetadataToken } from './receiving-scanned-payload';
import { serialsAlias } from './receiving-v5';

export interface ScanBox {
  id: number;
  model?: ScannerCode;
  serials: ScannerCode[];
  unknown: ScannerCode[];
  status: 'open' | 'complete' | 'incomplete';
}
export interface BoxSnapshot { currentBox: ScanBox; completedBoxes: ScanBox[]; conflict?: ScannerCode }
export interface BoxScanResult { accepted: boolean; duplicate?: { serial: string; boxId: number }; conflict?: boolean }
const emptyBox = (id: number): ScanBox => ({ id, serials: [], unknown: [], status: 'open' });
const copyBox = (box: ScanBox): ScanBox => ({ ...box, model: box.model && { ...box.model }, serials: box.serials.map(c => ({ ...c })), unknown: box.unknown.map(c => ({ ...c })) });
export const boxDeviceCount = (box: ScanBox) => box.serials.length;
export const completedBoxCount = (boxes: ScanBox[]) => boxes.filter(b => b.status === 'complete' && b.serials.length > 0).length;

/** Ephemeral pre-arrival grouping. No storage, timers, network or DB callbacks. */
export class BoxScanSession {
  private current: ScanBox;
  private completed: ScanBox[];
  private conflict?: ScannerCode;
  private nextId: number;
  private closed = false;
  constructor(private items: InventoryItem[], initial?: BoxSnapshot) {
    this.current = initial ? copyBox(initial.currentBox) : emptyBox(1);
    this.completed = initial?.completedBoxes.map(copyBox) || [];
    this.conflict = initial?.conflict;
    this.nextId = Math.max(this.current.id, ...this.completed.map(b => b.id)) + 1;
  }
  snapshot(): BoxSnapshot { return { currentBox: copyBox(this.current), completedBoxes: this.completed.map(copyBox), conflict: this.conflict && { ...this.conflict } }; }
  get deviceCount() { return [this.current, ...this.completed].reduce((n, b) => n + boxDeviceCount(b), 0); }
  private assertOpen() { if (this.closed) throw new Error('掃描已結束，正式到貨資料請使用修改／撤回／更正。'); }
  add(raw: string): BoxScanResult {
    this.assertOpen();
    const payload = parseScannedPayload(raw);
    const codes = payload.candidates.map(value => classifyScannerCode(value, this.items));
    let accepted = false;
    // Resolve model disagreement before assigning any serials from this payload.
    for (const code of codes.filter(c => c.kind === 'MODEL')) {
      if (this.current.model && this.current.model.normalized !== code.normalized) { this.conflict = code; return { accepted: false, conflict: true }; }
      if (!this.current.model) { this.current.model = code; accepted = true; }
    }
    if (this.conflict) return { accepted: false, conflict: true };
    let duplicate: BoxScanResult['duplicate'];
    for (const code of codes.filter(c => c.kind !== 'MODEL')) {
      if (code.kind === 'SERIAL') {
        // Derive ownership from live boxes, so deleting releases aliases immediately.
        const owner = [this.current, ...this.completed].find(b => b.serials.some(s => serialsAlias(s.normalized, code.normalized)));
        if (owner) { duplicate = { serial: code.normalized, boxId: owner.id }; continue; }
        this.current.serials.push(code); accepted = true;
      } else if (code.normalized && !(payload.composite && isStructuralMetadataToken(code.raw))) {
        if (!this.current.unknown.some(c => c.normalized === code.normalized)) { this.current.unknown.push(code); accepted = true; }
      }
    }
    return { accepted, duplicate };
  }
  confirmModel(useDetected: boolean) {
    this.assertOpen();
    if (useDetected && this.conflict) this.current.model = this.conflict;
    this.conflict = undefined;
  }
  completeBox() {
    this.assertOpen();
    if (!this.current.serials.length) throw new Error('尚未掃到序號，請繼續掃描或清空目前這箱。');
    this.completed.push({ ...copyBox(this.current), status: 'complete' });
    this.current = emptyBox(this.nextId++);
    if (this.conflict) this.current.model = this.conflict;
    this.conflict = undefined;
  }
  deleteSerial(boxId: number, normalized: string) {
    this.assertOpen();
    const box = [this.current, ...this.completed].find(b => b.id === boxId);
    if (!box) return;
    box.serials = box.serials.filter(c => c.normalized !== normalized);
    if (box !== this.current && !box.serials.length) box.status = 'incomplete';
  }
  deleteBox(boxId: number) { this.assertOpen(); this.completed = this.completed.filter(b => b.id !== boxId); }
  clearCurrent() { this.assertOpen(); this.current = emptyBox(this.current.id); this.conflict = undefined; }
  reopenBox(boxId: number) {
    this.assertOpen();
    if (this.current.model || this.current.serials.length || this.current.unknown.length || this.conflict) throw new Error('請先完成或清空目前這箱。');
    const box = this.completed.find(b => b.id === boxId);
    if (!box) return;
    this.completed = this.completed.filter(b => b.id !== boxId);
    this.current = { ...copyBox(box), status: 'open' };
  }
  finish(): ScanBox[] {
    this.assertOpen();
    if (this.conflict) throw new Error('偵測到不同型號，請先確認型號。');
    if (this.completed.some(b => !b.serials.length || b.status !== 'complete')) throw new Error('有未完成的箱，請編輯補掃或刪除這箱。');
    if (this.current.serials.length) this.completeBox();
    else if (this.current.model || this.current.unknown.length) throw new Error('目前這箱尚未掃到序號，請繼續掃描或清空。');
    if (!this.completed.length) throw new Error('請先掃描序號。');
    return this.completed.map(copyBox);
  }
  close() { this.closed = true; }
}
