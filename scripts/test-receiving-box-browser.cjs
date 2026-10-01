// Targeted component browser checks. All transport is mocked; no real DB access.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const tools = process.env.RECEIVING_UI_TOOLS || 'C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules';
const esbuild = require(path.join(tools, 'esbuild'));
const { chromium } = require(path.join(tools, 'playwright'));
const model = 'SE10000H-RWSKBF57';
const serial = n => `SB4725-${String(n).padStart(9, '0')}-3C`;
const serialKey = n => `${String(n).padStart(9, '0')}-3C`;
let browser, bundle, css;
const mocks = {
  'barcode-camera': `import {flushSync} from 'react-dom'; export class BarcodeCamera { constructor(video, detected, state, stream, deps, mode, decoded) { this.detected=detected; window.scan=(value)=>flushSync(()=>{ decoded?.(value,true); detected(value); }); } async start() { window.cameraStarts=(window.cameraStarts||0)+1; } stop() {} dispose() {} accept(raw) { this.detected(raw); } }`,
  'useReceivingItems': `export function useReceivingItems(data) { return {data,createItem:async()=>{throw Error('not part of scan')}}; }`,
  'ReceivingV5Forms': `import {useState} from 'react'; export function useV5Action(){ const [error,setError]=useState(''); const [busy,setBusy]=useState(false); return {error,setError,busy,run:async fn=>{setBusy(true);try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}}; } export function useV5Request(){return x=>x}; export function ActionError({message}){return message}; export const v5Field='',v5Primary='';`,
  'ReceiptDateTimeInput': `export function ReceiptDateTimeInput(){return null}`,
  'ReceivingSerialControls': `export function InventoryItemCombobox(){return null}`,
};
test.before(async () => {
  bundle = (await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ReceivingV6Composer} from './src/components/ReceivingV6Composer';
    window.calls={reads:[],writes:[],saved:0};
    const data={items:[{id:'a',code:'${model}',is_active:true,requires_serial:true},{id:'b',code:'S1000-1GMXMBT-NA01',is_active:true,requires_serial:true}],observations:[],matchObservations:[],projects:[],materials:[],supplies:[],batches:[],arrivals:[],lines:[],matches:[],receipts:[],fulfilment:{}};
    const api={lookupBatch:async values=>{window.calls.reads.push(values);if(window.failLookup)throw Error('offline');return values.map(()=>({result_type:'no_match',candidate_count:0,filtered_candidate_count:0,candidates:[]}));},create:async value=>{window.calls.writes.push(value);return {id:'fixture'};}};
    createRoot(document.getElementById('root')).render(<ReceivingV6Composer data={data} api={api} onClose={()=>{}} onSaved={async()=>{window.calls.saved++}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'offline-boundaries', setup(build) { build.onResolve({filter:/barcode-camera$|useReceivingItems$|ReceivingV5Forms$|ReceiptDateTimeInput$|ReceivingSerialControls$/}, args => ({path:args.path.split('/').pop(),namespace:'mock'})); build.onLoad({filter:/.*/,namespace:'mock'}, args => ({contents:mocks[args.path],loader:'jsx',resolveDir:process.cwd()})); } }] })).outputFiles[0].text;
  css = (await require('postcss')([require('tailwindcss')('./tailwind.config.ts'),require('autoprefixer')]).process(fs.readFileSync('src/app/globals.css','utf8'),{from:'src/app/globals.css'})).css;
  browser = await chromium.launch({headless:true,channel:'msedge'});
});
test.after(async () => { await browser?.close(); });
async function pageFor(debug = false) { const page=await browser.newPage({viewport:{width:390,height:844}}); page.on('dialog',d=>d.accept()); await page.route('https://scanner.test/**', route => route.fulfill({contentType:'text/html',body:'<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'})); await page.goto('https://scanner.test/' + (debug ? '?scannerDebug=1' : '')); await page.addStyleTag({content:css}); await page.addScriptTag({content:bundle}); await page.getByRole('button',{name:'完成這箱',exact:true}).waitFor(); return page; }
const scan = (page, codes) => page.evaluate(values=>values.forEach(window.scan),codes);
const button = (page,name) => page.getByRole('button',{name,exact:true});
async function expandedCurrent(page) { const b=page.getByRole('button',{name:/已掃序號/}); if(await b.getAttribute('aria-expanded')==='false') await b.click(); }

