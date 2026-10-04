const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { receivingReminderBucket } = load(path.resolve(__dirname, 'receiving-reminders.ts'));

const now = new Date('2026-10-04T04:00:00Z'); // October 4 in Taipei.
const row = (expectedAt, remaining = 1) => ({
  kind: 'PROJECT_MATERIAL', id: 'material-1', expectedAt,
  fulfilment: { active: remaining > 0, remaining },
});
const data = (days = 3, enabled = true) => ({
  materials: [{ id: 'material-1', reminder_enabled: enabled, reminder_days_before: days }],
});

test('arrival reminders use each material lead time and Taipei calendar day', () => {
  assert.equal(receivingReminderBucket(row('2026-10-07T02:00:00Z'), data(), now), 'upcoming');
  assert.equal(receivingReminderBucket(row('2026-10-08T02:00:00Z'), data(), now), null);
  assert.equal(receivingReminderBucket(row('2026-10-04T23:00:00+08:00'), data(), now), 'today');
  assert.equal(receivingReminderBucket(row('2026-10-03T23:00:00+08:00'), data(), now), 'overdue');
});

test('received and disabled materials leave the active reminder list', () => {
  assert.equal(receivingReminderBucket(row('2026-10-04T12:00:00+08:00', 0), data(), now), null);
  assert.equal(receivingReminderBucket(row('2026-10-04T12:00:00+08:00'), data(3, false), now), null);
});
