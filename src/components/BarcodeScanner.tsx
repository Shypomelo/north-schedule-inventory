'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraOff } from 'lucide-react';
import { BarcodeCamera } from '@/lib/barcode-camera';

export interface BarcodeScannerProps { onDetected: (raw: string) => void; onCancel: () => void; initialMode?: 'camera' | 'manual'; initialValue?: string; mode?: 'single' | 'continuous'; onFinish?: () => void; children?: ReactNode }
const button = 'min-h-11 rounded-lg border border-white/40 px-4 py-2 disabled:opacity-50';

export function BarcodeScanner({ onDetected, onCancel, initialMode = 'camera', initialValue = '', mode = 'single', onFinish, children }: BarcodeScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const camera = useRef<BarcodeCamera>();
  const callbacks = useRef({ onDetected, onCancel });
  callbacks.current = { onDetected, onCancel };
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
  const cancel = () => { camera.current?.dispose(); callbacks.current.onCancel(); };

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted || !video.current) return;
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const session = new BarcodeCamera(video.current, value => {
      try { navigator.vibrate?.(60); } catch { /* Optional feedback. */ }
      callbacks.current.onDetected(value);
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
    camera.current = session;
    if (initialMode === 'camera') void session.start();
    const background = () => {
      if (document.hidden) { session.stop(); setCameraState('stopped'); setReady(false); setTorchTrack(undefined); setTorch(false); setMessage('相機已暫停'); }
    };
    const pagehide = () => { session.stop(); setCameraState('stopped'); setReady(false); setTorchTrack(undefined); setTorch(false); setMessage('相機已暫停'); };
    document.addEventListener('visibilitychange', background);
    window.addEventListener('pagehide', pagehide);
    return () => {
      active = false; session.dispose(); camera.current = undefined;
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('pagehide', pagehide);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [mounted, initialMode, mode]);

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
      {children && <div className="max-h-40 shrink-0 overflow-y-auto px-4 py-2 text-sm" aria-live="polite">{children}</div>}
      <p role="status" className="flex min-h-10 shrink-0 items-center px-4 pb-2 text-sm text-slate-300">{manual ? '手動輸入序號' : message}</p>
      <div className={`relative mx-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-black ${manual ? 'hidden' : ''}`}>
        <video ref={video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-contain" aria-label="相機預覽" />
        {cameraState === 'error' ? <div className="absolute inset-0 flex items-center justify-center text-slate-500"><CameraOff size={48} strokeWidth={1.25} aria-hidden="true" /></div>
          : <div aria-hidden="true" className="pointer-events-none absolute inset-x-[8%] top-1/3 h-1/3 rounded-2xl border-2 border-white/70" />}
      </div>
      {manual ? <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); camera.current?.accept(raw); if (mode === 'continuous') { setRaw(''); input.current?.focus(); } }} className="overflow-y-auto px-4 pb-1 pt-3">
        <label htmlFor="scanner-serial" className="mb-2 block text-sm font-medium">序號</label>
        <div className="flex min-w-0 items-center rounded-xl border border-slate-600 bg-slate-900 focus-within:border-teal-400">
          <input ref={input} id="scanner-serial" autoFocus autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={raw} onChange={event => setRaw(event.target.value)} className="min-h-12 min-w-0 flex-1 bg-transparent px-3 text-base outline-none" />
          <button type="button" disabled={!raw} className="min-h-11 shrink-0 px-3 text-sm text-slate-300 disabled:opacity-30" onClick={() => { setRaw(''); input.current?.focus(); }}>清除</button>
        </div>
        <button className="mt-4 min-h-12 w-full rounded-xl bg-teal-400 px-4 font-semibold text-slate-950 disabled:opacity-40" type="submit" disabled={!raw.trim()}>確認</button>
        <button type="button" className="mt-2 min-h-11 w-full text-sm text-slate-300" onClick={() => { setManual(false); void camera.current?.start(); }}>返回掃描</button>
      </form> : <footer className="shrink-0 space-y-2 px-3 pt-3">
        {(devices.length > 1 || (ready && torchTrack)) && <div className="flex min-w-0 gap-2">
          {devices.length > 1 && <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/20 px-3 text-sm"><span className="shrink-0">切換鏡頭</span><select aria-label="切換鏡頭" className="min-h-11 min-w-0 flex-1 truncate bg-slate-950" value={device} onChange={event => { setDevice(event.target.value); void camera.current?.start(event.target.value); }}>
            {devices.map((row, index) => <option key={row.deviceId} value={row.deviceId}>{row.label || `鏡頭 ${index + 1}`}</option>)}
          </select></label>}
          {ready && torchTrack && <button type="button" className={button} aria-pressed={torch} onClick={async () => {
            try { await torchTrack.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); }
            catch { setMessage('無法開啟補光'); }
          }}>補光</button>}
        </div>}
        <div className="flex gap-2">
          {(cameraState === 'error' || cameraState === 'stopped') && <button type="button" className={`${button} flex-1`} onClick={() => { void camera.current?.start(); }}>重新嘗試</button>}
          <button type="button" className="min-h-12 flex-1 rounded-xl bg-white px-4 font-semibold text-slate-950" onClick={() => { camera.current?.stop(); setReady(false); setTorchTrack(undefined); setManual(true); }}>手動輸入</button>
        </div>
      </footer>}
      {mode === 'continuous' && <button type="button" className="mx-3 mt-3 min-h-12 shrink-0 rounded-xl bg-teal-400 px-4 font-semibold text-slate-950" onClick={() => { camera.current?.dispose(); (onFinish || onCancel)(); }}>完成掃描</button>}
    </section>
  </div>, document.body);
}
