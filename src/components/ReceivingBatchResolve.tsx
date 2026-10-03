'use client';

import { useState } from 'react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import type { ReceivedGroup, ReceivingV6Snapshot } from '@/lib/receiving-v6';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { useReceivingItems } from './useReceivingItems';
import { ActionError, useV5Action, useV5Request, v5Primary } from './ReceivingV5Forms';

export function ReceivingBatchResolve({ group, data: initialData, api, onChanged }: {
  group: ReceivedGroup; data: ReceivingV6Snapshot; api: ReceivingV6Api; onChanged: () => Promise<boolean>;
}) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const unresolved = group.rows.filter(row => row.state === 'UNRESOLVED' && row.line);
  const [selected, setSelected] = useState<string[]>([]);
  const [itemId, setItemId] = useState('');
  const action = useV5Action(), request = useV5Request();
  const item = data.items.find(value => value.id === itemId);
  return <section className="space-y-3" aria-label="批次補品項">
    <p className="text-sm font-semibold">待補資料 · {unresolved.reduce((sum, row) => sum + (group.remainingByLine[row.line!.id] || 0), 0)} 台</p>
    <div className="max-h-60 divide-y divide-theme-border overflow-y-auto rounded-lg border border-theme-border">
      {unresolved.map(row => <label key={row.line!.id} className="flex min-h-10 items-center gap-2 px-2 py-1 text-sm">
        <input type="checkbox" checked={selected.includes(row.line!.id)} disabled={action.busy}
          onChange={event => setSelected(ids => event.target.checked ? [...ids, row.line!.id] : ids.filter(id => id !== row.line!.id))} />
        <span className="min-w-0 flex-1 break-all">{row.observations.map(entry => entry.normalized_serial).join('、') || `待補資料 · ${row.quantity}`}</span>
      </label>)}
    </div>
    <InventoryItemCombobox items={data.items.filter(value => value.is_active && value.requires_serial)} value={itemId}
      onCreate={createItem} serialRequirement onChange={setItemId} />
    <ActionError message={action.error} />
    <button type="button" className={v5Primary + ' w-full'} disabled={action.busy || !item?.requires_serial || !selected.length}
      onClick={() => void action.run(async () => {
        if (!item?.requires_serial || !selected.length) throw new Error('請選擇序號與品項。');
        await api.completeBatch(request({ p_line_ids: [...selected].sort(), p_item_id: item.id }));
        if (!await onChanged()) throw new Error('補資料已送出，但重新讀取失敗；請重新整理。');
      })}>套用到已選 {selected.length} 台</button>
  </section>;
}
