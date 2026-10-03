const { chromium } = require('C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:3019');
    await page.getByRole('tab', { name: /^待收貨/ }).waitFor();
    await page.evaluate(() => {
      const s = window.__review.store, at = '2026-10-03T10:11:00+08:00';
      s.team_members = [{ id: 'reviewer', name: '測試員' }];
      for (const id of ['pure', 'se']) s.se_supply_records.push({ id, inventory_item_id: 'serial', new_model: `P401-${id}`,
        quantity: 7, unit: '台', receiving_only: true, procurement_status: 'ORDERED', project_id: 'north',
        expected_delivery_at: at, receiving_archived_at: null, receiving_deleted_at: null, cancelled_at: null, updated_at: at });
      for (const id of ['partial', 'receipt', 'site']) s.project_materials.push({ id, inventory_item_id: 'serial',
        item_name: `P401-${id}`, specification: '', quantity: 7, unit: '台', delivery_destination: 'OFFICE',
        project_id: 'north', expected_delivery_at: at, receiving_archived_at: null, receiving_deleted_at: null,
        cancelled_at: null, updated_at: at });
      s.receiving_serial_entries.push({ id: 'pure-entry', se_supply_record_id: 'pure', project_material_id: null,
        arrival_line_id: null, inventory_item_id: 'serial', raw_serial: 'PURE-AA', normalized_serial: 'PURE-AA',
        inventory_serial_id: null, active_receipt_id: null, retired_at: null, updated_at: at });
      sessionStorage.setItem('v5-fixture', JSON.stringify(s));
    });
    await page.reload();
    const pending = id => page.locator(`[data-pending-row="${id}"]`);
    const more = id => pending(id).locator('..').getByRole('button', { name: /更多操作/ });
    const menu = page.getByRole('menu', { name: '收貨操作' });
    const confirm = page.getByRole('alertdialog', { name: '刪除待收貨' });
    const deleteButton = confirm.getByRole('button', { name: '刪除', exact: true });
    const openDelete = async id => { await more(id).click(); await menu.getByRole('menuitem', { name: '刪除' }).click(); await confirm.waitFor(); };

    await pending('SE_SUPPLY:pure').click({ button: 'right', position: { x: 20, y: 20 } });
    assert.equal(await menu.count(), 1);
    assert.equal(await menu.getByRole('menuitem', { name: '刪除' }).count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await pending('SE_SUPPLY:pure').evaluate(element => element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerType: 'touch', pointerId: 51, clientX: 32, clientY: 180,
    })));
    await page.waitForTimeout(560);
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem', { name: '刪除' }).count(), 1);
    await pending('SE_SUPPLY:pure').evaluate(element => element.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerType: 'touch', pointerId: 51, clientX: 32, clientY: 180,
    })));
    await page.keyboard.press('Escape');
    await openDelete('SE_SUPPLY:pure');
    assert.match(await confirm.innerText(), /尚未產生到貨或後續紀錄/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(() => { window.__review.store.failDelete = true; window.__review.store.deleteDelayMs = 300; });
    await deleteButton.evaluate(button => { button.click(); button.click(); });
    await confirm.getByRole('alert').waitFor();
    assert.match(await confirm.getByRole('alert').innerText(), /無法刪除此筆待收貨/);
    assert.doesNotMatch(await confirm.innerText(), /permission denied/);
    assert.equal(await pending('SE_SUPPLY:pure').count(), 1);
    const failedRequest = await page.evaluate(() => window.__review.store.calls.filter(call => call.name === 'delete_receiving_pending_source'));
    assert.equal(failedRequest.length, 1);
    assert.match(failedRequest[0].args.p_request_id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual({ type: failedRequest[0].args.p_source_type, id: failedRequest[0].args.p_source_id,
      updatedAt: failedRequest[0].args.p_expected_updated_at }, { type: 'SE_SUPPLY', id: 'pure', updatedAt: '2026-10-03T10:11:00+08:00' });
    await page.evaluate(() => { window.__review.store.failDelete = false; });
    await deleteButton.evaluate(button => { button.click(); button.click(); });
    await pending('SE_SUPPLY:pure').waitFor({ state: 'detached' });
    const deleted = await page.evaluate(() => {
      const s = window.__review.store, row = s.se_supply_records.find(value => value.id === 'pure');
      return { row, entry: s.receiving_serial_entries.find(value => value.id === 'pure-entry'),
        calls: s.calls.filter(call => call.name === 'delete_receiving_pending_source'), inventoryWrites: s.inventoryWrites,
        legacy: s.material_receipts.find(value => value.id === 'legacy-receipt') };
    });
    assert.equal(deleted.calls.length, 2);
    assert.equal(deleted.calls[0].args.p_request_id, deleted.calls[1].args.p_request_id);
    assert.equal(deleted.row.receiving_archived_at, deleted.row.receiving_deleted_at);
    assert(deleted.entry.retired_at);
    assert.equal(deleted.inventoryWrites, 0);
    assert.equal(deleted.legacy.quantity_received, 2);
    await page.getByRole('tab', { name: /^已收到/ }).click();
    assert.match(await page.getByRole('tabpanel', { name: '已收到' }).innerText(), /歷史/);
    await page.getByRole('tab', { name: /^收貨紀錄/ }).click();
    assert.match(await page.getByRole('tabpanel', { name: '收貨紀錄' }).innerText(), /歷史/);
    await page.getByRole('tab', { name: /^待收貨/ }).click();

    const blocked = async (id, downstream) => {
      await openDelete(id);
      const before = await page.evaluate(() => {
        const s = window.__review.store;
        return JSON.stringify({ materials: s.project_materials, supplies: s.se_supply_records,
          matches: s.receiving_arrival_matches, receipts: s.material_receipts,
          allocations: s.receiving_inventory_allocations, transactions: s.inventory_transactions, inventoryWrites: s.inventoryWrites });
      });
      await deleteButton.click();
      await confirm.getByRole('alert').waitFor();
      assert.match(await confirm.getByRole('alert').innerText(), /此筆已有到貨或後續紀錄/);
      assert.equal(await pending(id).count(), 1);
      assert.equal(await page.evaluate(() => {
        const s = window.__review.store;
        return JSON.stringify({ materials: s.project_materials, supplies: s.se_supply_records,
          matches: s.receiving_arrival_matches, receipts: s.material_receipts,
          allocations: s.receiving_inventory_allocations, transactions: s.inventory_transactions, inventoryWrites: s.inventoryWrites });
      }), before, `${downstream} original data changed`);
      await confirm.getByRole('button', { name: '取消' }).click();
    };
    await page.evaluate(() => {
      const s = window.__review.store, at = '2026-10-03T10:12:00+08:00';
      s.receiving_arrivals.push({ id: 'partial-arrival', actual_received_at: at, project_id: 'north', created_by: 'reviewer', created_at: at, voided_at: null });
      s.receiving_arrival_lines.push({ id: 'partial-line', arrival_id: 'partial-arrival', inventory_item_id: 'serial', quantity: 3,
        unit: '台', resolution_state: 'STAGED', receipt_id: null, version: 1 });
      s.receiving_arrival_matches.push({ id: 'partial-match', arrival_line_id: 'partial-line', project_material_id: 'partial',
        se_supply_record_id: null, quantity: 3, cancelled_at: null, created_at: at });
    });
    await blocked('PROJECT_MATERIAL:partial', 'partial arrival');
    await page.evaluate(() => {
      const s = window.__review.store, at = '2026-10-03T10:13:00+08:00';
      s.inventory_transactions.push({ id: 'receipt-tx', item_id: 'serial', transaction_type: 'IN', quantity: 1,
        transaction_date: '2026-10-03', created_at: at, is_voided: false });
      s.material_receipts.push({ id: 'receipt-block', source_type: 'PROJECT_MATERIAL', project_material_id: 'receipt',
        event_type: 'RECEIVE', quantity_received: 1, receipt_location: 'OFFICE', inventory_transaction_id: 'receipt-tx',
        inventory_linked: true, received_at: at, created_at: at });
    });
    await blocked('PROJECT_MATERIAL:receipt', 'receipt and inventory');
    await page.evaluate(() => {
      const s = window.__review.store;
      s.receiving_inventory_allocations.push({ id: 'se-allocation', se_supply_record_id: 'se', project_material_id: null, route_type: 'SE' });
    });
    await blocked('SE_SUPPLY:se', 'SE allocation');
    await page.evaluate(() => {
      const s = window.__review.store;
      s.receiving_inventory_allocations.push({ id: 'site-allocation', project_material_id: 'site', se_supply_record_id: null, route_type: 'SITE' });
    });
    await blocked('PROJECT_MATERIAL:site', 'SITE allocation');
    await page.setViewportSize({ width: 1200, height: 844 });
    await openDelete('PROJECT_MATERIAL:site');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.keyboard.press('Escape');
    assert.equal(await confirm.count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS safe delete RPC, pure pending archive, stale partial/receipt/SE/SITE block, original data, retry id, double submit, errors, right-click/long-press/ellipsis, 390px/1200px');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
