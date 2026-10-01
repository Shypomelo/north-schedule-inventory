const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./test-load-ts.cjs');

const {
  BarcodeCamera,
  FALLBACK_DECODE_REGIONS,
  decodeFallbackFrame,
} = load(path.resolve(__dirname, 'barcode-camera.ts'));
const { ScannerSession } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));

function canvasSpy(draws = []) {
  return {
    width: 0,
    height: 0,
    getContext() {
      return {
        clearRect() {},
        drawImage(...args) { draws.push(args); },
      };
    },
  };
}

test('fallback decodes full frame plus one bounded ROI and frame-dedupes duplicates', () => {
  const video = { videoWidth: 1200, videoHeight: 800 };
  const canvas = canvasSpy();
  let calls = 0;
  const values = decodeFallbackFrame(video, {
    decode(source) {
      calls++;
      return source === video ? ['P401'] : ['P401', 'ABC123456-01'];
    },
  }, canvas, 0);

  assert.equal(calls, 2);
  assert.deepEqual(values, ['P401', 'ABC123456-01']);
});

test('fallback ROI selection is fixed, finite, and round-robin', () => {
  const video = { videoWidth: 1000, videoHeight: 600 };
  const draws = [];
  const canvas = canvasSpy(draws);
  let calls = 0;
  const decoder = { decode() { calls++; return []; } };

  for (let attempt = 0; attempt < FALLBACK_DECODE_REGIONS.length; attempt++)
    decodeFallbackFrame(video, decoder, canvas, attempt);

  assert.equal(draws.length, FALLBACK_DECODE_REGIONS.length);
  assert.equal(calls, FALLBACK_DECODE_REGIONS.length * 2);
  assert.equal(new Set(draws.map(args => args.slice(1, 5).join(','))).size, FALLBACK_DECODE_REGIONS.length);
});

test('dense fallback accumulates one PN plus ten SN without restarting the camera', async () => {
  const originalDetector = globalThis.BarcodeDetector;
  globalThis.BarcodeDetector = undefined;
  const queue = [];
  const serials = Array.from({ length: 10 }, (_, index) => `ABC12345${index + 6}-01`);
  const found = [], diagnostics = [];
  let mediaCalls = 0, stopped = 0, nextSerial = 0, failedTile = false;
  const stream = { getTracks() { return [{ stop() { stopped++; } }]; } };
  const video = { readyState: 2, videoWidth: 1200, videoHeight: 800, srcObject: null, async play() {}, pause() {} };

  try {
    const camera = new BarcodeCamera(video, raw => found.push(raw), () => {}, () => {}, {
      async getUserMedia() { mediaCalls++; return stream; },
      async loadDecoder() {
        return { decode(source) {
          if (source === video) return ['P401'];
          if (!failedTile && nextSerial === 2) { failedTile = true; throw new Error('one bad ROI'); }
          return nextSerial < serials.length ? [serials[nextSerial++]] : [];
        } };
      },
      createCanvas: () => canvasSpy(),
      schedule(callback) { queue.push(callback); return queue.length; },
      clearSchedule() {},
      now: (() => { let tick = 0; return () => ++tick; })(),
    }, 'continuous', undefined, diagnostic => diagnostics.push(diagnostic));

    await camera.start();
    let guard = 0;
    while (found.length < 6 && guard++ < 20) {
      const callback = queue.shift();
      assert(callback, 'next decode frame should remain scheduled');
      callback();
      await Promise.resolve();
    }
    assert.deepEqual(found, ['P401', ...serials.slice(0, 5)]);

    while (found.length < 11 && guard++ < 30) {
      const callback = queue.shift();
      assert(callback, 'next decode frame should remain scheduled');
      callback();
      await Promise.resolve();
    }
    assert.deepEqual(found, ['P401', ...serials]);
    assert.equal(new Set(found).size, 11);
    assert.equal(mediaCalls, 1);
    assert.equal(stopped, 0);
    assert.equal(diagnostics.at(-1).backend, 'ZXing multi-region');
    assert.equal(diagnostics.at(-1).accumulatedUniqueCount, 11);
    assert(diagnostics.some(frame => frame.decodedCount === 1), 'failed ROI should keep the full-frame result');
    camera.dispose();
    assert.equal(stopped, 1);
  } finally {
    globalThis.BarcodeDetector = originalDetector;
  }
});

test('canonical full and short serials still count as one device', () => {
  const session = new ScannerSession([], () => {}, () => {}, 10000);
  assert.equal(session.add('SJ1823A-03068530E-F9'), true);
  assert.equal(session.add('03068530E-F9'), false);
  assert.equal(session.codes.length, 1);
  session.dispose();
});

test('scanner diagnostics remain query-gated and camera effect ignores decoded state', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../components/BarcodeScanner.tsx'), 'utf8');
  assert.match(source, /get\('scannerDebug'\) === '1'/);
  assert.equal((source.match(/\{debug && <ScannerDiagnostics/g) || []).length, 2);
  for (const label of ['backend', 'frame attempts', 'frame decoded', 'decode latency', 'unique codes', 'frame raw'])
    assert(source.includes(label));
  assert.match(source, /\}, \[mounted, initialMode, mode\]\);/);
});