test('current/reset/completed deletions release identity with zero network mutation', async () => {
  const p=await pageFor(); try {
    await scan(p,[model,serial(1),serial(2)]); await expandedCurrent(p);
    await button(p,'刪除 '+serialKey(1)).click(); assert.match(await p.locator('body').innerText(),/已掃序號 1/);
    await scan(p,[serial(1)]); assert.match(await p.locator('body').innerText(),/已掃序號 2/);
    await button(p,'完成這箱').click(); await p.locator('summary').filter({hasText:'箱 1'}).click();
    await button(p,'刪除 '+serialKey(2)).click(); assert.match(await p.locator('body').innerText(),/已完成 1 箱・1 台/);
    await scan(p,[serial(2)]); assert.match(await p.locator('body').innerText(),/已掃序號 1/);
    await button(p,'清空目前這箱').click(); assert.match(await p.locator('body').innerText(),/已掃序號 0/);
    await button(p,'刪除這箱').click(); assert.match(await p.locator('body').innerText(),/已完成 0 箱・0 台/);
    await scan(p,[model,serial(1)]); assert.match(await p.locator('body').innerText(),/已掃序號 1/);
    assert.deepEqual(await p.evaluate(()=>window.calls),{reads:[],writes:[],saved:0});
  } finally { await p.close(); }
});
test('manual duplicate clears input, final review reflects edits, saved arrival disables frontend changes', async () => {
  const p=await pageFor(); try {
    await scan(p,[model,serial(1)]); await button(p,'＋ 手動輸入序號').click(); const input=p.getByRole('textbox',{name:'序號',exact:true});
    await input.fill(serial(1)); await button(p,'加入').click(); await p.getByRole('alertdialog').waitFor(); assert.equal(await input.inputValue(),''); assert((await p.getByRole('alertdialog').innerText()).includes(serialKey(1)));
    await button(p,'關閉').click(); await input.fill(serial(2)); await button(p,'加入').click(); assert.equal(await input.inputValue(),'');
    await button(p,'完成掃描').click(); await p.getByRole('button',{name:'完成實際到貨',exact:true}).waitFor(); assert.match(await p.locator('body').innerText(),/共 2 台/);
    await button(p,'返回掃描').click(); await p.locator('summary').filter({hasText:'箱 1'}).click(); await button(p,'刪除 '+serialKey(1)).click();
    await button(p,'完成掃描').click(); await button(p,'完成實際到貨').waitFor(); assert.match(await p.locator('body').innerText(),/共 1 台/);
    assert.equal((await p.evaluate(()=>window.calls.writes)).length,0);
    await button(p,'完成實際到貨').click(); await button(p,'已完成實際到貨').waitFor();
    const calls=await p.evaluate(()=>window.calls); assert.equal(calls.writes.length,1); assert.equal(calls.writes[0].p_lines[0].quantity,1); assert.deepEqual(calls.writes[0].p_lines[0].raw_serials,[serialKey(2)]);
    assert.equal(await button(p,'返回掃描').isDisabled(),true);
  } finally { await p.close(); }
});
test('mobile box layout retains camera space and model conflict requires explicit action', async () => {
  const p=await pageFor(); try {
    await scan(p,[model,serial(1)]); await button(p,'完成這箱').click(); await scan(p,[model,serial(2),serial(3)]);
    const video=await p.locator('video').boundingBox(); assert(video.height>350); assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    fs.mkdirSync('C:/Vibecode/.codex-tmp/scanner-v24',{recursive:true}); await p.screenshot({path:'C:/Vibecode/.codex-tmp/scanner-v24/mobile.png'});
    await scan(p,['S1000-1GMXMBT-NA01']); assert.match(await p.locator('body').innerText(),/偵測到不同型號/);
    await button(p,'保留目前型號').click(); assert.equal(await button(p,'保留目前型號').count(),0);
  } finally { await p.close(); }
});

test('failed final lookup resumes camera and keeps deletion editable without stale draft writes', async () => {
  const p=await pageFor(); try {
    await scan(p,[model,serial(1),serial(2)]); await p.evaluate(()=>window.failLookup=true);
    await button(p,'完成掃描').click(); await p.getByRole('alert').filter({hasText:'offline'}).waitFor();
    assert((await p.evaluate(()=>window.cameraStarts))>=2);
    await p.locator('summary').filter({hasText:'箱 1'}).click(); await button(p,'刪除 '+serialKey(1)).click();
    await p.evaluate(()=>window.failLookup=false); await button(p,'完成掃描').click(); await button(p,'完成實際到貨').waitFor();
    assert.match(await p.locator('body').innerText(),/共 1 台/); assert.equal((await p.evaluate(()=>window.calls.writes)).length,0);
  } finally { await p.close(); }
});

for (const [label, codes, devices, decoded] of [
  ['model only', [model], 0, 1],
  ['model and one serial', [model,serial(1)], 1, 2],
  ['model and two serials', [model,serial(1),serial(2)], 2, 3],
  ['repeated model', [...Array(10).fill(model),serial(1),serial(2)], 2, 3],
  ['unknown and model', ['27382202',model,serial(1),serial(2)], 2, 4],
]) test('classified box source: '+label, async () => {
  const p=await pageFor(true); try {
    await scan(p,codes);
    assert.equal(await p.getByLabel('目前這箱設備數').innerText(), devices+' 台');
    assert.match(await p.locator('body').innerText(), new RegExp('掃碼診斷 · '+decoded+' 筆'));
    for (const layer of ['CAMERA DECODE','SESSION','CLASSIFY']) assert.equal(await p.getByText(layer,{exact:true}).count(),1);
    const diagnostic=p.locator('details').filter({hasText:'CAMERA DECODE'});
    assert((await diagnostic.innerText()).includes('MODEL'));
    if(devices) assert((await diagnostic.innerText()).includes('SERIAL'));
    await expandedCurrent(p); const list=p.getByRole('list',{name:'箱 1 序號',exact:true});
    assert.equal(await list.getByRole('listitem').count(),devices);
    assert(!(await list.innerText()).includes(model)); assert(!(await list.innerText()).includes('27382202'));
  } finally { await p.close(); }
});
test('normal scanner hides all raw diagnostics and shows only classified device count',async()=>{
 const p=await pageFor();try{
   await scan(p,[model,serial(1),serial(2),'27382202']);
   assert.equal(await p.getByLabel('目前這箱設備數').innerText(),'2 台');
   for(const label of ['CAMERA DECODE','SESSION','CLASSIFY','掃碼量測']) assert.equal(await p.getByText(label,{exact:true}).count(),0);
   assert.equal(await p.locator('summary').filter({hasText:'掃碼診斷'}).count(),0);
 }finally{await p.close();}
});
