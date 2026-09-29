'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraOff, ChevronDown, Flashlight, SwitchCamera, X } from 'lucide-react';
import { BarcodeCamera } from '@/lib/barcode-camera';
import { ScannerSession, scannerCounts, type ScannerCode, type ScannerKind } from '@/lib/receiving-scanner-session';
import type { InventoryItem } from '@/lib/db/types';

export interface BarcodeScannerProps { onDetected: (raw: string) => void; onBatch?: (codes: ScannerCode[]) => void | Promise<void>; items?: InventoryItem[]; initialCodes?: ScannerCode[]; onCodesChange?: (codes: ScannerCode[]) => void; warning?: string; onNoBarcode?: () => void; onCancel: () => void; initialMode?: 'camera' | 'manual'; initialValue?: string; mode?: 'single' | 'continuous'; onFinish?: () => void; children?: ReactNode }
const button = 'min-h-11 rounded-lg border border-white/40 px-4 py-2 disabled:opacity-50';
type ScanDiagnostic = { raw: string; session: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reason?: string; kinds: ScannerKind[] };

export function ScannerDiagnostics({ entries }: { entries: ScanDiagnostic[] }) {
  const rows = entries.length === 0 ? [{ raw: '等待解碼', session: 'PENDING' as const, kinds: [] }]
    : entries.length === 1 ? [...entries, { raw: '等待不同碼', session: 'PENDING' as const, kinds: [] }] : entries;
  return <details open className="mt-2 border-t border-[#d6ddd5] pt-1 text-xs text-[#303b35]">
    <summary className="min-h-9 cursor-pointer py-2 font-semibold">掃碼診斷 · {entries.length} 筆</summary>
    <div className="max-h-36 space-y-1 overflow-y-auto pb-2 font-mono tabular-nums">
      <p className="font-semibold">CAMERA DECODE</p>
      {rows.map((entry, index) => <p key={`decode-${index}`} className="break-all">{String(index + 1).padStart(2, '0')}　{entry.raw}</p>)}
      <p className="pt-1 font-semibold">SESSION</p>
      {rows.map((entry, index) => <p key={`session-${index}`} className="break-all">{String(index + 1).padStart(2, '0')}　{entry.session}{entry.reason ? ` / ${entry.reason}` : ''}</p>)}
      <p className="pt-1 font-semibold">CLASSIFY</p>
      {rows.map((entry, index) => <p key={`classify-${index}`}>{String(index + 1).padStart(2, '0')}　{entry.kinds.length ? Array.from(new Set(entry.kinds)).join(' / ') : '—'}</p>)}
    </div>
  </details>;
}

