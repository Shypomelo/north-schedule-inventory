'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraOff, Flashlight, SwitchCamera } from 'lucide-react';
import { BarcodeCamera } from '@/lib/barcode-camera';
import { ScannerSession, scannerCounts, type ScannerCode } from '@/lib/receiving-scanner-session';
import type { InventoryItem } from '@/lib/db/types';

export interface BarcodeScannerProps { onDetected: (raw: string) => void; onBatch?: (codes: ScannerCode[]) => void | Promise<void>; items?: InventoryItem[]; warning?: string; onCancel: () => void; initialMode?: 'camera' | 'manual'; initialValue?: string; mode?: 'single' | 'continuous'; onFinish?: () => void; children?: ReactNode }
const button = 'min-h-11 rounded-lg border border-white/40 px-4 py-2 disabled:opacity-50';

export function ScannerCaptureResults({ codes }: { codes: ScannerCode[] }) {
  const counts = scannerCounts(codes);
  const recognized = codes.filter(code => code.kind !== 'UNKNOWN');
  const unknown = codes.filter(code => code.kind === 'UNKNOWN');
  return <div className="shrink-0 space-y-2 px-4 py-2" aria-live="polite">
    <div className="flex flex-wrap gap-1.5 text-xs" aria-label="掃描統計">
      <span className="rounded-full bg-white/15 px-2.5 py-1 font-semibold">已掃描 {counts.total}</span>
      <span className="rounded-full bg-teal-400/15 px-2.5 py-1 text-teal-200">型號 {counts.model}</span>
      <span className="rounded-full bg-sky-400/15 px-2.5 py-1 text-sky-200">序號 {counts.serial}</span>
      <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-amber-200">待確認 {counts.unknown}</span>
    </div>
    {!!recognized.length && <ul className="max-h-24 space-y-1 overflow-y-auto text-xs" aria-label="掃描結果">{recognized.map(code => <li key={code.normalized} className="flex min-w-0 gap-2 rounded-lg bg-white/10 px-2.5 py-1.5"><span className="w-8 shrink-0 text-slate-400">{code.kind === 'MODEL' ? '型號' : '序號'}</span><span className="min-w-0 break-all font-medium">{code.normalized}</span></li>)}</ul>}
    {!!unknown.length && <details className="rounded-lg border border-amber-400/25 bg-amber-400/5 text-xs"><summary className="cursor-pointer px-2.5 py-2 text-amber-200">待確認 {unknown.length} 筆 ›</summary><ul className="max-h-24 space-y-2 overflow-y-auto px-2.5 pb-2">{unknown.map(code => <li key={code.normalized} className="break-all whitespace-pre-wrap text-slate-300">{code.raw}</li>)}</ul></details>}
  </div>;
}

export function BarcodeScanner({ onDetected, onBatch, items, warning, onCancel, initialMode = 'camera', initialValue = '', mode = 'single', onFinish, children }: BarcodeScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const camera = useRef<BarcodeCamera>();
  const session = useRef<ScannerSession>();
  const [codes, setCodes] = useState<ScannerCode[]>([]);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const callbacks = useRef({ onDetected, onCancel });
  callbacks.current = { onDetected, onCancel };
  const batchCallback = useRef(onBatch); batchCallback.current = onBatch;
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
    if (batchCallback.current && items) session.current = new ScannerSession(items, batch => batchCallback.current?.(batch), setCodes);
    const cameraSession = new BarcodeCamera(video.current, value => {
      const added = batchCallback.current && items ? session.current?.add(value) : (callbacks.current.onDetected(value), true);
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
    }, undefined, mode);
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
  }, [mounted, initialMode, mode, items]);

  if (!mounted) return null;
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
      {onBatch ? <ScannerCaptureResults codes={codes} /> : children && <div className="max-h-40 shrink-0 overflow-y-auto px-4 py-2 text-sm" aria-live="polite">{children}</div>}
      {warning && onBatch && <p role="alert" className="mx-4 mb-1 rounded-lg bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200">{warning}</p>}
      <p role="status" className={onBatch && !manual && cameraState !== 'error' && cameraState !== 'stopped' ? 'sr-only' : 'shrink-0 px-4 py-2 text-sm text-slate-300'}>{manual ? '手動輸入序號' : message}</p>
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
