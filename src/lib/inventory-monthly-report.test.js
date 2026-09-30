const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('./test-load-ts.cjs');
const reportPath = path.join(__dirname, 'db/inventory-monthly-report.ts');
const { calculateInventoryMonthlyReport: calculate } = load(reportPath);
const { buildMonthlyReportWorkbook } = load(path.join(__dirname, 'utils/export-excel.ts'));
const XLSX = require('xlsx');
const item = (id = 'a', opening_quantity = 5) => ({ id, code: id, name: id, unit: 'pcs', is_active: true, opening_quantity });
const snapshot = (id = 'a', quantity = 2, closing_id = 'aug') => ({ inventory_item_id: id, item_name: id, closing_quantity: quantity, closing_id });
const baseline = (id = 'a', baseline_date = '2026-08-31') => ({ inventory_item_id: id, baseline_date, initialized_at: '2026-09-01T15:31:36Z' });
const closing = (month = '08', closed_at = '2026-09-03T13:15:47Z') => ({ id: month === '08' ? 'aug' : 'sep', year: '2026', month, status: 'CLOSED', closed_at });
const tx = (type, quantity, extra = {}) => ({ id: 'tx', item_id: 'a', transaction_type: type, quantity, transaction_date: '2026-09-02', created_at: '2026-09-03T00:00:00Z', ...extra });
const options = (extra = {}) => ({ year: '2026', month: '09', items: [item()], transactions: [], previousClosing: closing(), previousClosingItems: [snapshot()], initializationBaselines: [baseline()], ...extra });
const balance = (opts) => calculate(options(opts)).find(r => r.inventory_item_id === 'a')?.closing_quantity || 0;

test('reset baseline 5 supersedes prior CLOSED 2, even when sealed after initialization', () => assert.equal(balance(), 5));
for (const [type, quantity, expected] of [['IN',3,8], ['OUT',2,3], ['ADJUST',-2,3], ['ADJUST',2,7], ['RETURN',3,8]]) {
  test('post-initialization ' + type + ' ' + quantity, () => assert.equal(balance({ transactions: [tx(type, quantity)] }), expected));
}
test('excluded history and synthetic pending IN never count twice', () => {
  assert.equal(balance({ transactions: [tx('IN',100,{excluded_by_initialization_id:'init',transaction_date:'2026-08-24'}), tx('IN',5,{excluded_by_initialization_id:'init'})] }), 5);
});
test('voided transaction contributes nothing', () => assert.equal(balance({ transactions: [tx('OUT',2,{is_voided:true})] }), 5));
test('RETURN appears as inflow and return detail but adds to closing only once', () => {
  const [row] = calculate(options({transactions:[tx('RETURN',3)]}));
  assert.equal(row.monthly_in,3); assert.equal(row.monthly_return,3); assert.equal(row.closing_quantity,8);
});
test('item with no initialization retains prior snapshot rather than current opening', () => assert.equal(balance({initializationBaselines:[]}), 2));
test('same month uses per-item baseline membership, including zero initialized opening', () => {
  const rows=calculate(options({items:[item(),item('b',50),item('c',0)],previousClosingItems:[snapshot(),snapshot('b',7),snapshot('c',8)],initializationBaselines:[baseline(),baseline('c')]}));
  assert.deepEqual(rows.map(r=>[r.inventory_item_id,r.closing_quantity]),[['a',5],['b',7]]);
});
test('next month resumes new CLOSED snapshot without replaying September ledger', () => {
  assert.equal(balance({month:'10',previousClosing:closing('09','2026-10-01T00:00:00Z'),previousClosingItems:[snapshot('a',8,'sep')],transactions:[tx('IN',3),tx('OUT',2,{transaction_date:'2026-10-02'})]}),6);
});
test('missing next-month snapshot carries baseline plus intervening effective ledger once', () => {
  assert.equal(balance({month:'10',previousClosing:null,previousClosingItems:[],transactions:[tx('IN',3),tx('OUT',2,{transaction_date:'2026-10-02'})]}),6);
});
test('future initialization does not displace an earlier period snapshot', () => {
  assert.equal(balance({initializationBaselines:[baseline('a','2026-10-31')]}),2);
});
test('inclusive baseline cutoff and a valid backdated transaction use transaction_date, not created_at', () => {
  assert.equal(balance({transactions:[tx('IN',100,{transaction_date:'2026-08-31'}),tx('IN',3,{transaction_date:'2026-09-01',created_at:'2026-09-02T00:00:00Z'})]}),8);
});
test('mid-month reset cuts stale snapshot and pre-baseline ledger without hardcoded dates', () => {
  assert.equal(balance({year:'2027',month:'02',previousClosing:{...closing('01'),year:'2027',closed_at:'2027-02-01T00:00:00Z'},initializationBaselines:[{...baseline('a','2027-02-14'),initialized_at:'2027-02-14T16:00:00Z'}],transactions:[tx('IN',30,{transaction_date:'2027-02-14'}),tx('IN',3,{transaction_date:'2027-02-15'})]}),8);
});
test('snapshot sealed before an applicable reset cannot override its baseline', () => {
  assert.equal(balance({month:'10',previousClosing:closing('09','2026-09-29T00:00:00Z'),initializationBaselines:[{...baseline(),initialized_at:'2026-10-01T00:00:00Z'}]}),5);
});
test('date boundary is stable in Taipei, UTC and America/Los_Angeles', () => {
  const input=options({initializationBaselines:[{...baseline(),initialized_at:'2026-08-31T16:30:00Z'}],transactions:[tx('IN',3,{transaction_date:'2026-09-01',created_at:'2026-08-31T17:00:00Z'}),tx('OUT',2,{transaction_date:'2026-09-30'}),tx('IN',99,{transaction_date:'2026-10-01'})]});
  const source='const load=require('+JSON.stringify(path.join(__dirname,'test-load-ts.cjs'))+'); const r=load('+JSON.stringify(reportPath)+').calculateInventoryMonthlyReport('+JSON.stringify(input)+');process.stdout.write(String(r[0].closing_quantity));';
  for(const TZ of ['Asia/Taipei','UTC','America/Los_Angeles']) assert.equal(execFileSync(process.execPath,['-e',source],{env:{...process.env,TZ},encoding:'utf8'}),'6');
});
test('projection leaves all snapshot and initialization input objects unchanged', () => {
  const input=options(); const before=JSON.stringify(input);
  input.previousClosingItems.forEach(Object.freeze); Object.freeze(input.previousClosingItems);
  calculate(input); assert.equal(JSON.stringify(input),before);
});
test('Excel serializes the exact projection result without another balance calculation', () => {
  const rows=calculate(options({transactions:[tx('IN',3)]}));
  const {workbook}=buildMonthlyReportWorkbook('2026','09','OPEN',rows,[],[],[],[item()]);
  const parsed=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1});
  assert.equal(parsed[5][3],5); assert.equal(parsed[5][8],8);
});

