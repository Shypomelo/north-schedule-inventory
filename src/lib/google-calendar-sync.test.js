const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'google-calendar-sync.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const {
  buildGoogleEventBody,
  deleteGoogleEventForScheduleTask,
  ensureGoogleEventForScheduleTask,
  getScheduleTaskFromSyncRow,
} = sourceModule.exports;

const calendarId = 'calendar@example.com';
const syncedAt = '2026-09-03T00:00:00.000Z';

const createTask = (overrides = {}) => ({
  id: 'task-1',
  task_type: 'Maintenance',
  title: 'Inspect inverter',
  project_id: null,
  project_name: 'North Site',
  address: 'Taipei',
  task_date: '2026-09-10',
  start_time: '09:00',
  end_time: '10:00',
  is_all_day: false,
  is_tentative: false,
  status: 'Scheduled',
  primary_member_id: null,
  primary_member_name: null,
  assistant_member_ids: [],
  assistant_member_names: [],
  google_calendar_id: calendarId,
  google_event_id: 'old-event',
  google_sync_status: 'synced',
  google_sync_error: null,
  last_synced_at: null,
  created_by: 'system',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const createSupabase = (task) => {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, 'schedule_tasks');
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: task, error: null };
                },
              };
            },
          };
        },
        update(payload) {
          return {
            async eq(column, value) {
              updates.push({ column, value, payload });
              return { error: null };
            },
          };
        },
      };
    },
  };
};

const createCalendar = (overrides = {}) => {
  const calls = { delete: [], get: [], insert: [], update: [] };
  return {
    calls,
    events: {
      async delete(params) {
        calls.delete.push(params);
      },
      async get(params) {
        calls.get.push(params);
        return { data: {} };
      },
      async insert(params) {
        calls.insert.push(params);
        return { data: { id: 'new-event' } };
      },
      async update(params) {
        calls.update.push(params);
      },
      ...overrides,
    },
  };
};

test('unbound schedule task creates a Google event and stores the new binding', async () => {
  const task = createTask({ google_event_id: null, google_calendar_id: null });
  const supabase = createSupabase(task);
  const calendar = createCalendar();

  const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

  assert.deepEqual(result, { action: 'created', eventId: 'new-event' });
  assert.equal(calendar.calls.insert.length, 1);
  assert.equal(supabase.updates.length, 1);
  assert.deepEqual(supabase.updates[0].payload, {
    google_event_id: 'new-event',
    google_calendar_id: calendarId,
    google_sync_status: 'synced',
    google_sync_error: null,
    last_synced_at: syncedAt,
  });
});

for (const goneState of [404, 410]) {
  test(`bound event GET ${goneState} recreates Google event without deleting the schedule task`, async () => {
    const task = createTask();
    const supabase = createSupabase(task);
    const calendar = createCalendar({
      async get() {
        const error = new Error('gone');
        error.status = goneState;
        throw error;
      },
    });

    const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

    assert.deepEqual(result, { action: 'recreated', eventId: 'new-event' });
    assert.equal(calendar.calls.insert.length, 1);
    assert.equal(supabase.updates[0].value, task.id);
    assert.equal(supabase.updates[0].payload.google_event_id, 'new-event');
  });
}

test('cancelled bound event is recreated and rebound to the same schedule task', async () => {
  const task = createTask();
  const supabase = createSupabase(task);
  const calendar = createCalendar({ async get() { return { data: { status: 'cancelled' } }; } });

  const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

  assert.equal(result.action, 'recreated');
  assert.equal(supabase.updates[0].value, task.id);
  assert.equal(supabase.updates[0].payload.google_event_id, 'new-event');
});

for (const failure of [
  { label: '401', status: 401 },
  { label: '403', status: 403 },
  { label: '429', status: 429 },
  { label: '5xx', status: 500 },
  { label: 'network error', status: undefined },
]) {
  test(`non-gone GET ${failure.label} is surfaced and does not mutate a schedule task`, async () => {
    const task = createTask();
    const supabase = createSupabase(task);
    const calendar = createCalendar({
      async get() {
        const error = new Error(`get failed: ${failure.label}`);
        error.status = failure.status;
        throw error;
      },
    });

    await assert.rejects(
      ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt),
      new RegExp(failure.label),
    );
    assert.equal(calendar.calls.insert.length, 0);
    assert.equal(supabase.updates.length, 0);
  });
}

