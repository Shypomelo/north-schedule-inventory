const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  combineTaipeiReceiptDateTime,
  formatCompactTaipeiReceiptTime,
  getEffectiveExpectedDeliveryAt,
  parseReceiptDateInput,
  parseReceiptTimeInput,
} = require('./test-load-ts.cjs')(path.join(__dirname, 'material-receipt-time.ts'));

test('receipt date parser accepts compact and separated inputs with future-year rollover', () => {
  const now = new Date('2026-12-20T02:00:00Z');
  for (const value of ['0127', '01.27', '01-27', '01/27']) {
    assert.equal(parseReceiptDateInput(value, now), '2027-01-27');
  }
  assert.equal(parseReceiptDateInput('2027/01/27', now), '2027-01-27');
  assert.equal(parseReceiptDateInput('2027-01-27', now), '2027-01-27');
  for (const value of ['1332', '02/31', '']) {
    assert.equal(parseReceiptDateInput(value, now), null);
  }
});

test('receipt time parser normalizes fast keyboard input', () => {
  assert.equal(parseReceiptTimeInput('900'), '09:00');
  assert.equal(parseReceiptTimeInput('0900'), '09:00');
  assert.equal(parseReceiptTimeInput('09:00'), '09:00');
  assert.equal(parseReceiptTimeInput('1430'), '14:30');
  assert.equal(parseReceiptTimeInput('14:30'), '14:30');
  assert.equal(parseReceiptTimeInput('2460'), null);
  assert.equal(parseReceiptTimeInput(''), null);
  assert.equal(combineTaipeiReceiptDateTime('2027-01-27', '0900'), '2027-01-27T01:00:00.000Z');
});

test('effective receipt time is material override then batch default', () => {
  const batch = { planned_receipt_at: '2026-09-22T01:00:00Z' };
  assert.equal(getEffectiveExpectedDeliveryAt({ expected_delivery_at: null }, batch), batch.planned_receipt_at);
  assert.equal(getEffectiveExpectedDeliveryAt({ expected_delivery_at: '2026-09-25T06:00:00Z' }, batch), '2026-09-25T06:00:00Z');
});

test('compact receipt time omits the year without changing the stored instant', () => {
  assert.equal(formatCompactTaipeiReceiptTime('2026-09-22T01:00:00Z'), '09/22 09:00');
  assert.equal(formatCompactTaipeiReceiptTime(null), '—');
});
