'use client';

import { FormEvent, useMemo, useState } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { dbAdapter } from '@/lib/db';
import type { MaterialReceipt, MaterialReceiptSourceType } from '@/lib/db/types';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import {
  formatReceivingQuantity,
  formatTaipeiReceivingTime,
  getReceiptEventType,
  getReceiptReversibleQuantity,
} from '@/lib/material-receiving';

export function MaterialReceiptHistoryDialog({
  receipts,
  sourceType,
  sourceId,
  itemLabel,
  contextLabel,
  unit,
  canEdit,
  onClose,
  onChanged,
}: {
  receipts: MaterialReceipt[];
  sourceType: MaterialReceiptSourceType;
  sourceId: string;
  itemLabel: string;
  contextLabel?: string;
  unit: string;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const sourceReceipts = useMemo(() => receipts.filter(receipt => (
    receipt.source_type === sourceType
    && (sourceType === 'PROJECT_MATERIAL'
      ? receipt.project_material_id === sourceId
      : receipt.se_supply_record_id === sourceId)
  )).sort((left, right) => (
    right.received_at.localeCompare(left.received_at) || right.id.localeCompare(left.id)
  )), [receipts, sourceId, sourceType]);
  const [correcting, setCorrecting] = useState<MaterialReceipt | null>(null);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCorrection = (receipt: MaterialReceipt) => {
    const reversible = getReceiptReversibleQuantity(receipt, receipts);
    setCorrecting(receipt);
    setQuantity(formatReceivingQuantity(reversible));
    setNotes('');
    setError(null);
  };

  const submitCorrection = async (event: FormEvent) => {
    event.preventDefault();
    if (!correcting || !canEdit) return;
    const numericQuantity = Number(quantity);
    const reversible = getReceiptReversibleQuantity(correcting, receipts);
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0 || numericQuantity > reversible) {
      setError(`更正數量必須介於 0 與 ${formatReceivingQuantity(reversible)} ${unit} 之間。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dbAdapter.reverseMaterialReceipt({
        receiptId: correcting.id,
        quantityReversed: numericQuantity,
        reversedAt: new Date().toISOString(),
        notes,
      });
      setCorrecting(null);
      setQuantity('');
      setNotes('');
      await onChanged();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '收料更正失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label={`${itemLabel}收料紀錄`}>
    <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-xl border border-theme-border bg-card shadow-2xl">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-theme-border bg-card p-4">
        <div><h3 className="font-bold text-primary">收料紀錄</h3><p className="mt-1 text-sm text-secondary">{itemLabel}{contextLabel ? `｜${contextLabel}` : ''}</p></div>
        <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-secondary hover:bg-page" aria-label="關閉收料紀錄"><X size={18} /></button>
      </div>
      <div className="space-y-2 p-4">
        {sourceReceipts.length === 0 ? <p className="rounded-lg border border-dashed border-theme-border p-6 text-center text-sm text-secondary">尚無收料紀錄。</p> : sourceReceipts.map(receipt => {
          const eventType = getReceiptEventType(receipt);
          const reversible = getReceiptReversibleQuantity(receipt, receipts);
          return <div key={receipt.id} className="rounded-lg border border-theme-border bg-page/25 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${eventType === 'REVERSAL' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/40 bg-success/10 text-success'}`}>{eventType === 'REVERSAL' ? '收料更正' : '確認收到'}</span><p className="mt-2 text-sm font-semibold text-primary">{eventType === 'REVERSAL' ? '−' : '+'}{formatReceivingQuantity(Number(receipt.quantity_received))} {unit}</p></div>
              <div className="text-right text-xs text-secondary"><p>{formatTaipeiReceivingTime(receipt.received_at)}</p>{receipt.notes ? <p className="mt-1 max-w-64 break-words">{receipt.notes}</p> : null}</div>
            </div>
            {eventType === 'REVERSAL' && receipt.reversal_of_id ? <p className="mt-2 text-[11px] text-secondary">更正原收料：{receipt.reversal_of_id}</p> : null}
            {canEdit && eventType === 'RECEIVE' && reversible > 0 ? <div className="mt-2 flex justify-end"><button type="button" onClick={() => startCorrection(receipt)} className="inline-flex h-8 items-center gap-1 rounded-md border border-warning/40 px-2 text-xs font-bold text-warning hover:bg-warning/10"><RotateCcw size={13} />收料更正</button></div> : null}
          </div>;
        })}
      </div>
      {correcting ? <form onSubmit={submitCorrection} className="sticky bottom-0 space-y-3 border-t border-theme-border bg-card p-4">
        <div><p className="text-sm font-bold text-primary">退回待收</p><p className="mt-1 text-xs text-secondary">原收料保留；本次會新增一筆更正紀錄。最多可更正 {formatReceivingQuantity(getReceiptReversibleQuantity(correcting, receipts))} {unit}。</p></div>
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
          <label className="text-xs text-secondary">更正數量<input autoFocus type="number" min="0.001" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-page px-3 text-sm text-primary outline-none focus:border-accent" /></label>
          <label className="text-xs text-secondary">原因／備註<input value={notes} onChange={event => setNotes(event.target.value)} placeholder="例：誤按確認收到" className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-page px-3 text-sm text-primary outline-none focus:border-accent" /></label>
        </div>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setCorrecting(null)} className="h-9 rounded-lg border border-theme-border px-3 text-sm text-secondary">取消</button><button type="submit" disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-warning px-3 text-sm font-bold text-black disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}確認更正</button></div>
      </form> : null}
    </div>
  </div>;
}
