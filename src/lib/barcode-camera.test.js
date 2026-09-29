const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { BarcodeCamera } = load(path.resolve(__dirname, 'barcode-camera.ts'));
const { ScannerSession } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));

test('camera stop clears stream and prevents late decoder callbacks', async () => {
  let stopped = 0, decoded = 0;
  const track = { stop(){ stopped++; }, getSettings(){ return {}; } };
  const stream = { getTracks(){ return [track]; } };
  const video = { readyState: 2, srcObject: null, async play(){}, pause(){} };
  const found = [];
  const camera = new BarcodeCamera(video, raw => found.push(raw), () => {}, () => {}, {
    async getUserMedia(){ return stream; },
    async loadDecoder(){ return { decode(){ decoded++; return ['ABC123456-01']; } }; },
  }, 'continuous');
  await camera.start();
  assert.deepEqual(found, ['ABC123456-01']);
  camera.dispose();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(stopped, 1);
  assert.equal(decoded, 1);
  assert.equal(video.srcObject, null);
});

test('late camera permission grant is stopped after close', async () => {
  let release, stopped = 0;
  const stream = { getTracks(){ return [{ stop(){ stopped++; } }]; } };
  const video = { srcObject: null, pause(){} };
  const camera = new BarcodeCamera(video, () => {}, () => {}, () => {}, {
    getUserMedia(){ return new Promise(resolve => { release = resolve; }); },
    async loadDecoder(){ throw new Error('must not load'); },
  });
  const starting = camera.start();
  camera.dispose();
  release(stream);
  await starting;
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, null);
});

test('native detector emits two codes from one frame', async () => {
  const original = globalThis.BarcodeDetector;
  let calls = 0;
  globalThis.BarcodeDetector = class {
    static async getSupportedFormats(){ return ['code_128']; }
    async detect(){ calls++; return [{ rawValue: 'P401' }, { rawValue: 'ABC123456-01' }]; }
  };
  const track = { stop(){} }, stream = { getTracks(){ return [track]; } };
  const video = { readyState: 2, srcObject: null, async play(){}, pause(){} };
  const found = [];
  try {
    const camera = new BarcodeCamera(video, raw => found.push(raw), () => {}, () => {}, {
      async getUserMedia(){ return stream; }, async loadDecoder(){ throw new Error('native should be used'); },
    }, 'continuous');
    await camera.start();
    camera.dispose();
    assert.equal(calls, 1);
    assert.deepEqual(found, ['P401', 'ABC123456-01']);
  } finally { globalThis.BarcodeDetector = original; }
});

test('ZXing fallback keeps decoding after repeated first code and sees a later serial', async () => {
  let stopped = 0, decoded = 0;
  const stream = { getTracks(){ return [{ stop(){ stopped++; } }]; } };
  const video = { readyState: 2, srcObject: null, async play(){}, pause(){} };
  const found = [];
  const camera = new BarcodeCamera(video, raw => found.push(raw), () => {}, () => {}, {
    async getUserMedia(){ return stream; },
    async loadDecoder(){ return { decode(){ decoded++; return [decoded < 3 ? 'P401' : 'ABC123456-01']; } }; },
  }, 'continuous');
  await camera.start();
  await new Promise(resolve => setTimeout(resolve, 370));
  assert.deepEqual(found, ['P401', 'ABC123456-01']);
  assert.equal(stopped, 0);
  camera.dispose();
  assert.equal(stopped, 1);
});

test('manual accepts join the same live continuous session', async () => {
  const codes = new ScannerSession([{ id: 'p', code: 'P401' }], () => {}, () => {}, 10000);
  const stream = { getTracks(){ return [{ stop(){} }]; } };
  const video = { readyState: 2, srcObject: null, async play(){}, pause(){} };
  const camera = new BarcodeCamera(video, raw => codes.add(raw), () => {}, () => {}, {
    async getUserMedia(){ return stream; }, async loadDecoder(){ return { decode(){ return []; } }; },
  }, 'continuous');
  await camera.start();
  camera.accept('P401');
  camera.accept('ABC123456-01');
  assert.deepEqual(codes.codes.map(code => code.kind), ['MODEL', 'SERIAL']);
  camera.dispose(); codes.dispose();
});
