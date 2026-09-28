const {chromium}=require('C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:960}}), errors=[],results=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const b=(name,scope=page)=>scope.getByRole('button',{name,exact:true});
  const state=()=>page.evaluate(()=>structuredClone(window.__review.store));
  const close=async()=>{await b('關閉收貨工作').click();await page.getByRole('dialog').waitFor({state:'hidden'});};
  const record=s=>{results.push(s);console.log('PASS '+s);};
  const create=async(key,unit,serial)=>{
   await page.getByRole('combobox',{name:'品項／型號'}).fill(key);
   await b('＋新增新型號「'+key+'」').click();const mini=page.getByRole('region',{name:'新增新型號'});
   await mini.getByLabel('新型號單位').fill(unit);
   assert.equal(await mini.getByRole('checkbox').isChecked(),serial);
   await b('建立並選用',mini).click();await mini.waitFor({state:'hidden'});
   assert((await page.getByRole('combobox',{name:'品項／型號'}).inputValue()).includes(key));
   assert.equal(await page.getByRole('dialog').count(),1);
  };
  const project=async(name)=>{await page.getByRole('combobox',{name:/^案件/}).fill(name);await page.keyboard.press('Enter');};
  await page.goto('http://127.0.0.1:3020');await b('＋預計收貨').waitFor();
  await page.evaluate(()=>{const s=window.__review.store;s.inventory_items.push(...['FEMALE','MALE'].map(x=>({id:x,code:'MC4-CAP-'+x,name:'MC4防塵塞',unit:'pcs',is_active:true,requires_serial:false})),{id:'alias',code:'TECH-42',name:'搜尋別名',canonical_identity_key:'exact.model-42',unit:'pcs',is_active:true,requires_serial:false});sessionStorage.setItem('v5-fixture',JSON.stringify(s));});
  await page.reload();await b('＋預計收貨').click();let input=page.getByRole('combobox',{name:'品項／型號'});
  await input.focus();assert((await page.getByRole('option').count())>=5);
  await input.fill('MC4防塵塞');assert.equal(await page.getByRole('listbox').getByRole('option').count(),2);await page.keyboard.press('Enter');assert.equal(await input.getAttribute('aria-expanded'),'true');assert.equal(await b('建立預計收貨').isEnabled(),false);assert.equal(await page.getByRole('button',{name:/新增新型號/}).count(),0);
  await page.getByRole('option').filter({hasText:'MC4-CAP-FEMALE'}).click();assert((await input.inputValue()).includes('FEMALE'));
  await input.fill('EXACT.MODEL-42');await page.keyboard.press('Enter');assert((await input.inputValue()).includes('TECH-42'));record('Shared combobox: quick picks, explicit same-name choice, key search, no Enter-first fallback');
  await create('V6B-PENDING-123','台',true);await b('建立預計收貨').click();await page.getByRole('form',{name:'預計收貨'}).waitFor({state:'hidden'});record('Pending creates one canonical serialized item in small inline form');
  await b('＋實際到貨').click();await b('無序號物料').click();await create('V6B-PLAIN-123','m',false);await page.getByRole('spinbutton',{name:'實收數量'}).fill('3');await b('完成實際到貨').click();await page.getByRole('form',{name:'實際到貨'}).waitFor({state:'hidden'});record('Actual nonserial arrival creates and immediately uses new item/unit');
  await b('＋實際到貨').click();await b('批次輸入').click();await page.getByLabel('批次序號').fill('V6BUNKNOWN-AA');await b('加入本批').click();await b('完成實際到貨').click();await page.getByRole('form',{name:'實際到貨'}).waitFor({state:'hidden'});
  let s=await state();const unknown=s.receiving_arrival_lines.find(l=>l.resolution_state==='UNRESOLVED');await page.locator('[data-work-item="arrival:'+unknown.id+'"]').click();await create('V6B-UNKNOWN-123','台',true);await b('完成資料並入庫').click();await b('送至案場').waitFor();await close();record('Unknown completion uses identical small item creator and posts successfully');
  await page.evaluate(()=>{const s=window.__review.store;s.project_material_batches.push({id:'req-b',project_id:'north',batch_name:'既有叫料',created_at:'2026-09-01',same_day_delivery:true});s.project_materials.push({id:'req-one',project_id:'north',batch_id:'req-b',inventory_item_id:'serial',item_name:'序號設備',specification:'P401',unit:'台',quantity:20,procurement_status:'PARTIAL_RECEIVED',delivery_destination:'SITE',created_at:'2026-09-01',include_in_purchase_request:false});s.material_receipts.push({id:'prior-site',source_type:'PROJECT_MATERIAL',project_material_id:'req-one',event_type:'RECEIVE',receipt_location:'SITE',quantity_received:8,received_at:'2026-09-01T00:00:00Z'});});
  const seed=await page.evaluate(()=>window.__review.seed);await b('＋實際到貨').click();await b('批次輸入').click();await page.getByLabel('批次序號').fill(seed.serials.slice(0,3).join('\n'));await b('加入本批').click();await b('完成實際到貨').click();await page.getByRole('form',{name:'實際到貨'}).waitFor({state:'hidden'});
  const row=()=>page.locator('[data-work-item="SE_SUPPLY:'+seed.a+'"]');await row().click();await b('送至案場').click();let form=page.getByRole('form',{name:'送至案場'});for(let i=0;i<3;i++)await form.getByRole('checkbox').nth(i).check();await project('北港');await page.getByRole('combobox',{name:'案場物料需求'}).waitFor();assert.equal(await page.getByRole('combobox',{name:'案場物料需求'}).inputValue(),'req-one');await b('確認送至案場').click();await form.waitFor({state:'hidden'});
  s=await state();const handoff=s.calls.filter(c=>c.name==='route_receiving_inventory').at(-1);assert.equal(handoff.args.p_material_id,'req-one');assert.equal(handoff.args.p_create_new,false);assert.equal(s.project_materials.length,1);await close();record('Unique existing requirement is reused with p_create_new=false; 8 + 3, no duplicate');
  await b('檢視測試案場物料追蹤').click();await page.getByText('11 / 20 台',{exact:true}).waitFor();await b('序號設備收料紀錄').click();const history=page.getByRole('dialog',{name:'P401收料紀錄'});await history.getByText('查看送達序號（3）',{exact:true}).click();for(const serial of seed.serials.slice(0,3))await history.getByText(serial,{exact:true}).waitFor();assert.equal(await history.getByText(seed.serials[3],{exact:true}).count(),0);await history.getByText('來源：北辦庫存出庫',{exact:true}).waitFor();await page.screenshot({path:'.codex-logs/receiving-v6-preview/v6b-project-tracking.png'});await b('關閉收料紀錄').click();await b('關閉測試案場').click();record('Actual ProjectMaterials/history components show 11/20, SITE source, exact three serials');
  await row().click();await b('撤回').click();await page.getByLabel('撤回原因').fill('V6B test');await b('確認撤回').click();await b('送至案場').waitFor();await close();await b('檢視測試案場物料追蹤').click();await page.getByText('8 / 20 台',{exact:true}).waitFor();await b('關閉測試案場').click();record('Retract restores project tracking to 8/20 and keeps existing requirement');
  await page.evaluate(()=>{const s=window.__review.store;s.project_materials.push({...s.project_materials[0],id:'req-two',quantity:5,specification:'P401 第二次叫料'});});
  await row().click();await b('送至案場').click();form=page.getByRole('form',{name:'送至案場'});await form.getByRole('checkbox').first().check();await project('北港');await page.getByRole('combobox',{name:'案場物料需求'}).waitFor();assert.equal(await b('確認送至案場').isEnabled(),false);await page.getByRole('combobox',{name:'案場物料需求'}).selectOption('req-two');await b('確認送至案場').click();await form.waitFor({state:'hidden'});s=await state();assert.equal(s.calls.filter(c=>c.name==='route_receiving_inventory').at(-1).args.p_material_id,'req-two');record('Multiple compatible requirements block submit until explicit choice');
  await b('送至案場').click();form=page.getByRole('form',{name:'送至案場'});await form.getByRole('checkbox').first().check();await project('南投');await b('確認送至案場').click();await form.waitFor({state:'hidden'});s=await state();assert.equal(s.calls.filter(c=>c.name==='route_receiving_inventory').at(-1).args.p_create_new,true);assert.equal(s.project_materials.filter(m=>m.project_id==='south').length,1);await close();record('No compatible requirement creates one project material');
  await page.setViewportSize({width:375,height:844});await b('＋預計收貨').click();await page.getByRole('combobox',{name:'品項／型號'}).fill('V6B-MOBILE-123');await b('＋新增新型號「V6B-MOBILE-123」').click();assert.equal(await page.getByRole('dialog').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);await page.screenshot({path:'.codex-logs/receiving-v6-preview/v6b-mobile-create.png'});record('Mobile inline creator fits one modal without overflow');
  assert.deepEqual(errors,[]);fs.writeFileSync('.codex-logs/receiving-v6-preview/v6b-browser-result.json',JSON.stringify({results,errors,transport:'synthetic; actual React components, including ProjectMaterials and receipt history'},null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
