'use client';

import { useRef, useState } from 'react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { reverseReceiptPayload, type ReceivingHistoryRow } from '@/lib/receiving-v6';
import { receivingError } from '@/lib/receiving-v5';
import { formatReceivingQuantity } from '@/lib/material-receiving';
import { ActionError, v5Button, v5Primary } from './ReceivingV5Forms';

export function ReceivingReturnDetail({ row, api, canReverse, onReversed }: {
  row: ReceivingHistoryRow; api: ReceivingV6Api; canReverse: boolean;
  onReversed: () => Promise<boolean>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [quantityInput, setQuantityInput] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false);
  const requests = useRef(new Map<string, { id: string; at: string }>());
  const availableIds = new Set(row.reversibleSerials.map(serial => serial.entryId));
  const validSelected = selectedIds.filter(id => availableIds.has(id));
  const quantity = row.requiresSerial ? validSelected.length : Number(quantityInput);
  const validQuantity = row.requiresSerial ? quantity > 0 : quantityInput.trim() !== '' && Number.isFinite(quantity)
    && quantity > 0 && quantity <= row.reversibleQuantity;
  const disabled = !canReverse || !row.returnToReceived || busy || !validQuantity || !reason.trim();

  const submit = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError('');
    const entryIds = row.requiresSerial ? validSelected : [];
    const fingerprint = JSON.stringify([row.receiptId, quantity, [...entryIds].sort(), reason.trim()]);
    let request = requests.current.get(fingerprint);
    if (!request) { request = { id: crypto.randomUUID(), at: new Date().toISOString() }; requests.current.set(fingerprint, request); }
    try {
      await api.reverseIn(reverseReceiptPayload(row, request.id, quantity, entryIds, request.at, reason));
      requests.current.delete(fingerprint);
      if (!await onReversed()) setError('退回已送出，但重新讀取失敗。請重新整理後確認結果。');
    } catch (cause) { setError(receivingError(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return <div aria-busy={busy} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 className="break-all font-semibold">{row.item}</h3><span className="text-sm text-secondary">原入庫 <b className="text-primary">{formatReceivingQuantity(row.quantity)} {row.unit}</b></span><span className="text-sm text-secondary">可退 <b className="text-primary">{formatReceivingQuantity(row.reversibleQuantity)} {row.unit}</b></span>{row.requiresSerial && <span className="text-sm text-secondary">已選 <b className="text-primary">{validSelected.length}</b></span>}</div>
    {row.requiresSerial ? <>
      <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={!canReverse || busy || !row.reversibleSerials.length} onClick={() => setSelectedIds(row.reversibleSerials.map(serial => serial.entryId))}>全選</button><button type="button" className={v5Button} disabled={!canReverse || busy || !validSelected.length} onClick={() => setSelectedIds([])}>取消全選</button></div>
      <ul aria-label="可退回序號" className="max-h-64 divide-y divide-theme-border overflow-y-auto text-sm">{row.reversibleSerials.map(serial => <li key={serial.entryId}><label className="flex min-h-10 cursor-pointer items-center gap-2 py-1"><input type="checkbox" aria-label={`退回序號 ${serial.serialNumber}`} checked={validSelected.includes(serial.entryId)} disabled={!canReverse || busy} onChange={event => setSelectedIds(previous => event.target.checked ? [...previous, serial.entryId] : previous.filter(id => id !== serial.entryId))} /><span className="min-w-0 break-all">{serial.serialNumber}</span></label></li>)}</ul>
    </> : <label className="flex flex-wrap items-center gap-2 text-sm">退回數量<input type="number" inputMode="decimal" min="0" max={row.reversibleQuantity} step="any" aria-label="退回數量" className="h-10 w-28 rounded-lg border border-theme-border bg-page px-2 tabular-nums" disabled={!canReverse || busy} value={quantityInput} onChange={event => setQuantityInput(event.target.value)} /><span className="text-secondary">最多 {formatReceivingQuantity(row.reversibleQuantity)} {row.unit}</span></label>}
    <label className="block text-sm">退回原因<input type="text" aria-label="退回原因" className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-page px-3" maxLength={300} disabled={!canReverse || busy} value={reason} onChange={event => setReason(event.target.value)} /></label>
    {!row.requiresSerial && quantityInput && !validQuantity && <p className="text-sm text-warning">退回數量必須大於 0，且不得超過可退數量。</p>}
    <ActionError message={error} />
    <div className="sticky bottom-0 -mx-4 border-t border-theme-border bg-card px-4 py-3 sm:-mx-6 sm:px-6"><button type="button" className={v5Primary + ' w-full'} disabled={disabled} onClick={() => void submit()}>{busy ? '退回中…' : row.requiresSerial ? `退回到已收到（${validSelected.length}）` : '退回到已收到'}</button></div>
  </div>;
}
