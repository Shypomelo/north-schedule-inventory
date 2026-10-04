'use client';
import { memo, useRef, useState } from 'react';
import { boxDeviceCount, completedBoxCount, uniqueBoxSerials, type BoxSnapshot, type ScanBox } from '@/lib/receiving-box-session';

const modelLabel = (box: ScanBox) => box.model
  ? box.model.itemName && box.model.itemName !== box.model.normalized ? `${box.model.normalized} · ${box.model.itemName}` : box.model.normalized
  : '待確認型號';

type BoxHandlers = {
  onDeleteSerial: (boxId: number, serial: string) => void;
  onDeleteBox: (boxId: number) => void;
  onReopen: (boxId: number) => void;
};

function serialRows(box: ScanBox, disabled: boolean | undefined, handlers: { current: BoxHandlers }) {
  return <ul className="max-h-28 overflow-y-auto" aria-label={`箱 ${box.id} 序號`}>{box.serials.map(serial => <li key={serial.normalized} className="flex items-center justify-between gap-2 text-xs">
    <span className="min-w-0 break-all">{serial.normalized}</span><button type="button" disabled={disabled} aria-label={`刪除 ${serial.normalized}`} className="min-h-11 min-w-11 shrink-0 text-lg" onClick={() => handlers.current.onDeleteSerial(box.id, serial.normalized)}>×</button>
  </li>)}</ul>;
}

const CompletedBoxHistory = memo(function CompletedBoxHistory({ boxes, disabled, handlers }: { boxes: ScanBox[]; disabled?: boolean; handlers: { current: BoxHandlers } }) {
  return <>
    <div className="border-t border-[#d6ddd5] pt-2 text-xs">已完成 {completedBoxCount(boxes)} 箱・{uniqueBoxSerials(boxes).length} 台</div>
    {boxes.map(box => <details key={box.id} className="text-xs"><summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2"><span className="min-w-0 truncate">箱 {box.id} · {modelLabel(box)} · {box.serials.length} 台{box.status === 'incomplete' ? '（未完成）' : ''}</span><span aria-label={`箱 ${box.id} 操作`}>⋯</span></summary>
      <p className="text-[#68776e]">編輯 / 查看序號</p>{serialRows(box, disabled, handlers)}
      <div className="flex gap-4"><button type="button" className="min-h-11 text-emerald-800" onClick={() => handlers.current.onReopen(box.id)}>繼續掃描這箱</button><button type="button" className="min-h-11 text-red-800" onClick={() => { if (window.confirm(`刪除箱 ${box.id}？其中序號可重新掃入。`)) handlers.current.onDeleteBox(box.id); }}>刪除這箱</button></div>
    </details>)}
  </>;
});

export function BoxScanControls({ snapshot, disabled, onDeleteSerial, onClear, onComplete, onDeleteBox, onReopen, onConfirmModel, onResolveUnknown }: {
  snapshot: BoxSnapshot; disabled?: boolean; onDeleteSerial: (boxId: number, serial: string) => void;
  onClear: () => void; onComplete: () => void; onDeleteBox: (boxId: number) => void;
  onReopen: (boxId: number) => void; onConfirmModel: (useDetected: boolean) => void;
  onResolveUnknown: (normalized: string, action: 'MODEL' | 'SERIAL' | 'IGNORE') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { currentBox, completedBoxes, conflict } = snapshot;
  const handlers = useRef<BoxHandlers>({ onDeleteSerial, onDeleteBox, onReopen });
  handlers.current = { onDeleteSerial, onDeleteBox, onReopen };
  return <fieldset disabled={disabled} className="min-w-0 space-y-1">
    <div className="flex items-center justify-between"><p className="text-sm font-semibold">目前這箱</p><button type="button" className="min-h-11 text-xs text-[#68776e]" onClick={() => { if (window.confirm('清空目前這箱的型號、序號與待確認資料？')) onClear(); }}>清空目前這箱</button></div>
    <p aria-label="目前這箱設備數" className="text-xl font-semibold tabular-nums">{boxDeviceCount(currentBox)} 台</p>
    <p className="truncate text-xs">型號　{currentBox.model ? modelLabel(currentBox) : '尚未辨識'}{currentBox.model?.kind === 'MODEL_CANDIDATE' ? '（待確認品項）' : ''}</p>
    {currentBox.model && !currentBox.serials.length && <p className="text-xs text-[#68776e]">已辨識型號・尚未掃到序號</p>}
    <button type="button" aria-expanded={expanded} className="flex min-h-11 w-full items-center justify-between text-sm font-semibold" onClick={() => setExpanded(v => !v)}>已掃序號 {boxDeviceCount(currentBox)}<span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>
    {expanded && serialRows(currentBox, disabled, handlers)}
    {currentBox.unknown.length > 0 && <details className="text-xs text-amber-800"><summary className="min-h-9 cursor-pointer py-2">待確認條碼 {currentBox.unknown.length}</summary><ul className="max-h-32 overflow-y-auto">{currentBox.unknown.map(c => <li className="border-t border-amber-200 py-1" key={c.normalized}><p className="break-all">{c.raw}</p><div className="flex flex-wrap gap-3">{([['MODEL', '設為型號'], ['SERIAL', '設為序號'], ['IGNORE', '忽略']] as const).map(([action, label]) => <button key={action} type="button" className="min-h-11 font-semibold underline" onClick={() => onResolveUnknown(c.normalized, action)}>{label}</button>)}</div></li>)}</ul></details>}
    {conflict && <div role="alert" className="rounded-lg border border-amber-300 p-2 text-xs"><p>偵測到不同型號：{conflict.normalized}</p><p>請完成目前這箱，或確認型號後重新掃描序號。</p><div className="flex flex-wrap gap-3"><button type="button" className="min-h-11" onClick={() => onConfirmModel(false)}>保留目前型號</button><button type="button" className="min-h-11" onClick={() => onConfirmModel(true)}>確認型號 {conflict.normalized}</button></div></div>}
    <button type="button" disabled={!currentBox.serials.length} className="min-h-11 w-full rounded-lg border border-emerald-700 text-sm font-semibold text-emerald-800 disabled:opacity-40" onClick={onComplete}>完成這箱</button>
    <CompletedBoxHistory boxes={completedBoxes} disabled={disabled} handlers={handlers} />
  </fieldset>;
}
