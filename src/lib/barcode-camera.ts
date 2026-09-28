type Decoder = { decode(video: HTMLVideoElement): { getText(): string } | undefined };
type CameraState = 'starting' | 'ready' | 'stopped' | 'success' | 'error';
interface CameraDependencies {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  loadDecoder(): Promise<Decoder>;
}

const dependencies: CameraDependencies = {
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  async loadDecoder() {
    const [{ BrowserMultiFormatReader }, { NotFoundException, ChecksumException, FormatException }] = await Promise.all([
      import('@zxing/browser'), import('@zxing/library'),
    ]);
    const reader = new BrowserMultiFormatReader();
    return { decode(video) {
      try { return reader.decode(video); }
      catch (cause) {
        // constructor.name is not stable after bundling/minification.
        if (cause instanceof NotFoundException || cause instanceof ChecksumException || cause instanceof FormatException) return undefined;
        throw cause;
      }
    } };

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

  constructor(private video: HTMLVideoElement, private onDetected: (raw: string) => void,
    private onState: (state: CameraState, message?: string) => void,
    private onStream: (stream: MediaStream) => void,
    private deps: CameraDependencies = dependencies,
    private mode: 'single' | 'continuous' = 'single') {}

  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
  }

  dispose() { this.disposed = true; this.stop(); }

  accept(raw: string) {
    if (this.disposed || this.detected || !raw.trim()) return;
    if (this.mode === 'continuous') {
      const now = Date.now();
      const repeated = raw === this.lastCode && now - this.lastDetectedAt < 1200;
      this.lastCode = raw; this.lastDetectedAt = now;
      if (repeated) return;
    } else { this.detected = true; this.stop(); }
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
      const decoder = await this.deps.loadDecoder();
      if (!active()) return;
      await this.video.play();
      if (!active()) return;
      this.onStream(stream);
      this.onState('ready');
      const decode = () => {
        if (!active()) return;
        let raw: string | undefined;
        try { if (this.video.readyState >= 2) raw = decoder.decode(this.video)?.getText(); }
        catch {
          this.stop(); this.onState('error', '辨識失敗，請重試或手動輸入。'); return;
        }
        if (raw?.trim()) this.accept(raw);
        if (active()) this.timer = setTimeout(decode, 200);
      };
      decode();
    } catch (cause) {
      if (!active()) return;
      this.stop();
      this.onState('error', (cause as Error).name === 'NotAllowedError'
        ? '未取得相機權限，請允許相機後重試，或手動輸入。'
        : '相機無法使用，請確認 HTTPS、鏡頭連線及其他程式占用，或手動輸入。');
    }
  }
}
