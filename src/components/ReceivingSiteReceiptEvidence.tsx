'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/db/supabaseClient';
import { receivingSiteEvidence } from '@/lib/db/receiving-project-tracking';
import { receivingError } from '@/lib/receiving-v5';

export function ReceivingSiteReceiptEvidence({ receiptId, transactionId }: { receiptId: string; transactionId: string }) {
  const [evidence, setEvidence] = useState<Awaited<ReturnType<typeof receivingSiteEvidence>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; setEvidence(null); setError('');
    void receivingSiteEvidence(supabase, receiptId, transactionId).then(value => { if (!cancelled) setEvidence(value); }).catch(e => { if (!cancelled) setError(receivingError(e)); });
    return () => { cancelled = true; };
  }, [receiptId, transactionId]);
  return <div className="mt-2 space-y-2 text-xs text-secondary" aria-label="案場送達來源與序號">
    {error ? <p role="alert">無法載入送達來源：{error}</p> : !evidence ? <p role="status">載入送達序號…</p> : <>
      <p>來源：北辦庫存出庫</p>
      {evidence.officeReceiptIds.map(id => <p className="break-all" key={id}>原收貨紀錄：{id}</p>)}
      {evidence.serials.length > 0 && <details><summary className="cursor-pointer py-2 text-accent">查看送達序號（{evidence.serials.length}）</summary><ul className="max-h-44 overflow-y-auto">{evidence.serials.map((serial, i) => <li className="break-all py-1" key={serial + i}>{serial}</li>)}</ul></details>}
    </>}
  </div>;
}