// Exercise the real page's CLOSED/OPEN selection, effect dependencies and export
// callbacks, using the same lightweight hook harness style as existing tests.
const React=require('react');
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree?.props?[tree,...nodes(tree.props.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(''):tree?.props?text(tree.props.children):typeof tree==='string'||typeof tree==='number'?String(tree):'';
async function pageHarness({closed=false,metadataFailure=false}={}) {
  let si=0,ei=0,tree,baselineReads=0,projectionCalls=0;
  const states=[],effects=[],pending=[],exports=[];
  const react={...React,useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],value=>states[i]=typeof value==='function'?value(states[i]):value];},useMemo:fn=>fn(),useEffect(fn,deps){const i=ei++;const old=effects[i];if(!old||deps.some((x,j)=>!Object.is(x,old.deps[j]))){pending.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:fn()};});}}};
  const closings=[closing(),...(closed?[closing('09','2026-10-01T00:00:00Z')]:[])];
  const frozen=Object.freeze({...snapshot('a',2,'sep'),id:'historical',opening_quantity:2,monthly_in:0,monthly_out:0,monthly_return:0,monthly_adjust:0});
  const {default:Page}=load(path.join(__dirname,'../app/inventory/monthly/page.tsx'),{
    react,
    '@/components/UserContext':{useUser:()=>({currentUser:{role:'EDITOR'}})},
    '@/lib/db':{dbAdapter:{getInventoryItems:async()=>[item()],getInventoryTransactions:async()=>[],getInventoryTransactionSerials:async()=>[],getInventorySerials:async()=>[],getMonthlyClosings:async()=>closings,getMonthlyClosingItems:async id=>id==='sep'?[frozen]:[snapshot()]}},
    '@/lib/db/inventory-initialization':{getInventoryMonthlyInitializationBaselines:async()=>{baselineReads++;if(metadataFailure)throw new Error('baseline unavailable');return [baseline()];}},
    '@/lib/db/inventory-monthly-report':{...load(reportPath),calculateInventoryMonthlyReport:opts=>{projectionCalls++;return calculate(opts);}},
    '@/lib/utils/export-excel':{exportMonthlyReport:(...args)=>exports.push(args)},
  });
  function render(){si=ei=0;tree=Page();while(pending.length)pending.shift()();return tree;}
  async function settle(){for(let i=0;i<6;i++){render();await new Promise(resolve=>setImmediate(resolve));}render();}
  render();const selects=nodes(tree).filter(n=>n.type==='select');selects[0].props.onChange({target:{value:'2026'}});selects[1].props.onChange({target:{value:'09'}});await settle();
  return {render,settle,exports,frozen,get baselineReads(){return baselineReads;},get projectionCalls(){return projectionCalls;},button(label){return nodes(render()).find(n=>n.type==='button'&&text(n)===label);},selectMonth(month){nodes(render()).filter(n=>n.type==='select')[1].props.onChange({target:{value:month}});}};
}
test('OPEN page passes per-item metadata to calculation and exports its result',async()=>{
  const h=await pageHarness();const button=h.button('匯出 Excel');assert.equal(button.props.disabled,false);button.props.onClick();assert.equal(h.exports[0][3][0].closing_quantity,5);
});
test('historical CLOSED page exports the immutable snapshot, never the new baseline',async()=>{
  const h=await pageHarness({closed:true});const calls=h.projectionCalls;h.render();assert.equal(h.projectionCalls,calls);h.button('匯出 Excel').props.onClick();assert.equal(h.exports[0][2],'CLOSED');assert.strictEqual(h.exports[0][3][0],h.frozen);assert.equal(h.exports[0][3][0].closing_quantity,2);
  const reads=h.baselineReads;await h.settle();assert.equal(h.baselineReads,reads);
});
test('metadata load failure blocks OPEN export and closing; CLOSED remains readable',async t=>{
  t.mock.method(console,'error',()=>{});
  const h=await pageHarness({metadataFailure:true});assert(h.button('匯出 Excel').props.disabled);assert(h.button('封存本月').props.disabled);h.button('匯出 Excel').props.onClick();assert.equal(h.exports.length,0);
  const closed=await pageHarness({closed:true,metadataFailure:true});assert.equal(closed.button('匯出 Excel').props.disabled,false);
});
test('switching open months reloads applicable baseline metadata',async()=>{
  const h=await pageHarness();const reads=h.baselineReads;h.selectMonth('10');await h.settle();assert(h.baselineReads>reads);h.button('匯出 Excel').props.onClick();assert.equal(h.exports[0][1],'10');assert.equal(h.exports[0][3][0].closing_quantity,5);
});

