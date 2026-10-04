const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');
const load = require('./test-load-ts.cjs');
const { buildMonthlyReportWorkbook } = load(path.join(__dirname, 'utils/export-excel.ts'));
const { calculateInventoryMonthlyReport } = load(path.join(__dirname, 'db/inventory-monthly-report.ts'));

const makeItem = (id = 'item', opening_quantity = 5) => ({ id, name: id, unit: 'pcs', is_active: true, opening_quantity });
const makeTransaction = (id, extra = {}) => ({
  id, item_id: 'item', transaction_type: 'IN', transaction_date: '2026-09-02',
  created_at: '2026-09-02T00:00:00Z', quantity: 3, notes: id, ...extra,
});
const project = (items, transactions) => calculateInventoryMonthlyReport({year:'2026', month:'09', items, transactions});
function exported(summary, transactions = [], status = 'OPEN') {
  const { workbook } = buildMonthlyReportWorkbook('2026', '09', status, summary, transactions);
  // Verify the serialized XLSX, including actual cell types, ranges and filters.
  const bytes = XLSX.write(workbook, { type:'buffer', bookType:'xlsx', cellDates:true });
  const roundtrip = XLSX.read(bytes, { type:'buffer', cellDates:true, cellStyles:true });
  const sheet = roundtrip.Sheets[roundtrip.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, blankrows:true });
  const detailTitle = rows.findIndex(row => row[0] === '當月異動明細');
  return { sheet, rows, summaryHeader:rows[4], summary:rows.slice(5, 5 + summary.length), detailHeader:rows[detailTitle + 1], details:rows.slice(detailTitle + 2), detailHeaderRow:detailTitle + 2 };
}

test('active detail remains; voided row and its notes disappear from XLSX', () => {
  const transactions = [makeTransaction('active'), makeTransaction('voided-private-note', {is_voided:true})];
  const result = exported(project([makeItem()], transactions), transactions);
  assert.deepEqual(result.details.map(row => row[6]), ['active']);
  assert(!JSON.stringify(result.rows).includes('voided-private-note'));
});

test('voided credit/debit never changes monthly closing or exported closing', () => {
  const active = makeTransaction('active');
  const voided = [makeTransaction('void-in',{is_voided:true,quantity:100}),makeTransaction('void-out',{is_voided:true,transaction_type:'OUT',quantity:50})];
  const expected = project([makeItem()], [active]);
  const actual = project([makeItem()], [active,...voided]);
  assert.deepEqual(actual, expected);
  assert.equal(exported(actual, [active,...voided]).summary[0][9], 8);
});

test('IN reversal remains a business column without restoring debug columns', () => {
  const transactions = [makeTransaction('in'), makeTransaction('reversal', {
    transaction_type: 'IN_REVERSAL', quantity: 2, reverses_transaction_id: 'in',
  })];
  const result = exported(project([makeItem()], transactions), transactions);
  assert.equal(result.summary[0][5], 2);
  assert.equal(result.summary[0][9], 6);
  assert.deepEqual(result.details.map(row => row[1]), ['IN', '入庫沖回']);
  assert.equal(result.details[1].length, 7);
});

test('summary has only consecutive business columns and no notes/debug output', () => {
  const summary = project([makeItem()], []);
  summary[0].notes = '截圖顯示另有進貨；請匯入後再補實際紀錄；SE提供未入庫';
  const result = exported(summary);
  assert.deepEqual(result.summaryHeader, ['品項','分類','單位','期初','入庫','入庫沖回','退料','出庫','調整','期末','來源','品項狀態']);
  assert.equal(result.summary[0].length, 12);
  assert(!JSON.stringify(result.rows).includes(summary[0].notes));
  assert.equal(XLSX.utils.decode_range(result.sheet['!ref']).e.c, 11);
  assert.equal(result.sheet['!cols'].length, 12);
  assert.equal(result.sheet.M5, undefined);
});

test('detail columns and autofilter end at G with no empty old void column', () => {
  const transactions = [makeTransaction('active'), makeTransaction('void',{is_voided:true})];
  const result = exported(project([makeItem()], transactions), transactions);
  assert.deepEqual(result.detailHeader, ['日期','異動類型','品項','數量','案場','序號','備註']);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].length, 7);
  assert.equal(result.sheet['H'+result.detailHeaderRow], undefined);
  assert.equal(result.sheet['H'+(result.detailHeaderRow+1)], undefined);
  assert.equal(result.sheet['!autofilter'].ref, 'A'+result.detailHeaderRow+':G'+(result.detailHeaderRow+1));
  assert(result.details[0][0] instanceof Date);
});

test('all-voided month has no detail rows, stale autofilter or old void header', () => {
  const transactions = [makeTransaction('void',{is_voided:true})];
  const result = exported(project([makeItem()], transactions), transactions);
  assert.equal(result.details.length, 0);
  assert.equal(result.sheet['!autofilter'], undefined);
  assert(!result.rows.flat().includes('是否作廢'));
});

test('all 35 supplied monthly rows retain the exact UI closing quantities', () => {
  const items = Array.from({length:35}, (_,i) => makeItem('item-'+i, i+1));
  const transactions = items.flatMap((item,i) => [
    makeTransaction('active-'+i,{item_id:item.id,transaction_type:i%2?'OUT':'IN',quantity:1}),
    makeTransaction('void-'+i,{item_id:item.id,is_voided:true,quantity:1000}),
  ]);
  const ui = project(items, transactions);
  const excel = exported(ui, transactions);
  assert.equal(ui.length, 35);
  assert.equal(excel.summary.length, 35);
  assert.deepEqual(excel.summary.map(row=>[row[0],row[9]]), ui.map(row=>[row.item_name,row.closing_quantity]));
  assert.equal(excel.details.length, 35);
});

test('CLOSED summary keeps stored snapshot numbers and does not mutate source data', () => {
  const summary = project([makeItem('item',2)], []);
  summary[0].notes = 'historical note remains stored';
  const transactions = [makeTransaction('later',{quantity:99}),makeTransaction('void',{is_voided:true})];
  const before = JSON.stringify({summary,transactions});
  summary.forEach(Object.freeze); transactions.forEach(Object.freeze);
  Object.freeze(summary); Object.freeze(transactions);
  const result = exported(summary, transactions, 'CLOSED');
  assert.equal(result.rows[1][1], '已封存');
  assert.equal(result.summary[0][3], 2);
  assert.equal(result.summary[0][9], 2);
  assert.equal(JSON.stringify({summary,transactions}), before);
});

test('export-only filter preserves nonvoid legacy rows, month selection and ordering', () => {
  const transactions = [
    makeTransaction('later',{transaction_date:'2026-09-03'}),
    makeTransaction('legacy',{is_voided:null,excluded_by_initialization_id:'init'}),
    makeTransaction('outside',{transaction_date:'2026-10-01'}),
    makeTransaction('earlier',{is_voided:false,transaction_date:'2026-09-01'}),
  ];
  const result = exported(project([makeItem()], transactions), transactions);
  assert.deepEqual(result.details.map(row=>row[6]), ['earlier','legacy','later']);
});
