const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const toolsRoot = process.env.RECEIVING_UI_TOOLS || 'C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules';
const esbuild = require(path.join(toolsRoot, 'esbuild'));
const { chromium } = require(path.join(toolsRoot, 'playwright'));
const out = path.resolve('.codex-logs/receiving-ux-browser');
fs.mkdirSync(out, { recursive: true });
const fixture = path.resolve('scripts/receiving-ux-fixture.js');
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {ReceivingV6Center} from './src/components/ReceivingV6Center';
import {store} from 'receiving-ux-fixture';window.__review=store;
createRoot(document.getElementById('root')).render(<ReceivingV6Center/>);`;
async function main() {
  await esbuild.build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: path.join(out, 'app.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'receiving-ux-fixture', setup(build) {
      build.onResolve({ filter: /^(receiving-ux-fixture|@\/lib\/db\/receiving-v6|@\/lib\/db\/supabaseClient)$/ },
        () => ({ path: fixture }));
      build.onResolve({ filter: /UserContext$/ }, () => ({ path: fixture }));
    } }],
  });
  const css = fs.readdirSync('.next-verify/static/css').filter(name => name.endsWith('.css'))
    .sort((a, b) => fs.statSync(path.join('.next-verify/static/css', b)).size - fs.statSync(path.join('.next-verify/static/css', a)).size)[0];
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(out, 'app.js'))); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join('.next-verify/static/css', css))); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><main style="max-width:1160px;margin:auto;padding:12px"><div id="root"></div></main><script src="/app.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '＋預計收貨' }).waitFor();
    await page.getByRole('tab', { name: /已收到/ }).click();
    assert.equal(await page.locator('[data-received-batch]').count(), 3);
    const first = page.locator('[data-received-batch="box1"]');
    await first.locator('summary').first().click();
    assert.equal(await first.locator('[data-received-group]').count(), 1);
    assert.match(await first.innerText(), /待補資料.*8/);
    await first.getByText('查看序號 · 8').click();
    assert.match(await first.innerText(), /UXSN0008-AA/);
    await page.screenshot({ path: path.join(out, 'desktop-received.png') });
    await first.locator('[data-received-group]').click();
    const dialog = page.getByRole('dialog', { name: '已收到明細' });
    const resolver = dialog.getByRole('region', { name: '批次補品項' });
    assert.equal(await resolver.getByRole('checkbox').count(), 8);
    for (let index = 0; index < 4; index++) await resolver.getByRole('checkbox').nth(index).check();
    await resolver.getByRole('combobox', { name: '品項／型號' }).fill('SE4000H');
    await resolver.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await resolver.getByRole('button', { name: '套用到已選 4 台' }).click();
    await page.waitForFunction(() => window.__review.calls.some(call => call.name === 'completeBatch'));
    const resolved = await page.evaluate(() => window.__review.calls.find(call => call.name === 'completeBatch'));
    assert.equal(resolved.args.p_line_ids.length, 4);
    assert.equal(await page.evaluate(() => window.__review.snapshot.transactions.length), 0);
    await dialog.getByRole('button', { name: '關閉收貨工作' }).click();
    await page.getByRole('tab', { name: /收貨紀錄/ }).click();
    assert.equal(await page.locator('[data-history-batch]').count(), 3);
    const search = page.getByRole('searchbox');
    await search.fill('UXSN0008-AA');
    assert.equal(await page.locator('[data-history-batch]').count(), 1);
    await search.fill('SE4000H');
    assert.equal(await page.locator('[data-history-batch]').count(), 1);
    await search.fill('已完工案場');
    assert.equal(await page.locator('[data-history-batch]').count(), 2);
    await search.fill('10/03');
    await search.fill('');
    const historyBox = page.locator('[data-history-batch="box1"]');
    await historyBox.locator('summary').first().click();
    assert.match(await historyBox.innerText(), /待確認 × 4/);
    assert.match(await historyBox.innerText(), /SE4000H × 4/);
    assert.equal(await historyBox.getByText('查看序號 · 4').count(), 2);

    await page.getByRole('button', { name: '＋預計收貨' }).click();
    const pending = page.getByRole('dialog', { name: '預計收貨' });
    const form = pending.getByRole('form', { name: '預計收貨' });
    await form.getByRole('combobox', { name: /案件/ }).fill('已完工');
    await form.getByRole('combobox', { name: /案件/ }).press('Enter');
    assert.equal(await form.getByRole('combobox', { name: /案件/ }).inputValue(), '已完工案場');
    await form.getByRole('combobox', { name: /案件/ }).fill('已刪除');
    assert.equal(await form.getByRole('option').count(), 0);
    await form.getByRole('combobox', { name: /案件/ }).fill('已完工');
    await form.getByRole('combobox', { name: /案件/ }).press('Enter');
    const firstItem = form.getByRole('region', { name: '品項 1' });
    await firstItem.getByRole('combobox', { name: '品項／型號' }).fill('SE4000H');
    await firstItem.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await firstItem.getByRole('spinbutton', { name: '數量' }).fill('3');
    assert.equal(await firstItem.locator('details').first().getAttribute('open'), null);
    await firstItem.locator('summary').click();
    assert.equal(await firstItem.getByText('批次輸入').count(), 0);
    await firstItem.getByRole('button', { name: '掃碼預登' }).click();
    await page.getByRole('dialog', { name: '掃描序號' }).waitFor();
    await page.getByRole('dialog', { name: '掃描序號' }).getByRole('button', { name: '取消' }).click();
    await firstItem.getByRole('textbox', { name: '手動新增序號' }).fill('UXPLAN01-AA');
    await firstItem.getByRole('button', { name: '手動新增' }).click();
    await firstItem.getByText('UXPLAN01-AA').waitFor();
    await form.getByRole('button', { name: '＋新增品項' }).click();
    const secondItem = form.getByRole('region', { name: '品項 2' });
    await secondItem.getByRole('combobox', { name: '品項／型號' }).fill('P401');
    await secondItem.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await secondItem.getByRole('spinbutton', { name: '數量' }).fill('5');
    await secondItem.getByRole('button', { name: '明天' }).click();
    await form.getByRole('button', { name: '＋新增品項' }).click();
    const thirdItem = form.getByRole('region', { name: '品項 3' });
    await thirdItem.getByRole('combobox', { name: '品項／型號' }).fill('CABLE');
    await thirdItem.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await thirdItem.getByRole('spinbutton', { name: '數量' }).fill('7');
    await thirdItem.getByRole('textbox', { name: '品項 3 預計到貨日期' }).fill('2026-10-20');
    await page.screenshot({ path: path.join(out, 'desktop-pending.png') });
    await form.getByRole('button', { name: '建立預計收貨' }).click();
    await pending.waitFor({ state: 'hidden' });
    const create = await page.evaluate(() => window.__review.calls.filter(call => call.name === 'createPendingBatch'));
    assert.equal(create.length, 1);
    assert.deepEqual(create[0].args.p_items.map(item => item.quantity), [3, 5, 7]);
    assert.equal(new Set(create[0].args.p_items.map(item => item.expected_at)).size, 3);
    assert.deepEqual(create[0].args.p_items[0].serials, ['UXPLAN01-AA']);

    await page.getByRole('button', { name: '＋實際到貨' }).click();
    const actual = page.getByRole('dialog', { name: '實際到貨' });
    await actual.getByRole('button', { name: '散料' }).click();
    await actual.getByRole('combobox', { name: '品項／型號' }).fill('CABLE');
    await actual.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await actual.getByRole('spinbutton', { name: '實收數量' }).fill('2');
    await actual.getByRole('button', { name: '完成實際到貨' }).click();
    await actual.waitFor({ state: 'hidden' });
    const physical = await page.evaluate(() => window.__review.calls.filter(call => call.name === 'createBatches'));
    assert.equal(physical.length, 1);
    assert.equal(physical[0].args.p_batches[0].kind, 'LOOSE');
    assert.equal(await page.evaluate(() => window.__review.snapshot.transactions.length), 0);

    await page.getByRole('button', { name: '＋實際到貨' }).click();
    const boxed = page.getByRole('dialog', { name: '實際到貨' });
    await boxed.getByRole('button', { name: '開始一箱' }).click();
    const scanner = page.getByRole('dialog', { name: '實際到貨掃描' });
    await scanner.waitFor();
    await scanner.getByRole('button', { name: '＋ 手動輸入序號' }).click();
    const scanInput = scanner.getByRole('textbox', { name: '序號' });
    for (const code of ['UXBOX001-AA', 'UXBOX002-AA']) {
      await scanInput.fill(code);
      await scanner.getByRole('button', { name: '加入' }).click();
    }
    await scanner.getByRole('button', { name: '完成這箱' }).click();
    await scanInput.fill('UXBOX003-AA');
    await scanner.getByRole('button', { name: '加入' }).click();
    await scanner.getByRole('button', { name: '完成這箱' }).click();
    await scanner.getByRole('button', { name: '完成掃描' }).click();
    await scanner.waitFor({ state: 'hidden' });
    await boxed.getByRole('button', { name: '＋新增箱內品項' }).first().click();
    await boxed.getByRole('combobox', { name: '品項／型號' }).fill('CABLE');
    await boxed.getByRole('combobox', { name: '品項／型號' }).press('Enter');
    await boxed.getByRole('button', { name: '完成實際到貨' }).click();
    await boxed.waitFor({ state: 'hidden' });
    const boxedCall = await page.evaluate(() => window.__review.calls.filter(call => call.name === 'createBatches')[1]);
    assert.equal(boxedCall.args.p_batches.length, 2);
    assert.deepEqual(boxedCall.args.p_batches.map(batch => batch.kind), ['BOX', 'BOX']);
    assert.equal(boxedCall.args.p_batches[0].lines.length, 3);
    assert.equal(boxedCall.args.p_batches[1].lines.length, 1);
    const lastArrivals = await page.evaluate(() => window.__review.snapshot.arrivals.slice(-2));
    assert.notEqual(lastArrivals[0].id, lastArrivals[1].id);
    assert.equal(await page.evaluate(() => window.__review.snapshot.transactions.length), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: /已收到/ }).click();
    await page.screenshot({ path: path.join(out, 'mobile-received.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false);
    await page.getByText('新增', { exact: true }).click();
    await page.getByRole('button', { name: '＋預計收貨' }).click();
    const mobileForm = page.getByRole('dialog', { name: '預計收貨' });
    await mobileForm.getByRole('button', { name: '＋新增品項' }).click();
    await mobileForm.getByRole('button', { name: '＋新增品項' }).click();
    assert.equal(await mobileForm.getByRole('region', { name: /^品項 / }).count(), 3);
    await page.screenshot({ path: path.join(out, 'mobile-pending.png') });
    const modalOverflow = await mobileForm.evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(modalOverflow, false);
    assert.deepEqual(errors, []);
    console.log('RECEIVING UX BROWSER PASS: desktop 1200, mobile 390, pending multi-item, batch resolve, history search, loose receipt');
  } finally { await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