function baselineLoader(responses) {
  const ranges=[];let index=0;
  const query={select(){return this;},order(){return this;},async range(from,to){ranges.push([from,to]);return responses[index++];}};
  const api=load(path.join(__dirname,'db/inventory-initialization.ts'),{'./supabaseClient':{supabase:{from(table){assert.equal(table,'inventory_initialization_items');return query;}}}});
  return {read:api.getInventoryMonthlyInitializationBaselines,ranges};
}
test('metadata loader reads all pages and preserves per-item relation membership',async()=>{
  const row={inventory_item_id:'a',inventory_initializations:{baseline_date:'2026-08-31',initialized_at:'2026-09-01T15:31:36Z'}};
  const h=baselineLoader([{data:Array.from({length:500},()=>row),error:null},{data:[{...row,inventory_item_id:'b',inventory_initializations:[row.inventory_initializations]}],error:null}]);
  const rows=await h.read();assert.equal(rows.length,501);assert.equal(rows[500].inventory_item_id,'b');assert.deepEqual(h.ranges,[[0,499],[500,999]]);
});
test('metadata loader fails closed on query error or incomplete relation',async()=>{
  await assert.rejects(baselineLoader([{data:null,error:new Error('denied')}]).read(),/denied/);
  await assert.rejects(baselineLoader([{data:[{inventory_item_id:'a',inventory_initializations:[]}],error:null}]).read(),/基準資料不完整/);
});
