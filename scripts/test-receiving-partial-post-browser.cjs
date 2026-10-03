const { chromium } = require('C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:3019');
    await page.getByRole('tab', { name: /^已收到/ }).waitFor();
    await page.evaluate(() => {
      const s = window.__review.store;
      const at = '2026-10-03T10:11:00+08:00';
      s.inventory_transactions = []; s.inventory_transaction_serials = [];
      s.inventory_monthly_closings = []; s.team_members = [{ id: 'reviewer', name: '測試員' }];
      s.se_supply_records.push({ id: 'expected7', inventory_item_id: 'serial', new_model: 'P401', quantity: 7, unit: '台', receiving_only: true, procurement_status: 'ORDERED', project_id: 'north', expected_delivery_at: at, updated_at: at });
      for (const [id, quantity, itemId] of [['serial', 7, 'serial'], ['plain', 10, 'plain'], ['unknown', 1, null]]) {
        s.receiving_arrivals.push({ id: `arrival-${id}`, actual_received_at: at, project_id: 'north', notes: null, created_by: 'reviewer', created_at: at, voided_at: null });
        s.receiving_arrival_lines.push({ id: `line-${id}`, arrival_id: `arrival-${id}`, inventory_item_id: itemId, quantity, unit: itemId === 'serial' ? '台' : itemId === 'plain' ? 'm' : null, resolution_state: itemId ? 'STAGED' : 'UNRESOLVED', receipt_id: null, version: 1 });
        if (id !== 'plain') for (let n = 0; n < quantity; n++) s.receiving_serial_entries.push({ id: `entry-${id}-${n}`, arrival_line_id: `line-${id}`, inventory_item_id: itemId, raw_serial: `${id.toUpperCase()}${n}-AA`, normalized_serial: `${id.toUpperCase()}${n}-AA`, inventory_serial_id: null, active_receipt_id: null, retired_at: null });
      }
      s.receiving_arrival_matches.push({ id: 'matched7', arrival_line_id: 'line-serial', se_supply_record_id: 'expected7', project_material_id: null, quantity: 7, cancelled_at: null, created_at: at });
      for (let n = 0; n < 7; n++) s.receiving_arrival_match_serials.push({ match_id: 'matched7', arrival_entry_id: `entry-serial-${n}`, pending_entry_id: null, cancelled_at: null });
      sessionStorage.setItem('v5-fixture', JSON.stringify(s));
    });
    await page.reload();
    await page.getByRole('tab', { name: /^已收到/ }).click();
    const serial = page.locator('[data-received-group="item:serial"]');
    await serial.waitFor();
    assert.match(await serial.innerText(), /7 台/);
    await serial.click();
    let dialog = page.getByRole('dialog', { name: '已收到明細' });
    for (const width of [390, 1200]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px page overflow`);
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false, `${width}px detail overflow`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const submit = dialog.getByRole('button', { name: /^進庫存/ });
    assert(await submit.isDisabled());
    await dialog.getByRole('button', { name: '全選', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 7);
    await dialog.getByRole('button', { name: '取消全選' }).click();
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0);
    for (let n = 0; n < 3; n++) await dialog.getByRole('checkbox', { name: `選取序號 SERIAL${n}-AA` }).check();
    assert.match(await submit.innerText(), /3/);
    await page.evaluate(() => { window.__review.store.failPost = true; });
    await submit.click();
    await dialog.getByText('POST_TEST_FAILURE').waitFor();
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 3);
    assert.match(await serial.innerText(), /7 台/);
    await page.evaluate(() => { const s = window.__review.store; s.failPost = false; s.postDelayMs = 350; });
    await submit.evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => window.__review.store.calls.filter(call => call.name === 'post_receiving_arrival_line' && !call.error).length === 1);
    await page.waitForFunction(() => document.querySelector('[data-received-group="item:serial"]')?.textContent.includes('4 台'));
    const first = await page.evaluate(() => {
      const s = window.__review.store;
      return { calls: s.calls.filter(call => call.name === 'post_receiving_arrival_line' && !call.error), receipts: s.material_receipts.filter(row => row.source_type === 'ARRIVAL_ROUTE'), txs: s.inventory_transactions, entries: s.receiving_serial_entries.filter(row => row.arrival_line_id === 'line-serial').map(row => ({ id: row.id, serialId: row.inventory_serial_id })) };
    });
    assert.equal(first.calls.length, 1);
    assert.deepEqual(first.calls[0].args.p_entry_ids, ['entry-serial-0', 'entry-serial-1', 'entry-serial-2']);
    assert.equal(first.calls[0].args.p_quantity, 3);
    assert.equal(first.receipts[0].route_arrival_line_id, 'line-serial');
    assert.equal(first.receipts[0].inventory_transaction_id, first.txs[0].id);
    assert.equal(first.txs[0].transaction_type, 'IN');
    assert.equal(first.txs[0].source, 'ARRIVAL_ROUTE');
    assert(first.entries.slice(0, 3).every(row => row.serialId));
    assert(first.entries.slice(3).every(row => !row.serialId));
    await page.evaluate(() => { window.__review.store.postDelayMs = 0; });
    await dialog.getByRole('button', { name: '全選', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 4);
    await dialog.getByRole('button', { name: /^進庫存/ }).click();
    await serial.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog', { name: '已收到明細' }).count(), 0);
    const finished = await page.evaluate(() => {
      const s = window.__review.store;
      return { calls: s.calls.filter(call => call.name === 'post_receiving_arrival_line' && !call.error && call.args.p_line_id === 'line-serial'), links: s.inventory_transaction_serials, entries: s.receiving_serial_entries.filter(row => row.arrival_line_id === 'line-serial'), remaining: s.receiving_serial_entries.filter(row => row.arrival_line_id === 'line-serial' && !row.inventory_serial_id).length, pending: s.receiving_arrival_matches.find(row => row.id === 'matched7').quantity };
    });
    assert.deepEqual(finished.calls.map(call => call.args.p_quantity), [3, 4]);
    assert.equal(finished.links.length, 7);
    assert(finished.entries.every(entry => finished.links.some(link => link.serial_id === entry.inventory_serial_id)));
    assert.equal(finished.remaining, 0);
    assert.equal(finished.pending, 7);
    const unknown = page.locator('[data-received-group="arrival:line-unknown"]');
    assert.match(await unknown.innerText(), /待補資料/);
    await unknown.click();
    dialog = page.getByRole('dialog', { name: '已收到明細' });
    assert.equal(await dialog.getByRole('button', { name: /^進庫存/ }).count(), 0);
    await dialog.getByRole('button', { name: '關閉收貨工作' }).click();
    const plain = page.locator('[data-received-group="item:plain"]');
    await plain.click();
    dialog = page.getByRole('dialog', { name: '已收到明細' });
    const input = dialog.getByRole('spinbutton', { name: /進庫存數量/ });
    await input.fill('11');
    assert(await dialog.getByRole('button', { name: /^進庫存/ }).isDisabled());
    await input.fill('4');
    await dialog.getByRole('button', { name: /^進庫存/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-received-group="item:plain"]')?.textContent.includes('6 m'));
    assert.match(await plain.innerText(), /6 m/);
    await input.fill('6');
    await dialog.getByRole('button', { name: /^進庫存/ }).click();
    await plain.waitFor({ state: 'detached' });
    const plainCalls = await page.evaluate(() => window.__review.store.calls.filter(call => call.name === 'post_receiving_arrival_line' && !call.error && call.args.p_line_id === 'line-plain').map(call => ({ quantity: call.args.p_quantity, entries: call.args.p_entry_ids })));
    assert.deepEqual(plainCalls, [{ quantity: 4, entries: [] }, { quantity: 6, entries: [] }]);
    for (const width of [390, 1200]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px horizontal overflow`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS serial selection, 7→3→4→0, canonical IDs, 10→4→6→0, unresolved, duplicate click, RPC failure, refresh, 390px, 1200px');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