export function ScannerCaptureResults({ codes, expanded = false, onToggle }: { codes: ScannerCode[]; expanded?: boolean; onToggle?: () => void }) {
  const counts = scannerCounts(codes);
  const serials = codes.filter(code => code.kind === 'SERIAL');
  const models = codes.filter(code => code.kind === 'MODEL');
  const unknown = codes.filter(code => code.kind === 'UNKNOWN');
  return <div className="space-y-1 text-[#303b35]" aria-live="polite">
    <button type="button" className="flex min-h-11 w-full items-center justify-between text-left" aria-expanded={expanded} onClick={onToggle}>
      <span className="text-base font-semibold tabular-nums">已掃 {counts.serial} 台</span>
      <ChevronDown size={18} className={`text-[#61756a] transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    {expanded ? <ul className="max-h-32 space-y-1 overflow-y-auto text-sm" aria-label="已掃序號">{serials.map(code => <li key={code.normalized} className="break-all py-0.5 font-medium">{code.normalized}</li>)}</ul>
      : serials.length > 0 && <p className="truncate text-sm font-medium" aria-label="最新序號">{serials[serials.length - 1].normalized}</p>}
    {models.length > 0 && <p className="truncate text-xs text-[#68776e]"><span className="mr-2">型號</span>{models.map(code => code.normalized).join('、')}</p>}
    {unknown.length > 0 && <details className="pt-1 text-xs text-amber-800"><summary className="cursor-pointer py-1">待確認 {counts.unknown} ›</summary><ul className="max-h-20 space-y-1 overflow-y-auto pb-1">{unknown.map(code => <li key={code.normalized} className="break-all whitespace-pre-wrap">{code.raw}</li>)}</ul></details>}
  </div>;
}

export function BarcodeScanner({ onDetected, onBatch, items, initialCodes = [], onCodesChange, warning, onNoBarcode, onCancel, initialMode = 'camera', initialValue = '', mode = 'single', onFinish, children }: BarcodeScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const camera = useRef<BarcodeCamera>();
  const session = useRef<ScannerSession>();
  const [codes, setCodes] = useState<ScannerCode[]>(initialCodes);
  const [diagnostics, setDiagnostics] = useState<ScanDiagnostic[]>([]);
  const pendingCameraRaw = useRef<string>();
  const [flash, setFlash] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [inlineManual, setInlineManual] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const callbacks = useRef({ onDetected, onCancel });
  callbacks.current = { onDetected, onCancel };
  const batchCallback = useRef(onBatch); batchCallback.current = onBatch;
  const codesCallback = useRef(onCodesChange); codesCallback.current = onCodesChange;
  const itemsAtOpen = useRef(items);
  const initialCodesAtOpen = useRef(initialCodes);
  const [mounted, setMounted] = useState(false);
  const [manual, setManual] = useState(initialMode === 'manual');
  const [raw, setRaw] = useState(initialValue);
  const [cameraState, setCameraState] = useState('starting');
  const [message, setMessage] = useState('將條碼／QR 對準掃描框');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [torchTrack, setTorchTrack] = useState<MediaStreamTrack>();
  const cancel = () => { session.current?.dispose(); camera.current?.dispose(); callbacks.current.onCancel(); };

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted || !video.current) return;
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    if (batchCallback.current && itemsAtOpen.current) session.current = new ScannerSession(itemsAtOpen.current, batch => batchCallback.current?.(batch), next => { setCodes(next); codesCallback.current?.(next); }, 450, initialCodesAtOpen.current);
    const cameraSession = new BarcodeCamera(video.current, value => {
      const cameraRaw = pendingCameraRaw.current === value;
      pendingCameraRaw.current = undefined;
      const result = batchCallback.current && itemsAtOpen.current ? session.current?.addDetailed(value) : undefined;
      const added = result ? result.accepted : (callbacks.current.onDetected(value), true);
      if (cameraRaw && result) setDiagnostics(previous => previous.map(entry => entry.raw === value && entry.session === 'PENDING'
        ? { ...entry, session: result.accepted ? 'ACCEPTED' : 'REJECTED', reason: result.reason, kinds: result.classified.map(code => code.kind) }
        : entry));
      if (added) {
        try { navigator.vibrate?.(50); } catch { /* Optional feedback. */ }
        setFlash(true);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(false), 280);
      }
    }, (state, error) => {
      setCameraState(state);
      setReady(state === 'ready' || (mode === 'continuous' && state === 'success'));
      if (state !== 'ready' && !(mode === 'continuous' && state === 'success')) { setTorchTrack(undefined); setTorch(false); }
      if (error) console.error('[Scanner]', error);
      setMessage(({ starting: '將條碼／QR 對準掃描框', ready: '將條碼／QR 對準掃描框', stopped: '相機已暫停', success: '掃描成功', error: '無法使用相機' })[state]);
    }, stream => {
      const track = stream.getVideoTracks()[0];
      setDevice(track?.getSettings().deviceId || '');
      const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      setTorchTrack(capabilities?.torch ? track : undefined);
      navigator.mediaDevices.enumerateDevices().then(rows => {
        if (active) setDevices(rows.filter(row => row.kind === 'videoinput'));
      }).catch(() => { /* Scanning still works when enumeration is unavailable. */ });
    }, undefined, mode, (value, accepted) => {
      if (!batchCallback.current || !itemsAtOpen.current) return;
      if (accepted) pendingCameraRaw.current = value;
      setDiagnostics(previous => previous.some(entry => entry.raw === value) ? previous : [
        ...previous.slice(-5), { raw: value, session: accepted ? 'PENDING' : 'REJECTED',
          reason: accepted ? undefined : 'camera debounce', kinds: [] },
      ]);
    });
    camera.current = cameraSession;
    if (initialMode === 'camera') void cameraSession.start();
    const background = () => {
      if (document.hidden) { cameraSession.stop(); setCameraState('stopped'); setReady(false); setTorchTrack(undefined); setTorch(false); setMessage('相機已暫停'); }
    };
    const pagehide = () => { cameraSession.stop(); setCameraState('stopped'); setReady(false); setTorchTrack(undefined); setTorch(false); setMessage('相機已暫停'); };
    document.addEventListener('visibilitychange', background);
    window.addEventListener('pagehide', pagehide);
    return () => {
      active = false; cameraSession.dispose(); session.current?.dispose(); session.current = undefined; camera.current = undefined; clearTimeout(flashTimer.current);
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('pagehide', pagehide);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [mounted, initialMode, mode]);

  if (!mounted) return null;
  if (onBatch) return createPortal(<div className="fixed inset-0 z-[200] bg-black" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="實際到貨掃描" data-scanner-state={cameraState === 'error' ? 'ERROR' : 'READY'}
      className="flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-black outline-none sm:mx-auto sm:max-w-lg sm:shadow-2xl">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video ref={video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-contain" aria-label="相機預覽" />
        {cameraState === 'error' ? <div className="absolute inset-0 flex items-center justify-center text-white/60"><CameraOff size={48} strokeWidth={1.25} aria-hidden="true" /></div>
          : <div aria-hidden="true" className={`pointer-events-none absolute inset-x-[7%] top-[22%] h-[56%] rounded-2xl border-2 transition-colors duration-200 ${flash ? 'border-emerald-300' : 'border-white/60'}`} />}
        <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/75 to-transparent px-3 pb-5 text-white" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
          <button type="button" aria-label="取消掃描" className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30" onClick={cancel}><X size={22} /></button>
          <h2 className="text-base font-semibold">實際到貨</h2>
          <button type="button" aria-label="補光" title="補光" disabled={!ready || !torchTrack} aria-pressed={torch} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 disabled:opacity-40" onClick={async () => {
            if (!torchTrack) return;
            try { await torchTrack.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); }
            catch { setMessage('無法開啟補光'); }
          }}><Flashlight size={19} aria-hidden="true" /></button>
        </header>
        {devices.length > 1 && <button type="button" aria-label="切換鏡頭" title="切換鏡頭" className="absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white" onClick={() => {
          const index = devices.findIndex(row => row.deviceId === device);
          const next = devices[(index + 1) % devices.length];
          if (next) { setDevice(next.deviceId); void camera.current?.start(next.deviceId); }
        }}><SwitchCamera size={19} aria-hidden="true" /></button>}
        {(cameraState === 'error' || cameraState === 'stopped') && <div className="absolute inset-x-4 bottom-4 flex items-center justify-between gap-2 rounded-lg bg-black/75 px-3 py-2 text-xs text-white"><span>{message}</span><button type="button" className="min-h-11 shrink-0 font-semibold text-emerald-300" onClick={() => void camera.current?.start()}>重試</button></div>}
        <p role="status" className="sr-only">{message}</p>
      </div>
      <div className="flex max-h-[43dvh] shrink-0 flex-col rounded-t-xl bg-[#f8f7f3] text-[#303b35]" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <div className="min-h-0 overflow-y-auto px-4 pt-2"><ScannerCaptureResults codes={codes} expanded={expanded} onToggle={() => setExpanded(value => !value)} />
          <ScannerDiagnostics entries={diagnostics} />
          {warning && <p role="alert" className="mt-1 text-xs text-amber-800">{warning}</p>}
          {inlineManual && <form className="mt-2 flex items-end gap-2" onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!raw.trim()) return; camera.current?.accept(raw); setRaw(''); setInlineManual(false); }}>
            <label className="min-w-0 flex-1 text-xs text-[#68776e]">序號<input ref={input} autoFocus autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={raw} onChange={event => setRaw(event.target.value)} className="mt-1 h-11 w-full rounded-lg bg-white px-3 text-base text-[#303b35] outline-none ring-1 ring-[#d6ddd5] focus:ring-emerald-600" /></label>
            <button type="submit" disabled={!raw.trim()} className="h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-40">加入</button>
          </form>}
          {!inlineManual && <button type="button" className="min-h-11 text-sm font-medium text-emerald-800" onClick={() => setInlineManual(true)}>＋ 手動輸入序號</button>}
        </div>
        <div className="shrink-0 px-4 pt-1"><button type="button" className="min-h-12 w-full rounded-lg bg-emerald-700 px-4 text-base font-semibold text-white" onClick={() => { camera.current?.dispose(); session.current?.flush(); (onFinish || onCancel)(); }}>完成掃描</button>
          {onNoBarcode && scannerCounts(codes).serial === 0 && <button type="button" className="mt-1 min-h-11 w-full text-center text-xs text-[#68776e]" onClick={() => { camera.current?.dispose(); session.current?.dispose(); onNoBarcode(); }}>無條碼物料</button>}
        </div>
      </div>
    </section>
  </div>, document.body);
  return createPortal(<div className={`fixed inset-0 z-[200] flex justify-center bg-black/80 text-white sm:items-center sm:p-4 ${manual ? 'items-start pt-[max(1rem,env(safe-area-inset-top))]' : 'items-center'}`} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    if (event.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:enabled,input:enabled,select:enabled');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="掃描序號" data-scanner-state={manual ? 'MANUAL' : cameraState === 'error' ? 'ERROR' : 'READY'}
      className={`flex w-full min-w-0 max-w-lg flex-col overflow-hidden outline-none bg-slate-950 shadow-2xl sm:rounded-2xl ${manual ? 'mx-3 max-h-[calc(100dvh-1.5rem)] rounded-2xl' : 'h-[100dvh] sm:h-[min(42rem,calc(100dvh-2rem))]'}`}
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
      <header className="flex shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="text-lg font-semibold">掃描序號</h2>
        <button type="button" className="min-h-11 min-w-11 rounded-lg px-3 text-sm text-slate-300 hover:bg-white/10" onClick={cancel}>取消</button>
      </header>
      {children && <div className="max-h-40 shrink-0 overflow-y-auto px-4 py-2 text-sm" aria-live="polite">{children}</div>}
      <p role="status" className="shrink-0 px-4 py-2 text-sm text-slate-300">{manual ? '手動輸入序號' : message}</p>
      <div className={`relative mx-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-black ${manual ? 'hidden' : ''}`}>
        <video ref={video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-contain" aria-label="相機預覽" />
        {cameraState === 'error' ? <div className="absolute inset-0 flex items-center justify-center text-slate-500"><CameraOff size={48} strokeWidth={1.25} aria-hidden="true" /></div>
          : <div aria-hidden="true" className={`pointer-events-none absolute inset-x-[6%] top-[22%] h-[56%] rounded-2xl border-2 transition-colors duration-200 ${flash ? 'border-teal-300' : 'border-white/60'}`} />}
      </div>
      {manual ? <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); camera.current?.accept(raw); if (mode === 'continuous') { setRaw(''); input.current?.focus(); } }} className="overflow-y-auto px-4 pb-1 pt-3">
        <label htmlFor="scanner-serial" className="mb-2 block text-sm font-medium">序號</label>
        <div className="flex min-w-0 items-center rounded-xl border border-slate-600 bg-slate-900 focus-within:border-teal-400">
          <input ref={input} id="scanner-serial" autoFocus autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={raw} onChange={event => setRaw(event.target.value)} className="min-h-12 min-w-0 flex-1 bg-transparent px-3 text-base outline-none" />
          <button type="button" disabled={!raw} className="min-h-11 shrink-0 px-3 text-sm text-slate-300 disabled:opacity-30" onClick={() => { setRaw(''); input.current?.focus(); }}>清除</button>
        </div>
        <button className="mt-4 min-h-12 w-full rounded-xl bg-teal-400 px-4 font-semibold text-slate-950 disabled:opacity-40" type="submit" disabled={!raw.trim()}>確認</button>
        <button type="button" className="mt-2 min-h-11 w-full text-sm text-slate-300" onClick={() => { setManual(false); void camera.current?.start(); }}>返回掃描</button>
      </form> : <footer className="shrink-0 px-3 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          {devices.length > 1 && <label className="flex min-w-0 max-w-40 items-center gap-1 rounded-lg border border-white/20 px-2 text-xs text-slate-300"><SwitchCamera size={16} className="shrink-0" aria-hidden="true" /><select aria-label="切換鏡頭" className="min-h-11 min-w-0 flex-1 truncate bg-slate-950" value={device} onChange={event => { setDevice(event.target.value); void camera.current?.start(event.target.value); }}>
            {devices.map((row, index) => <option key={row.deviceId} value={row.deviceId}>{row.label || `鏡頭 ${index + 1}`}</option>)}
          </select></label>}
          {ready && torchTrack && <button type="button" aria-label="補光" title="補光" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/20" aria-pressed={torch} onClick={async () => {
            try { await torchTrack.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); }
            catch { setMessage('無法開啟補光'); }
          }}><Flashlight size={18} aria-hidden="true" /></button>}
          <div className="flex-1" />
          {(cameraState === 'error' || cameraState === 'stopped') && <button type="button" className="min-h-11 rounded-lg px-2 text-sm text-slate-200" onClick={() => { void camera.current?.start(); }}>重試</button>}
          <button type="button" className="min-h-11 rounded-lg px-2 text-sm text-slate-200" onClick={() => { camera.current?.stop(); setReady(false); setTorchTrack(undefined); setManual(true); }}>手動輸入</button>
        </div>
      </footer>}
      {mode === 'continuous' && <button type="button" className="mx-3 mt-2 min-h-12 shrink-0 rounded-xl bg-teal-400 px-4 font-semibold text-slate-950" onClick={() => { camera.current?.dispose(); session.current?.flush(); (onFinish || onCancel)(); }}>完成掃描</button>}
    </section>
  </div>, document.body);
}
