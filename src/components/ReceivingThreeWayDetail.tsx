'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import type { ReceivedGroup, ReceivedStage, ReceivingV6Snapshot } from '@/lib/receiving-v6';
import { compatibleProjectRequirements, type ReceivingProjectRequirement } from '@/lib/receiving-project-requirements';
import { receivingError } from '@/lib/receiving-v5';
import { selectReceivingProjects } from '@/lib/project-selectors';
import { formatReceivingQuantity } from '@/lib/material-receiving';
import { ActionError, useV5Action, useV5Request, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { ReceivingPostDetail } from './ReceivingPostDetail';
import { CompleteUnknown } from './ReceivingWorkModal';
import { ReceivingBatchResolve } from './ReceivingBatchResolve';

type Mode = 'inventory' | 'SE' | 'PROJECT_PREP' | 'resolve' | 'cancel';
type CancelTarget = { key: string; lineId: string; reversalReceiptId: string | null;
  quantity: number; serials: { entryId: string; label: string }[]; serialized: boolean; label: string };

function stageLabel(stage: ReceivedStage): string {
  const when = stage.kind === 'REENTRY' ? stage.reversalAt : stage.row.at;
  const date = when ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(when)) : '時間未記錄';
  const arrival = stage.row.arrival;
  const batch = arrival?.batch_kind === 'BOX' && arrival.batch_position
    ? `箱 ${String(arrival.batch_position).padStart(2, '0')}`
    : arrival?.batch_kind === 'LOOSE' ? '散料' : '到貨批次';
  return `${date}・${batch}${stage.kind === 'REENTRY' ? '・退回後' : ''}`;
}