test('bound Google changes are overwritten from Schedule without writing Google content into Schedule', async () => {
  const task = createTask();
  const supabase = createSupabase(task);
  const calendar = createCalendar({
    async get() {
      return {
        data: {
          summary: 'Changed remotely',
          start: { dateTime: '2026-09-11T11:00:00+08:00' },
          end: { dateTime: '2026-09-11T12:00:00+08:00' },
        },
      };
    },
  });

  const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

  assert.equal(result.action, 'updated');
  assert.equal(calendar.calls.update.length, 1);
  assert.equal(calendar.calls.update[0].eventId, 'old-event');
  assert.deepEqual(Object.keys(supabase.updates[0].payload).sort(), [
    'google_calendar_id',
    'google_sync_error',
    'google_sync_status',
    'last_synced_at',
  ]);
});

test('equivalent bound event does not consume a Google update call', async () => {
  const task = createTask();
  const desiredEvent = await buildGoogleEventBody(createSupabase(task), getScheduleTaskFromSyncRow(task));
  const supabase = createSupabase(task);
  const calendar = createCalendar({ async get() { return { data: desiredEvent }; } });

  const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

  assert.equal(result.action, 'unchanged');
  assert.equal(calendar.calls.update.length, 0);
  assert.equal(supabase.updates[0].payload.google_sync_status, 'synced');
});

test('event disappearing during update is recreated and rebound', async () => {
  const task = createTask();
  const supabase = createSupabase(task);
  const calendar = createCalendar({
    async get() {
      return { data: { summary: 'Changed remotely' } };
    },
    async update() {
      const error = new Error('gone during update');
      error.status = 410;
      throw error;
    },
  });

  const result = await ensureGoogleEventForScheduleTask(supabase, calendar, task, calendarId, syncedAt);

  assert.deepEqual(result, { action: 'recreated', eventId: 'new-event' });
  assert.equal(calendar.calls.insert.length, 1);
  assert.equal(supabase.updates[0].payload.google_event_id, 'new-event');
});

test('Google delete success and 404/410 are safe terminal outcomes', async () => {
  assert.equal(
    await deleteGoogleEventForScheduleTask(createCalendar(), calendarId, 'old-event'),
    'deleted',
  );
  assert.equal(
    await deleteGoogleEventForScheduleTask(createCalendar(), calendarId, null),
    'not_bound',
  );

  for (const status of [404, 410]) {
    const calendar = createCalendar({
      async delete() {
        const error = new Error('gone');
        error.status = status;
        throw error;
      },
    });
    assert.equal(
      await deleteGoogleEventForScheduleTask(calendar, calendarId, 'old-event'),
      'already_missing',
    );
  }
});

test('Google delete 403/429/5xx/network failures are surfaced', async () => {
  for (const failure of [
    { label: '403', status: 403 },
    { label: '429', status: 429 },
    { label: '500', status: 500 },
    { label: 'network', status: undefined },
  ]) {
    const calendar = createCalendar({
      async delete() {
        const error = new Error(`delete failed: ${failure.label}`);
        error.status = failure.status;
        throw error;
      },
    });
    await assert.rejects(
      deleteGoogleEventForScheduleTask(calendar, calendarId, 'old-event'),
      new RegExp(failure.label),
    );
  }
});

test('schedule deletion syncs Google before hard-deleting the database row', () => {
  const dbAdapterSource = fs.readFileSync(path.join(__dirname, 'db', 'index.ts'), 'utf8');
  const deleteBlockStart = dbAdapterSource.indexOf('deleteScheduleTask: async');
  const deleteBlockEnd = dbAdapterSource.indexOf('// Contractors', deleteBlockStart);
  const deleteBlock = dbAdapterSource.slice(deleteBlockStart, deleteBlockEnd);

  const googleDelete = deleteBlock.indexOf("await syncToGoogle('DELETE'");
  const databaseDelete = deleteBlock.indexOf('await fn(id)');
  assert.ok(googleDelete >= 0, 'Google deletion must be invoked for a bound event');
  assert.ok(databaseDelete > googleDelete, 'database deletion must happen after Google deletion succeeds');
});

test('sync and reconcile routes contain no remote-deleted schedule hard-delete path', () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'api', 'google-calendar', 'sync', 'route.ts'),
    'utf8',
  );
  const reconcileSource = fs.readFileSync(
    path.join(__dirname, 'server', 'google-calendar-reconcile.ts'),
    'utf8',
  );

  assert.equal(routeSource.includes("from('schedule_tasks')\n    .delete()"), false);
  assert.equal(reconcileSource.includes("from('schedule_tasks').delete()"), false);
  assert.equal(reconcileSource.includes('dbUpdates.task_date'), false);
});
