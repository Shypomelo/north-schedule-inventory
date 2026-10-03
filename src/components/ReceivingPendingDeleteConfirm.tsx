'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { receivingError } from '@/lib/receiving-v5';
import { ActionError, v5Button } from './ReceivingV5Forms';

type PendingDeleteTarget = {
  key: string; label: string;
  source: { type: 'PROJECT_MATERIAL' | 'SE_SUPPLY'; id: string; updatedAt: string };
};

function deleteError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('PENDING_DELETE_REFRESH_FAILED')) return '刪除已提交，但清單重新整理失敗，請重新整理。';
  if (message.includes('PENDING_DELETE_EDITOR_REQUIRED')) return '目前沒有刪除此筆待收貨的權限。';
  if (['PENDING_DELETE_DOWNSTREAM_EXISTS', 'PENDING_DELETE_VERSION_CONFLICT', 'PENDING_DELETE_INACTIVE',
    'PENDING_DELETE_REQUEST_CONFLICT'].some(code => message.includes(code))) return receivingError(error);
  return '無法刪除此筆待收貨，請重新整理後重試。';
}

export function ReceivingPendingDeleteConfirm({ target, api, onClose, onDeleted }: {
  target: PendingDeleteTarget; api: ReceivingV6Api; onClose: () => void; onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), requestId = useRef<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !locked.current) { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pending-delete-dialog] button:not(:disabled)'));
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  const submit = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      requestId.current ??= crypto.randomUUID();
      const result = await api.deletePending({ p_request_id: requestId.current, p_source_type: target.source.type,
        p_source_id: target.source.id, p_expected_updated_at: target.source.updatedAt });
      if (result.outcome !== 'DELETED' || result.id !== target.source.id || result.inventory_effect !== 0) throw new Error('PENDING_DELETE_UNEXPECTED_RESULT');
      await onDeleted();
    } catch (cause) { setError(deleteError(cause)); }
    finally { locked.current = false; setBusy(false); }
  };
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
    <div data-pending-delete-dialog role="alertdialog" aria-modal="true" aria-label="刪除待收貨" aria-busy={busy}
      className="w-full max-w-sm rounded-xl border border-theme-border bg-card p-4 shadow-xl sm:p-5">
      <h2 className="text-base font-bold">確定刪除此筆待收貨？</h2>
      <p className="mt-2 break-words text-sm font-medium">{target.label}</p>
      <p className="mt-2 text-sm text-secondary">此操作只適用於尚未產生到貨或後續紀錄的待收項目。</p>
      <div className="mt-3"><ActionError message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <button ref={cancel} type="button" className={v5Button} disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className={v5Button + ' border-danger bg-danger text-white'} disabled={busy} onClick={() => void submit()}>{busy ? '刪除中…' : '刪除'}</button>
      </div>
    </div>
  </div>, document.body);
}