function StageRouteForm({ route, group, data, api, onChanged }: {
  route: 'SE' | 'PROJECT_PREP'; group: ReceivedGroup; data: ReceivingV6Snapshot;
  api: ReceivingV6Api; onChanged: () => Promise<boolean>;
}) {
  const [stageKey, setStageKey] = useState(group.stages[0]?.key || '');
  const stage = group.stages.find(value => value.key === stageKey);
  const [entryIds, setEntryIds] = useState<string[]>([]), [quantity, setQuantity] = useState('');
  const [projectId, setProjectId] = useState(''), [requirementId, setRequirementId] = useState('');
  const [requirements, setRequirements] = useState<ReceivingProjectRequirement[] | null>(null);
  const [requirementError, setRequirementError] = useState('');
  const [receivedAt] = useState(() => new Date().toISOString());
  const action = useV5Action(), request = useV5Request();
  const selectedStage = stage;
  const amount = selectedStage?.requiresSerial ? entryIds.length : Number(quantity);
  const validAmount = Boolean(selectedStage && Number.isFinite(amount) && amount > 0 && amount <= selectedStage.quantity);
  useEffect(() => { setEntryIds([]); setQuantity(''); setRequirementId(''); }, [stageKey]);
  useEffect(() => { setRequirementId(''); }, [amount]);
  useEffect(() => {
    let alive = true; setRequirements(null); setRequirementError('');
    if (route === 'PROJECT_PREP' && projectId && group.itemId) void api.projectRequirements(projectId, group.itemId)
      .then(rows => { if (alive) setRequirements(rows); })
      .catch(cause => { if (alive) setRequirementError(receivingError(cause)); });
    return () => { alive = false; };
  }, [api, route, projectId, group.itemId]);
  const candidates = validAmount && requirements ? compatibleProjectRequirements(requirements, amount) : [];
  const materialId = requirementId && requirementId !== 'new' && candidates.some(row => row.id === requirementId) ? requirementId : null;
  const createNew = requirementId === 'new';
  const siteReady = route !== 'PROJECT_PREP' || Boolean(projectId && requirements && (materialId || createNew));
  const submit = () => void action.run(async () => {
    if (!selectedStage || !validAmount || !siteReady) throw new Error('請選擇有效的待處理數量與案場物料。');
    await api.routeStaged({ stage: selectedStage, requestId: request({ stageKey, route, amount, entryIds, projectId,
      materialId, createNew, receivedAt }).p_request_id, route, quantity: amount, entryIds,
      projectId: projectId || null, materialId, createNew, receivedAt });
    if (!await onChanged()) throw new Error('後續處理已送出，但重新讀取失敗；請重新整理確認結果。');
  });
  return <div aria-busy={action.busy} className="space-y-3">
    <h3 className="font-semibold">{route === 'SE' ? '加入 SE 供貨追蹤' : '加入案場物料'}</h3>
    {group.stages.length > 1 && <label className="block text-sm">選擇到貨批次<select className={v5Field} value={stageKey} disabled={action.busy} onChange={e => setStageKey(e.target.value)}>{group.stages.map(value => <option key={value.key} value={value.key}>{stageLabel(value)}・可處理 {formatReceivingQuantity(value.quantity)} {value.row.unit}</option>)}</select></label>}
    {selectedStage && <fieldset disabled={action.busy} className="space-y-3">
      {selectedStage.requiresSerial ? <div className="max-h-56 overflow-y-auto" aria-label="待處理序號">{selectedStage.serials.map(serial => <label key={serial.entryId} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={entryIds.includes(serial.entryId)} onChange={e => setEntryIds(ids => e.target.checked ? [...ids, serial.entryId] : ids.filter(id => id !== serial.entryId))} /><span className="break-all">{serial.serialNumber}</span></label>)}</div>
        : <label className="block text-sm">處理數量（最多 {formatReceivingQuantity(selectedStage.quantity)}）<input className={v5Field} type="number" min="0.001" max={selectedStage.quantity} step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
      <ReceivingProjectCombobox projects={selectReceivingProjects(data.projects)} value={projectId} onChange={setProjectId} required={route === 'PROJECT_PREP'} />
      {route === 'PROJECT_PREP' && projectId && <div className="space-y-2 text-sm">
        {!requirements && !requirementError && <p role="status">查詢案場物料需求…</p>}
        <ActionError message={requirementError} />
        {requirements && <label className="block">案場物料<select className={v5Field} aria-label="案場物料" value={requirementId} onChange={e => setRequirementId(e.target.value)}><option value="">請明確選擇</option>{candidates.map(row => <option key={row.id} value={row.id}>{row.batch_name} · {row.specification || row.item_name} · 剩 {Number(row.quantity) - Number(row.received) - Number(row.prepared || 0)}</option>)}<option value="new">建立新的案場物料</option></select></label>}
      </div>}
      {route === 'PROJECT_PREP' && <p className="text-sm text-secondary">備料仍在北辦庫存，尚未送達案場。</p>}
    </fieldset>}
    <ActionError message={action.error} />
    <button type="button" className={v5Primary + ' w-full'} disabled={action.busy || !validAmount || !siteReady} onClick={submit}>{action.busy ? '處理中…' : route === 'SE' ? '確認加入 SE 供貨追蹤' : '確認加入案場物料'}</button>
  </div>;
}

function CancelArrivalForm({ group, data, api, onChanged }: {
  group: ReceivedGroup; data: ReceivingV6Snapshot; api: ReceivingV6Api; onChanged: () => Promise<boolean>;
}) {
  const targets = useMemo<CancelTarget[]>(() => [
    ...group.stages.map(stage => ({ key: stage.key, lineId: stage.lineId, label: stageLabel(stage),
      reversalReceiptId: stage.reversalReceiptId, quantity: stage.quantity,
      serialized: stage.requiresSerial, serials: stage.serials.map(serial => ({ entryId: serial.entryId, label: serial.serialNumber })) })),
    ...group.rows.filter(row => row.state === 'UNRESOLVED' && row.line).map(row => ({ key: row.key,
      label: `${row.at ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.at)) : '時間未記錄'}・${row.arrival?.batch_kind === 'BOX' && row.arrival.batch_position ? `箱 ${String(row.arrival.batch_position).padStart(2, '0')}` : row.arrival?.batch_kind === 'LOOSE' ? '散料' : '待補資料到貨批次'}`,
      lineId: row.line!.id, reversalReceiptId: null,
      quantity: group.remainingByLine[row.line!.id], serialized: row.observations.length > 0,
      serials: row.observations.map(entry => ({ entryId: entry.id, label: entry.normalized_serial })) })),
  ], [group]);
  const [targetKey, setTargetKey] = useState(targets[0]?.key || '');
  const target = targets.find(value => value.key === targetKey);
  const [entryIds, setEntryIds] = useState<string[]>([]), [quantity, setQuantity] = useState('');
  const [reductions, setReductions] = useState<Record<string, string>>({}), [reason, setReason] = useState('');
  const action = useV5Action(), request = useV5Request();
  useEffect(() => { setEntryIds([]); setQuantity(''); setReductions({}); }, [targetKey]);
  const amount = target?.serialized ? entryIds.length : Number(quantity);
  const matches = data.matches.filter(match => match.arrival_line_id === target?.lineId && !match.cancelled_at);
  const line = data.lines.find(value => value.id === target?.lineId);
  const canceled = data.cancellations.filter(event => event.arrival_line_id === target?.lineId)
    .reduce((sum, event) => sum + Number(event.quantity), 0);
  const reductionsTotal = Object.values(reductions).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const validReductions = matches.every(match => {
    const value = Number(reductions[match.id] || 0);
    return Number.isFinite(value) && value >= 0 && value <= Number(match.quantity);
  });
  const minReduction = Math.max(0, matches.reduce((sum, match) => sum + Number(match.quantity), 0)
    - ((Number(line?.quantity) || 0) - canceled - (Number.isFinite(amount) ? amount : 0)));
  const valid = Boolean(target && Number.isFinite(amount) && amount > 0 && amount <= target.quantity
    && (target.serialized || validReductions && reductionsTotal <= amount && reductionsTotal >= minReduction));
  const submit = () => void action.run(async () => {
    if (!target || !valid) throw new Error('請選擇有效的待取消數量與待收對應。');
    const matchReductions = matches.flatMap(match => Number(reductions[match.id]) > 0
      ? [{ match_id: match.id, quantity: Number(reductions[match.id]) }] : []);
    await api.cancelPhysicalStage({ requestId: request({ targetKey, amount, entryIds, matchReductions, reason }).p_request_id,
      lineId: target.lineId, reversalReceiptId: target.reversalReceiptId, quantity: amount,
      entryIds, matchReductions, reason: reason.trim() });
    if (!await onChanged()) throw new Error('取消已送出，但重新讀取失敗；請重新整理確認結果。');
  });
  return <div aria-busy={action.busy} className="space-y-3">
    <h3 className="font-semibold">確定取消這筆實際到貨？</h3>
    <p className="text-sm text-secondary">只取消目前仍待處理的數量；取消後會恢復對應的待收數量。已正式處理的部分會保留。</p>
    {targets.length > 1 && <label className="block text-sm">選擇到貨批次<select className={v5Field} disabled={action.busy} value={targetKey} onChange={e => setTargetKey(e.target.value)}>{targets.map(value => <option value={value.key} key={value.key}>{value.label}・可取消 {formatReceivingQuantity(value.quantity)}</option>)}</select></label>}
    {target && <fieldset disabled={action.busy} className="space-y-3">
      {target.serialized ? <div className="max-h-56 overflow-y-auto" aria-label="可取消序號">{target.serials.map(serial => <label key={serial.entryId} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={entryIds.includes(serial.entryId)} onChange={e => setEntryIds(ids => e.target.checked ? [...ids, serial.entryId] : ids.filter(id => id !== serial.entryId))} /><span className="break-all">{serial.label}</span></label>)}</div>
        : <label className="block text-sm">取消數量（最多 {formatReceivingQuantity(target.quantity)}）<input className={v5Field} type="number" min="0.001" max={target.quantity} step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
      {!target.serialized && matches.length > 0 && <div className="space-y-2 text-sm"><p>指定要恢復的待收對應數量（至少 {formatReceivingQuantity(minReduction)}）</p>{matches.map(match => <label className="block" key={match.id}>{match.project_material_id ? '案場物料' : 'SE 供貨'} · 已對應 {formatReceivingQuantity(Number(match.quantity))}<input className={v5Field} type="number" min="0" max={match.quantity} step="any" value={reductions[match.id] || ''} onChange={e => setReductions(current => ({ ...current, [match.id]: e.target.value }))} /></label>)}</div>}
      <label className="block text-sm">取消原因<input className={v5Field} value={reason} onChange={e => setReason(e.target.value)} /></label>
    </fieldset>}
    <ActionError message={action.error} />
    <button type="button" className={v5Primary + ' w-full'} disabled={action.busy || !valid || !reason.trim()} onClick={submit}>{action.busy ? '取消中…' : '確認取消到貨'}</button>
  </div>;
}

export function ReceivingThreeWayDetail({ group, data, api, canEdit, initialMode = 'inventory', onChanged }: {
  group: ReceivedGroup; data: ReceivingV6Snapshot; api: ReceivingV6Api; canEdit: boolean;
  initialMode?: Mode; onChanged: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const unresolved = group.states.includes('UNRESOLVED');
  const modes: { key: Mode; label: string }[] = !canEdit || (!unresolved && !group.stages.length) ? [] : unresolved
    ? [{ key: 'resolve', label: '補資料' }, { key: 'cancel', label: '取消實際到貨' }]
    : [{ key: 'inventory', label: '進北辦庫存' }, { key: 'SE', label: '加入 SE 供貨追蹤' },
      { key: 'PROJECT_PREP', label: '加入案場物料' }, { key: 'cancel', label: '取消實際到貨' }];
  return <div className="space-y-4">
    <div><h3 className="font-semibold">{group.pn} · {group.name}</h3><p className="text-sm text-secondary">已收到 {formatReceivingQuantity(group.quantity)} {group.unit}</p></div>
    {group.rows.some(row => row.observations.length > 0) && <details className="rounded-lg border border-theme-border px-3 py-2 text-sm"><summary className="cursor-pointer">查看序號 · {group.rows.reduce((sum, row) => sum + row.observations.length, 0)}</summary>
      <ul className="max-h-48 overflow-y-auto pt-2">{group.rows.flatMap(row => row.observations.map(entry => <li key={entry.id} className="break-all py-0.5">{entry.normalized_serial}</li>))}</ul></details>}
    {canEdit && <div aria-label="後續處理" className="flex flex-wrap gap-2">{modes.map(value => <button key={value.key} type="button" aria-pressed={mode === value.key} className={mode === value.key ? v5Primary : v5Button} onClick={() => setMode(value.key)}>{value.label}</button>)}</div>}
    {canEdit && mode === 'resolve' && unresolved && (group.rows.some(row => row.observations.length > 0)
      ? <ReceivingBatchResolve group={group} data={data} api={api} onChanged={onChanged} />
      : group.rows[0] && <CompleteUnknown row={group.rows[0]} data={data} api={api} onChanged={async () => { await onChanged(); }} />)}
    {mode === 'inventory' && !unresolved && <ReceivingPostDetail group={group} data={data} api={api} canPost={canEdit && group.stages.length > 0} onPosted={onChanged} />}
    {(mode === 'SE' || mode === 'PROJECT_PREP') && !unresolved && canEdit && <StageRouteForm route={mode} group={group} data={data} api={api} onChanged={onChanged} />}
    {mode === 'cancel' && canEdit && <CancelArrivalForm group={group} data={data} api={api} onChanged={onChanged} />}
  </div>;
}
