const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../src/lib/test-load-ts.cjs');
const { BarcodeCamera } = load(path.resolve('src/lib/barcode-camera.ts'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function camera(overrides = {}) {
  let stopped = 0; const values = [], states = [], constraints = [];
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  const video = { srcObject: null, readyState: 2, pause() {}, play: async () => {} };
  const session = new BarcodeCamera(video, raw => values.push(raw), (...state) => states.push(state), () => {}, {
    getUserMedia: async value => { constraints.push(value); return stream; },
    loadDecoder: async () => ({ decode: () => ({ getText: () => ' Raw Value ' }) }), ...overrides,
  });
  return { session, stream, video, values, states, constraints, get stopped() { return stopped; } };
}
test('SCANNER-1/2: first decode stops stream; duplicate frames/manual callbacks are locked; raw preserved', async () => {
  const h = camera(); await h.session.start(); h.session.accept('second');
  assert.deepEqual(h.values, [' Raw Value ']); assert.equal(h.stopped, 1); assert.equal(h.video.srcObject, null);
  assert.equal(h.constraints[0].audio, false); assert.equal(h.constraints[0].video.facingMode.ideal, 'environment');
});
for (const method of ['stop', 'dispose']) test(`SCANNER-3/4: ${method} stops tracks and clears preview`, async () => {
  const h = camera({ loadDecoder: async () => ({ decode() { return undefined; } }) });
  await h.session.start(); assert(h.video.srcObject); h.session[method](); assert.equal(h.stopped, 1); assert.equal(h.video.srcObject, null);
  await new Promise(resolve => setTimeout(resolve, 230)); assert.equal(h.values.length, 0);
});
for (const name of ['NotAllowedError', 'NotFoundError']) test(`SCANNER-5/6: ${name} still accepts manual input exactly once`, async () => {
  const h = camera({ getUserMedia: async () => { throw Object.assign(Error(), { name }); } });
  await h.session.start(); assert.equal(h.states.at(-1)[0], 'error');
  h.session.accept('7515CA50-A4'); h.session.accept('7515CA50-A4'); assert.deepEqual(h.values, ['7515CA50-A4']);
});
for (const method of ['stop', 'dispose']) test(`SCANNER-7: late permission after ${method} immediately releases stream`, async () => {
  let resolve; const h = camera({ getUserMedia: () => new Promise(r => resolve = r) });
  const pending = h.session.start(); h.session[method](); resolve(h.stream); await pending;
  assert.equal(h.stopped, 1); assert.equal(h.video.srcObject, null); assert.deepEqual(h.values, []);
});
test('switch while permission pending cannot attach the older stream', async () => {
  const pending = []; const h = camera({ getUserMedia: () => new Promise(r => pending.push(r)) });
  const first = h.session.start(); const second = h.session.start('rear2');
  pending[0](h.stream); await first; assert.equal(h.stopped, 1); assert.equal(h.video.srcObject, null);
  pending[1](h.stream); await second; assert.equal(h.stopped, 2); assert.equal(h.values.length, 1);
});
test('close during lazy decoder load prevents play/decode and manual cannot callback after dispose', async () => {
  let resolve; const h = camera({ loadDecoder: () => new Promise(r => resolve = r) });
  const pending = h.session.start(); await flush(); h.session.dispose();
  resolve({ decode() { throw Error('must not decode'); } }); await pending; h.session.accept('late');
  assert.equal(h.stopped, 1); assert.deepEqual(h.values, []);
});
test('bundled ZXing expected exceptions use class identity rather than renamed constructor names', async () => {
  class MinifiedMissing extends Error {}
  class MinifiedChecksum extends Error {}
  class MinifiedFormat extends Error {}
  let calls=0,stops=0;
  const previous=Object.getOwnPropertyDescriptor(global,'navigator');
  Object.defineProperty(global,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stops++;}}]})}}});
  const {BarcodeCamera:BundledCamera}=load(path.resolve('src/lib/barcode-camera.ts'),{
    '@zxing/browser':{BrowserMultiFormatReader:class{decode(){calls++;throw new MinifiedMissing();}}},
    '@zxing/library':{NotFoundException:MinifiedMissing,ChecksumException:MinifiedChecksum,FormatException:MinifiedFormat},
  });
  const states=[];const session=new BundledCamera({pause(){},play:async()=>{},readyState:4},()=>{throw Error('unexpected result');},state=>states.push(state),()=>{});
  try{await session.start();assert.equal(calls,1);assert.equal(states.at(-1),'ready');assert.equal(stops,0);}
  finally{session.dispose();if(previous)Object.defineProperty(global,'navigator',previous);else delete global.navigator;}
});

test('SCAN-1/2/3: continuous unique callbacks, same-code debounce and finish cleanup',async()=>{
 let stopped=0, decodes=0;const values=[];
 const video={readyState:2,play:async()=>{},pause(){},srcObject:null};
 const c=new BarcodeCamera(video,v=>values.push(v),()=>{},()=>{},{
 getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]}),
 loadDecoder:async()=>({decode(){decodes++;return {getText:()=>decodes===1?'A':'B'};}})
 },'continuous');
 await c.start();assert.equal(stopped,0);assert.deepEqual(values,['A']);
 c.accept('A');assert.equal(values.length,1);
 await new Promise(r=>setTimeout(r,230));assert.deepEqual(values,['A','B']);assert.equal(stopped,0);
 c.accept('B');assert.equal(values.length,2);c.accept('C');assert.equal(values.length,3);
 c.dispose();assert.equal(stopped,1);assert.equal(video.srcObject,null);
 c.accept('D');assert.equal(values.length,3);
});
test('continuous late permission is cleaned up on finish',async()=>{
 let resolve,stops=0;const values=[];
 const c=new BarcodeCamera({pause(){},play:async()=>{}},v=>values.push(v),()=>{},()=>{},{
 getUserMedia:()=>new Promise(r=>resolve=r),loadDecoder:async()=>({decode(){}})
 },'continuous');
 const pending=c.start();c.dispose();resolve({getTracks:()=>[{stop(){stops++;}}]});await pending;
 assert.equal(stops,1);assert.deepEqual(values,[]);
});
