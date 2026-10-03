// Isolated browser transport; real SE and ProjectMaterials components, no Candidate writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const toolsRoot = process.env.RECEIVING_UI_TOOLS || 'C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules';
const esbuild = require(path.join(toolsRoot, 'esbuild'));
const { chromium } = require(path.join(toolsRoot, 'playwright'));
const out = path.resolve('.codex-logs/receiving-routing-surfaces-browser');
fs.mkdirSync(out, { recursive: true });
const fixture = `
export const store = {calls:[],records:[{id:'receiving-se',new_model:'SE4000H',new_serial:'RSEM0001-AA',
 quantity:1,unit:'台',inventory_serial_id:'inventory-serial',inventory_item_id:'item',receiving_only:false,
 inventory_routed:true,procurement_status:'RECEIVED',replace_date:null,cancelled_at:null,project_id:null,
 created_at:'2026-10-03T06:00:00Z',updated_at:'2026-10-03T06:00:00Z'}]};
export const supabase = {from:()=>{const q={select(){return q},eq(){return q},is(){return q},in(){return q},order(){return q},
 range:async()=>({data:[{project_material_id:'material',quantity:2}],error:null})};return q}};
export const useUser = () => ({currentUser:{id:'actor',name:'Reviewer',role:'ADMIN'}});
export const createReceivingApi = () => ({
 receivingSEOrigins:async()=>new Set(['receiving-se']),
 receivingSELineage:async()=>({active:true}),
 returnReceivingSE:async(id,reason)=>{store.calls.push({name:'returnReceivingSE',id,reason});return {}},
 cancelReservation:async()=>{throw Error('generic cancel reached')}
});
export const isActiveSEReservation = r => Boolean(r.inventory_serial_id && !r.replace_date && !r.cancelled_at && !r.receiving_only);
export const dbAdapter = {
 getSESupplyRecords:async()=>store.records,getProjects:async()=>[],getInventorySerials:async()=>[],
 deleteSESupplyRecord:async()=>{throw Error('generic delete reached')},
 listProjectMaterialBatches:async()=>[{id:'batch',project_id:'project',batch_name:'北辦預備物料',
  ordered_at:'2026-10-03T06:00:00Z',planned_receipt_at:'2026-10-05T06:00:00Z',same_day_delivery:false}],
 listProjectMaterials:async()=>[{id:'material',project_id:'project',batch_id:'batch',item_name:'線材',
  specification:'CABLE',quantity:5,unit:'unit',delivery_destination:'SITE',procurement_status:'ORDERED',
  include_in_purchase_request:false,reminder_enabled:false,inventory_item_id:'item'}],
 listMaterialCatalogItems:async()=>[],listMaterialGroups:async()=>[],listMaterialReceipts:async()=>[]
};`;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import SESupplyPage from './src/app/se-supply/page';import {ProjectMaterials} from './src/components/ProjectMaterials';
import {store} from 'routing-surfaces-fixture';window.__review=store;
createRoot(document.getElementById('root')).render(location.pathname==='/se'
 ? <SESupplyPage/> : <ProjectMaterials projectId="project" projectName="北港" canEdit={true}/>);`;
async function main() {
 await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,
  outfile:path.join(out,'app.js'),platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'routing-surfaces-fixture',setup(build){
   build.onResolve({filter:/^(routing-surfaces-fixture|@\/lib\/db\/receiving-routing|@\/lib\/db\/supabaseClient|@\/lib\/db)$/},()=>({path:'fixture',namespace:'routing-surfaces'}));
   build.onResolve({filter:/UserContext$/},()=>({path:'fixture',namespace:'routing-surfaces'}));
   build.onLoad({filter:/.*/,namespace:'routing-surfaces'},()=>({contents:fixture,loader:'js'}));
  }}]});
 const css = fs.readdirSync('.next-verify/static/css').filter(name=>name.endsWith('.css'))
  .sort((a,b)=>fs.statSync(path.join('.next-verify/static/css',b)).size-fs.statSync(path.join('.next-verify/static/css',a)).size)[0];
 const server=http.createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(out,'app.js')));}
  else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join('.next-verify/static/css',css)));}
  else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/app.js"></script>');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  for(const width of [1200,390]) {
   const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await page.goto('http://127.0.0.1:'+server.address().port+'/se');
   const returning=page.getByRole('button',{name:'退回已收到'}).first();
   await returning.waitFor();
   page.on('dialog',async dialog=>dialog.type()==='confirm'?dialog.accept():dialog.accept('fixture return'));
   await returning.click();
   await page.waitForFunction(()=>window.__review.calls.length===1);
   assert.deepEqual(await page.evaluate(()=>window.__review.calls),[{name:'returnReceivingSE',id:'receiving-se',reason:'fixture return'}]);
   assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(out,`se-${width}.png`)});
   await page.close();

   const materials=await browser.newPage({viewport:{width,height:844}}),materialErrors=[];
   materials.on('pageerror',error=>materialErrors.push(error.message));
   await materials.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await materials.goto('http://127.0.0.1:'+server.address().port+'/materials');
   await materials.getByText('北辦已備 2 / 需求 5').waitFor();
   assert.equal(await materials.getByText('已收到',{exact:true}).count(),0);
   assert.deepEqual(materialErrors,[]);
   await materials.screenshot({path:path.join(out,`materials-${width}.png`)});
   await materials.close();
  }
  console.log('PASS SE atomic return handler and ProjectMaterials preparation projection at 1200/390; no runtime errors');
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
