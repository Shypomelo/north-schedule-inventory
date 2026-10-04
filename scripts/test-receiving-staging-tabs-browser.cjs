const { chromium } = require('C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:3019');
    await page.getByRole('tab', { name: /^待收貨/ }).waitFor();
    await page.evaluate(() => {
      const s = window.__review.store;
      const at = '2026-10-03T10:11:00+08:00';
      s.team_members = [{ id: 'reviewer', name: '測試員' }];
      s.se_supply_records.push({ id: 'expected7', inventory_item_id: 'serial', new_model: 'P401', quantity: 7, unit: '台', receiving_only: true, procurement_status: 'ORDERED', project_id: 'north', expected_delivery_at: at, updated_at: at });
      for (const [id, quantity, itemId] of [['first', 3, 'serial'], ['second', 4, 'serial'], ['unknown', 1, null]]) {
        s.receiving_arrivals.push({ id: `arrival-${id}`, actual_received_at: at, project_id: 'north', notes: null, created_by: 'reviewer', created_at: at, voided_at: null });
        s.receiving_arrival_lines.push({ id: `line-${id}`, arrival_id: `arrival-${id}`, inventory_item_id: itemId, quantity, unit: itemId ? '台' : null, resolution_state: itemId ? 'STAGED' : 'UNRESOLVED', receipt_id: null, version: 1 });
        for (let n = 0; n < quantity; n++) s.receiving_serial_entries.push({ id: `serial-${id}-${n}`, arrival_line_id: `line-${id}`, inventory_item_id: itemId, raw_serial: `${id.toUpperCase()}${n}-AA`, normalized_serial: `${id.toUpperCase()}${n}-AA`, inventory_serial_id: null, active_receipt_id: null, retired_at: null });
      }
      s.receiving_arrival_matches.push({ id: 'matched3', arrival_line_id: 'line-first', se_supply_record_id: 'expected7', project_material_id: null, quantity: 3, cancelled_at: null, created_at: at });
      for (let n = 0; n < 3; n++) s.receiving_arrival_match_serials.push({ match_id: 'matched3', arrival_entry_id: `serial-first-${n}`, pending_entry_id: null, cancelled_at: null });
      sessionStorage.setItem('v5-fixture', JSON.stringify(s));
    });
    await page.reload();
    await page.locator('[data-pending-row="SE_SUPPLY:expected7"]').waitFor();
    assert.match(await page.locator('[data-pending-row="SE_SUPPLY:expected7"]').innerText(), /待收 4/);
    assert.match(await page.locator('[data-pending-row="SE_SUPPLY:expected7"]').innerText(), /部分到貨/);
    await page.getByRole('button', { name: /更多操作：P401/ }).click();
    assert.equal(await page.getByRole('menuitem', { name: '查看明細' }).count(), 1);
    await page.getByRole('menuitem', { name: '查看明細' }).click();
    await page.getByRole('dialog', { name: '收貨工作' }).getByRole('button', { name: '關閉收貨工作' }).click();
    await page.getByRole('tab', { name: /^已收到/ }).click();
    await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
    const first = page.locator('[data-received-group="arrival:arrival-first:item:serial"]');
    const second = page.locator('[data-received-group="arrival:arrival-second:item:serial"]');
    const unknown = page.locator('[data-received-group="arrival:arrival-unknown:unresolved"]');
    await first.waitFor();
    assert.equal(await page.locator('[data-received-group]').count(), 3);
    assert.match(await first.innerText(), /P401/);
    assert.match(await first.innerText(), /3 台/);
    assert.match(await second.innerText(), /4 台/);
    assert.match(await first.innerText(), /待入庫/);
    assert.match(await unknown.innerText(), /待補資料/);
    await first.click();
    const dialog = page.getByRole('dialog', { name: '已收到明細' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox', { name: /選取序號 FIRST[0-2]-AA/ }).count(), 3);
    await dialog.getByRole('button', { name: '關閉收貨工作' }).click();
    await page.getByRole('tab', { name: /^收貨紀錄/ }).click();
    const historyBatch = page.locator('[data-history-batch="arrival-first"]');
    await historyBatch.evaluate(node => { node.open = true; });
    assert(await historyBatch.isVisible());
    assert.match(await historyBatch.innerText(), /P401/);
    await page.getByRole('tab', { name: /^已收到/ }).click();
    fs.mkdirSync('.codex-logs/receiving-staging-ui', { recursive: true });
    for (const width of [390, 1200]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${width}px horizontal overflow`);
      await page.screenshot({ path: `.codex-logs/receiving-staging-ui/received-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS tabs, pending remaining, staged grouping, unresolved badge, serial detail, history, mobile and desktop');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
