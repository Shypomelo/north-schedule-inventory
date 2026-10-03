// Real Receiving V6 components with isolated, read-only fixture transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const toolsRoot = process.env.RECEIVING_UI_TOOLS || 'C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules';
const esbuild = require(path.join(toolsRoot, 'esbuild'));
const { chromium } = require(path.join(toolsRoot, 'playwright'));
const out = path.resolve('.codex-logs/receiving-three-way-browser');
fs.mkdirSync(out, { recursive: true });
const fixture = `
export const store = { calls: [], snapshot: {
 projects:[{id:'project',name:'北港',project_name:'北港',status:'ACTIVE'}],
 items:[{id:'plain',code:'CABLE',name:'線材',unit:'m',requires_serial:false,is_active:true},
  {id:'serial',code:'P401',name:'序號設備',unit:'台',requires_serial:true,is_active:true}],
 materials:[],supplies:[{id:'legacy-source',new_model:'歷史線材',quantity:1,unit:'m',receiving_only:false,inventory_item_id:'plain'}],batches:[],
 arrivals:[{id:'arrival-known',actual_received_at:'2026-10-03T06:00:00Z',project_id:null,version:1},
  {id:'arrival-unknown',actual_received_at:'2026-10-03T07:00:00Z',project_id:null,version:1}],
 lines:[{id:'line-known',arrival_id:'arrival-known',inventory_item_id:'plain',quantity:4,unit:'m',resolution_state:'STAGED',receipt_id:null},
  {id:'line-unknown',arrival_id:'arrival-unknown',inventory_item_id:null,quantity:1,unit:null,resolution_state:'UNRESOLVED',receipt_id:null}],
 observations:[{id:'entry-unknown',arrival_line_id:'line-unknown',raw_serial:'TWAY0001-AA',normalized_serial:'TWAY0001-AA',inventory_serial_id:null,active_receipt_id:null,retired_at:null}],
 matches:[],matchObservations:[],receipts:[{id:'legacy-receipt',source_type:'SE_SUPPLY',se_supply_record_id:'legacy-source',event_type:'RECEIVE',quantity_received:1,receipt_location:'OFFICE',received_at:'2026-09-01T00:00:00Z'}],fulfilment:{},scopes:{},scopeErrors:{},transactions:[],closings:[],actors:[],
 receiptSerials:[],inventorySerials:[],transactionSerials:[],cancellations:[] } };
export const supabase = {};
export const useUser = () => ({currentUser:{id:'actor',name:'Reviewer',role:'ADMIN'}});
export const createReceivingV6Api = () => ({
 load: async () => structuredClone(store.snapshot),
 routeStaged: async args => {store.calls.push({name:'routeStaged',args});return {};},
 cancelPhysicalStage: async args => {store.calls.push({name:'cancelPhysicalStage',args});return {};},
 postReceivedToInventory: async args => {store.calls.push({name:'postReceivedToInventory',args});return {};},
 projectRequirements: async () => [],
 lookup: async () => ({result_type:'no_match',candidates:[]}),
 complete: async args => {store.calls.push({name:'complete',args});return {};}
});`;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {ReceivingV6Center} from './src/components/ReceivingV6Center';
import {store} from 'three-way-fixture';window.__review=store;
createRoot(document.getElementById('root')).render(<ReceivingV6Center/>);`;
async function main() {
 await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,
  outfile:path.join(out,'app.js'),platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'three-way-fixture',setup(build){
   build.onResolve({filter:/^(three-way-fixture|@\/lib\/db\/receiving-v6|@\/lib\/db\/supabaseClient)$/},()=>({path:'fixture',namespace:'three-way'}));
   build.onResolve({filter:/UserContext$/},()=>({path:'fixture',namespace:'three-way'}));
   build.onLoad({filter:/.*/,namespace:'three-way'},()=>({contents:fixture,loader:'js'}));
  }}]});
 const css = fs.readdirSync('.next-verify/static/css').filter(name=>name.endsWith('.css'))
  .sort((a,b)=>fs.statSync(path.join('.next-verify/static/css',b)).size-fs.statSync(path.join('.next-verify/static/css',a)).size)[0];
 const server = http.createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(out,'app.js')));}
  else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join('.next-verify/static/css',css)));}
  else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/app.js"></script>');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser = await chromium.launch({channel:'msedge',headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1200,height:900}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('tab',{name:/已收到\s*3/}).click();
  const known=page.locator('[data-received-group="item:plain"]');
  const unknown=page.locator('[data-received-group="arrival:line-unknown"]');
  const legacy=page.locator('[data-received-group="legacy:legacy-receipt"]');
  await known.locator('..').getByRole('button',{name:'後續處理'}).click();
  let dialog=page.getByRole('dialog',{name:'已收到明細'});
  for(const label of ['進北辦庫存','加入 SE 供貨追蹤','送至案場','取消實際到貨'])
   assert(await dialog.getByRole('button',{name:label,exact:true}).isVisible());
  await dialog.getByRole('button',{name:'加入 SE 供貨追蹤',exact:true}).click();
  await dialog.getByRole('spinbutton',{name:/處理數量/}).fill('2');
  await dialog.getByRole('button',{name:'確認加入 SE 供貨追蹤'}).click();
  await page.waitForFunction(()=>window.__review.calls.length===1);
  assert.equal((await page.evaluate(()=>window.__review.calls[0])).args.quantity,2);
  await dialog.getByRole('button',{name:'取消實際到貨',exact:true}).click();
  await dialog.getByRole('spinbutton',{name:/取消數量/}).fill('1');
  await dialog.getByRole('textbox',{name:'取消原因'}).fill('fixture');
  await dialog.getByRole('button',{name:'確認取消到貨'}).click();
  await page.waitForFunction(()=>window.__review.calls.length===2);
  assert.equal((await page.evaluate(()=>window.__review.calls[1])).name,'cancelPhysicalStage');
  await page.screenshot({path:path.join(out,'desktop.png')});
  await dialog.getByRole('button',{name:'關閉收貨工作'}).click();
  assert(await legacy.locator('..').getByRole('button',{name:'查看明細',exact:true}).isVisible());
  await legacy.locator('..').getByRole('button',{name:'更多操作：歷史線材'}).click();
  assert.equal(await page.getByRole('menuitem').count(),1);
  await page.getByRole('menuitem',{name:'查看明細'}).click();
  dialog=page.getByRole('dialog',{name:'已收到明細'});
  assert.equal(await dialog.getByRole('button',{name:'取消實際到貨'}).count(),0);
  await dialog.getByRole('button',{name:'關閉收貨工作'}).click();
  await unknown.locator('..').getByRole('button',{name:'補資料',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'已收到明細'});
  assert(await dialog.getByRole('button',{name:'完成資料'}).isVisible());
  assert.equal(await dialog.getByRole('button',{name:'進北辦庫存'}).count(),0);
  await dialog.getByRole('button',{name:'關閉收貨工作'}).click();
  await known.click({button:'right'});
  await page.getByRole('menuitem',{name:'送至案場'}).click();
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:'送至案場',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('dialog').getByRole('button',{name:'關閉收貨工作'}).click();
  await page.setViewportSize({width:390,height:844});
  await known.locator('..').getByRole('button',{name:'更多操作：CABLE'}).click();
  await page.getByRole('menuitem',{name:'加入 SE 供貨追蹤'}).click();
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:'加入 SE 供貨追蹤',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('dialog').getByRole('button',{name:'關閉收貨工作'}).click();
  await known.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:42,clientX:40,clientY:200});
  await page.getByRole('menuitem',{name:'取消實際到貨'}).waitFor({timeout:3000});
  await page.getByRole('menuitem',{name:'取消實際到貨'}).click();
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:'取消實際到貨',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:path.join(out,'mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS desktop 1200, mobile 390, three-way, unresolved, legacy guard, route/cancel handler, right-click, long-press, menu, no runtime error');
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
