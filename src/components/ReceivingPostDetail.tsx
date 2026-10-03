'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { type ReceivedGroup, type ReceivedStage, type ReceivingV6Snapshot } from '@/lib/receiving-v6';
import { receivingError } from '@/lib/receiving-v5';
import { formatReceivingQuantity, formatTaipeiReceivingTime } from '@/lib/material-receiving';
import { ActionError, v5Button, v5Primary } from './ReceivingV5Forms';

type PostBatch = { stage: ReceivedStage; quantity: number; entryIds: string[] };
const stateLabel = { STAGED: '待入庫', UNRESOLVED: '待補資料', POSTED: '已入庫', LEGACY: '歷史收貨' } as const;

export function ReceivingPostDetail({ group, data, api, canPost, onPosted }: {
  group: ReceivedGroup; data: ReceivingV6Snapshot; api: ReceivingV6Api; canPost: boolean;
  onPosted: (closeWhenEmpty: boolean) => Promise<boolean>;
}) {
  const item = data.items.find(value => value.id === group.itemId);
  const serialized = Boolean(item?.requires_serial);
  const postable = group.stages;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false);
  const requestIds = useRef(new Map<string, { id: string; at: string }>());
  const availableIds = useMemo(() => new Set(postable.flatMap(stage => stage.serials.map(serial => serial.entryId))), [group]);
  useEffect(() => {
    setSelectedIds(previous => previous.filter(id => availableIds.has(id)));
    setQuantities(previous => Object.fromEntries(Object.entries(previous).filter(([stageKey, value]) => {
      const remaining = postable.find(stage => stage.key === stageKey)?.quantity || 0;
      return remaining > 0 && Number(value) <= remaining;
    })));
  }, [availableIds, group]);

  const batches: PostBatch[] = [];
  let invalidQuantity = false;
  for (const stage of postable) {
    if (serialized) {
      const entryIds = stage.serials.filter(serial => selectedIds.includes(serial.entryId)).map(serial => serial.entryId);
      if (entryIds.length) batches.push({ stage, quantity: entryIds.length, entryIds });
    } else {
      const raw = quantities[stage.key] || '';
      if (!raw) continue;
      const quantity = Number(raw);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > stage.quantity) invalidQuantity = true;
      else batches.push({ stage, quantity, entryIds: [] });
    }
  }
  const selectedQuantity = batches.reduce((sum, batch) => sum + batch.quantity, 0);
  const disabled = !canPost || busy || invalidQuantity || selectedQuantity <= 0;

  const submit = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError('');
    let completed = 0;
    try {
      for (const batch of batches) {
        const fingerprint = JSON.stringify([batch.stage.key, batch.quantity, [...batch.entryIds].sort()]);
        let request = requestIds.current.get(fingerprint);
        if (!request) { request = { id: crypto.randomUUID(), at: new Date().toISOString() }; requestIds.current.set(fingerprint, request); }
        await api.postReceivedToInventory({ stage: batch.stage, requestId: request.id, quantity: batch.quantity,
          entryIds: batch.entryIds, receivedAt: request.at });
        requestIds.current.delete(fingerprint);
        completed++;
      }
      if (await onPosted(true)) { setSelectedIds([]); setQuantities({}); }
      else setError('進庫存已送出，但重新讀取失敗。請重新整理後確認結果。');
    } catch (cause) {
      setError(receivingError(cause));
      if (completed) await onPosted(false); // Read committed batches before any retry.
    } finally { busyRef.current = false; setBusy(false); }
  };

  return <div aria-busy={busy} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 className="break-all font-semibold">{group.pn} · {group.name}</h3><span className="text-sm text-secondary">已收到 <b className="tabular-nums text-primary">{formatReceivingQuantity(group.quantity)} {group.unit}</b></span>{serialized && <span className="text-sm text-secondary">已選 <b className="tabular-nums text-primary">{selectedQuantity}</b></span>}</div>
    {serialized && postable.length > 0 && <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={!canPost || busy || availableIds.size === 0} onClick={() => setSelectedIds(Array.from(availableIds))}>全選</button><button type="button" className={v5Button} disabled={!canPost || busy || selectedIds.length === 0} onClick={() => setSelectedIds([])}>取消全選</button></div>}
    <div className="divide-y divide-theme-border">{postable.length ? postable.map(stage => {
      const row = stage.row, remaining = stage.quantity, entries = stage.serials;
      return <section key={stage.key} className="min-w-0 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong className="tabular-nums">{formatReceivingQuantity(remaining)} {row.unit}</strong><span>{stage.kind === 'REENTRY' ? '待重新入庫' : stateLabel[row.state]}</span><time className="text-secondary">{formatTaipeiReceivingTime(row.at)}</time></div>
        {row.projectLabel !== '未指定案件' && <p className="mt-1 break-words text-secondary">{row.projectLabel}</p>}
        {row.arrival?.notes && <p className="mt-1 break-words text-secondary">{row.arrival.notes}</p>}
        {serialized && <ul className="mt-2 max-h-56 divide-y divide-theme-border overflow-y-auto" aria-label="待入庫序號">{entries.map(entry => <li key={entry.entryId}><label className="flex min-h-10 cursor-pointer items-center gap-2 py-1"><input type="checkbox" aria-label={`選取序號 ${entry.serialNumber}`} checked={selectedIds.includes(entry.entryId)} disabled={!canPost || busy} onChange={event => setSelectedIds(previous => event.target.checked ? [...previous, entry.entryId] : previous.filter(id => id !== entry.entryId))} /><span className="min-w-0 break-all">{entry.serialNumber}</span></label></li>)}</ul>}
        {!serialized && <label className="mt-2 flex flex-wrap items-center gap-2">進庫存數量<input type="number" inputMode="decimal" min="0" max={remaining} step="any" aria-label={`進庫存數量 ${stage.key}`} className="h-10 w-28 rounded-lg border border-theme-border bg-page px-2 tabular-nums" disabled={!canPost || busy} value={quantities[stage.key] || ''} onChange={event => setQuantities(previous => ({ ...previous, [stage.key]: event.target.value }))} /><span className="text-secondary">最多 {formatReceivingQuantity(remaining)} {row.unit}</span></label>}
      </section>;
    }) : group.rows.map(row => <section key={row.key} className="py-3 text-sm"><p>{stateLabel[row.state]} · {formatReceivingQuantity(group.remainingByLine[row.line?.id || row.key])} {row.unit}</p>{row.observations.length > 0 && <details><summary className="cursor-pointer py-2 text-accent">查看序號（{row.observations.length}）</summary><ul>{row.observations.map(entry => <li key={entry.id} className="break-all py-1">{entry.normalized_serial}</li>)}</ul></details>}</section>)}</div>
    {group.states.includes('UNRESOLVED') && <p className="text-sm text-warning">待補資料的到貨目前不能進庫存。</p>}
    {invalidQuantity && <p className="text-sm text-warning">進庫存數量必須大於 0，且不得超過待入庫數量。</p>}
    <ActionError message={error} />
    {postable.length > 0 && <div className="sticky bottom-0 -mx-4 border-t border-theme-border bg-card px-4 py-3 sm:-mx-6 sm:px-6"><button type="button" className={v5Primary + ' w-full'} disabled={disabled} onClick={() => void submit()}>{busy ? '進庫存中…' : serialized ? `進庫存（${selectedQuantity}）` : '進庫存'}</button></div>}
  </div>;
}
