export type BarcodeDecoderBackend = 'BarcodeDetector' | 'ZXing multi-region';
export interface BarcodeFrameDiagnostic {
  backend: BarcodeDecoderBackend;
  attempts: number;
  decodedCount: number;
  rawValues: string[];
  latencyMs: number;
  accumulatedUniqueCount: number;
}
export type BarcodeDecodeSource = HTMLVideoElement | HTMLCanvasElement;
export type Decoder = { decode(source: BarcodeDecodeSource): string[]; decode1D?(source: BarcodeDecodeSource): string[]; decode2D?(source: BarcodeDecodeSource): string[] };
type NativeDetector = { detect(video: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type NativeDetectorConstructor = {
  new(options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
};
type CameraState = 'starting' | 'ready' | 'stopped' | 'success' | 'error';
interface CameraDependencies {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  loadDecoder(): Promise<Decoder>;
  createCanvas?(): HTMLCanvasElement;
  now?(): number;
  schedule?(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearSchedule?(timer: ReturnType<typeof setTimeout>): void;
}

interface DecodeRegion { id: string; x: number; y: number; width: number; height: number }
export const FALLBACK_DECODE_REGIONS: readonly DecodeRegion[] = [
  { id: 'upper', x: 0, y: 0, width: 1, height: 0.5 },
  { id: 'center', x: 0, y: 0.25, width: 1, height: 0.5 },
  { id: 'lower', x: 0, y: 0.5, width: 1, height: 0.5 },
  { id: 'left', x: 0, y: 0, width: 0.58, height: 1 },
  { id: 'right', x: 0.42, y: 0, width: 0.58, height: 1 },
  { id: 'upper-left', x: 0, y: 0, width: 0.55, height: 0.55 },
  { id: 'upper-right', x: 0.45, y: 0, width: 0.55, height: 0.55 },
  { id: 'lower-left', x: 0, y: 0.45, width: 0.55, height: 0.55 },
  { id: 'lower-right', x: 0.45, y: 0.45, width: 0.55, height: 0.55 },
];

const rawKey = (value: string) => value.trim();
export function dedupeDecodedValues(values: readonly string[]) {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = rawKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Decode one bounded fallback cycle: one 1D ROI, plus a periodic 2D full frame. */
export function decodeFallbackFrame(video: HTMLVideoElement, decoder: Decoder,
  canvas: HTMLCanvasElement | undefined, attempt: number) {
  const values: string[] = [];
  const legacy = !decoder.decode1D && !decoder.decode2D;
  const oneDimensional = decoder.decode1D?.bind(decoder) || decoder.decode.bind(decoder);
  const twoDimensional = decoder.decode2D?.bind(decoder) || decoder.decode.bind(decoder);
  if (legacy) try { values.push(...decoder.decode(video)); } catch { /* Keep the ROI pass. */ }
  const width = video.videoWidth || 0, height = video.videoHeight || 0;
  if (!canvas || !width || !height) {
    if (!legacy) try { values.push(...oneDimensional(video)); } catch { /* Keep the camera running. */ }
    if (decoder.decode2D && attempt % 3 === 0) try { values.push(...twoDimensional(video)); } catch { /* Keep the 1D result. */ }
    return dedupeDecodedValues(values);
  }
  const region = FALLBACK_DECODE_REGIONS[attempt % FALLBACK_DECODE_REGIONS.length];
  const sx = Math.floor(width * region.x), sy = Math.floor(height * region.y);
  const sw = Math.max(1, Math.floor(width * region.width)), sh = Math.max(1, Math.floor(height * region.height));
  try {
    canvas.width = sw; canvas.height = sh;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.clearRect(0, 0, sw, sh);
      context.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      values.push(...oneDimensional(canvas));
    }
  } catch { /* Continue with the next scheduled ROI. */ }
  if (!legacy && attempt % 3 === 0) try { values.push(...twoDimensional(video)); } catch { /* Keep the ROI result. */ }
  return dedupeDecodedValues(values);
}

const dependencies: CameraDependencies = {
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  async loadDecoder() {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType, NotFoundException, ChecksumException, FormatException }] = await Promise.all([
      import('@zxing/browser'), import('@zxing/library'),
    ]);
    const hints = (formats: number[]) => new Map([[DecodeHintType.POSSIBLE_FORMATS, formats]]);
    const oneDimensional = new BrowserMultiFormatReader(hints([
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13,
    ]));
    const twoDimensional = new BrowserMultiFormatReader(hints([
      BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
    ]));
    const decodeWith = (reader: InstanceType<typeof BrowserMultiFormatReader>, source: BarcodeDecodeSource) => {
      try {
        const isCanvas = typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement;
        const result = isCanvas
          ? reader.decodeFromCanvas(source as HTMLCanvasElement)
          : reader.decode(source as HTMLVideoElement);
        return result ? [result.getText()] : [];
      }
      catch (cause) {
        // constructor.name is not stable after bundling/minification.
        if (cause instanceof NotFoundException || cause instanceof ChecksumException || cause instanceof FormatException) return [];
        throw cause;
      }
    };
    return { decode: source => decodeWith(oneDimensional, source),
      decode1D: source => decodeWith(oneDimensional, source),
      decode2D: source => decodeWith(twoDimensional, source) };

  },
};

// Own the stream and decode timer together. Every async boundary checks its generation.
// ZXing's synchronous decode only uses transient client-side pixels; nothing is saved or sent.
export class BarcodeCamera {
  private generation = 0;
  private disposed = false;
  private detected = false;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private lastCode = '';
  private lastDetectedAt = 0;
  private decoding = false;
  private decodeAttempts = 0;
  private roiCanvas?: HTMLCanvasElement;
  private cameraValues = new Set<string>();
  private observedValues = new Set<string>();

  constructor(private video: HTMLVideoElement, private onDetected: (raw: string) => void,
    private onState: (state: CameraState, message?: string) => void,
    private onStream: (stream: MediaStream) => void,
    private deps: CameraDependencies = dependencies,
    private mode: 'single' | 'continuous' = 'single',
    private onCameraDecode?: (raw: string, accepted: boolean) => void,
    private onFrameDecode?: (diagnostic: BarcodeFrameDiagnostic) => void) {}

  private clearTimer() {
    if (this.timer === undefined) return;
    if (this.deps.clearSchedule) this.deps.clearSchedule(this.timer); else clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(callback: () => void) {
    this.timer = this.deps.schedule ? this.deps.schedule(callback, 160) : setTimeout(callback, 160);
  }

  stop() {
    this.generation++;
    this.decoding = false;
    this.clearTimer();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
  }

  dispose() { this.disposed = true; this.stop(); }

  /** A completed box starts a fresh raw-code scope without touching the stream or decoder. */
  beginBox() { this.cameraValues.clear(); this.observedValues.clear(); this.lastCode = ''; this.lastDetectedAt = 0; }

  accept(raw: string, source: 'manual' | 'camera' = 'manual') {
    if (this.disposed || this.detected || !raw.trim()) return;
    if (this.mode === 'continuous') {
      const now = Date.now();
      const key = rawKey(raw);
      const repeated = this.cameraValues.has(key) || (raw === this.lastCode && now - this.lastDetectedAt < 1200);
      this.lastCode = raw; this.lastDetectedAt = now;
      if (repeated) { if (source === 'camera') this.onCameraDecode?.(raw, false); return; }
      if (source === 'camera') this.cameraValues.add(key);
    } else { this.detected = true; this.stop(); }
    if (source === 'camera') this.onCameraDecode?.(raw, true);
    this.onState('success');
    this.onDetected(raw);
  }

  async start(deviceId?: string) {
    if (this.disposed || this.detected) return;
    this.stop();
    const generation = this.generation;
    const active = () => !this.disposed && !this.detected && generation === this.generation;
    this.onState('starting');
    try {
      const stream = await this.deps.getUserMedia({ audio: false, video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!active()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.video.srcObject = stream;
      // Native detection returns every visible code. ZXing remains the fallback on iOS
      // and browsers without a supported BarcodeDetector implementation.
      const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
      let native = Detector ? await (async () => {
        try {
          const formats = await Detector.getSupportedFormats();
          const supported = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'].filter(format => formats.includes(format));
          return supported.length ? new Detector({ formats: supported }) : undefined;
        } catch { return undefined; }
      })() : undefined;
      let decoder = native ? undefined : await this.deps.loadDecoder();
      if (!active()) return;
      await this.video.play();
      if (!active()) return;
      this.onStream(stream);
      this.onState('ready');
      const decode = async () => {
        if (!active()) return;
        if (this.decoding) return;
        this.decoding = true;
        const startedAt = this.deps.now?.() ?? performance.now();
        const backend: BarcodeDecoderBackend = native ? 'BarcodeDetector' : 'ZXing multi-region';
        const attempt = this.decodeAttempts++;
        let values: string[] = [];
        try {
          if (this.video.readyState >= 2) {
            if (native) values = dedupeDecodedValues((await native.detect(this.video)).map(result => result.rawValue));
            else {
              if (!this.roiCanvas && this.video.videoWidth && this.video.videoHeight)
                this.roiCanvas = this.deps.createCanvas?.() ?? document.createElement('canvas');
              values = decodeFallbackFrame(this.video, decoder!, this.roiCanvas, attempt);
            }
          }
        }
        catch {
          this.decoding = false;
          if (!active()) return;
          this.onFrameDecode?.({ backend, attempts: this.decodeAttempts, decodedCount: 0, rawValues: [],
            latencyMs: Math.max(0, Math.round(((this.deps.now?.() ?? performance.now()) - startedAt) * 10) / 10),
            accumulatedUniqueCount: this.observedValues.size });
          if (native) {
            native = undefined;
            try { decoder = await this.deps.loadDecoder(); }
            catch { this.stop(); this.onState('error', '\u8fa8\u8b58\u5931\u6557\uff0c\u8acb\u91cd\u8a66\u6216\u624b\u52d5\u8f38\u5165\u3002'); return; }
            if (active()) this.schedule(() => { void decode(); });
            return;
          }
          if (active()) this.schedule(() => { void decode(); });
          return;
        }
        this.decoding = false;
        if (!active()) return;
        values.map(rawKey).filter(Boolean).forEach(value => this.observedValues.add(value));
        this.onFrameDecode?.({ backend, attempts: this.decodeAttempts, decodedCount: values.length, rawValues: values,
          latencyMs: Math.max(0, Math.round(((this.deps.now?.() ?? performance.now()) - startedAt) * 10) / 10),
          accumulatedUniqueCount: this.observedValues.size });
        for (const raw of values) if (raw?.trim()) this.accept(raw, 'camera');
        if (active()) this.schedule(() => { void decode(); });
      };
      void decode();
    } catch (cause) {
      if (!active()) return;
      this.stop();
      this.onState('error', (cause as Error).name === 'NotAllowedError'
        ? '\u672a\u53d6\u5f97\u76f8\u6a5f\u6b0a\u9650\uff0c\u8acb\u5141\u8a31\u76f8\u6a5f\u5f8c\u91cd\u8a66\uff0c\u6216\u624b\u52d5\u8f38\u5165\u3002'
        : '\u76f8\u6a5f\u7121\u6cd5\u4f7f\u7528\uff0c\u8acb\u78ba\u8a8d HTTPS\u3001\u93e1\u982d\u9023\u7dda\u53ca\u5176\u4ed6\u7a0b\u5f0f\u5360\u7528\uff0c\u6216\u624b\u52d5\u8f38\u5165\u3002');
    }
  }
}
