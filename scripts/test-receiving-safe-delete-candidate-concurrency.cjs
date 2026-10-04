// Candidate-only true DB concurrency. The Management API requests use separate PG sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ref = 'fssogssryeunkjkdgewx';
assert.notEqual(ref, 'dghozkqvxlwpjmgleekw');
assert(process.env.SUPABASE_ACCESS_TOKEN, 'SUPABASE_ACCESS_TOKEN_REQUIRED');
const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const ids = Object.fromEntries(['project','item','batch','arrivalSource','matchSource','deleteArrival',
  'arrival','seed','deleteMatch','match'].map(k => [k, randomUUID()]));
const runId = randomUUID(), tag = runId.replaceAll('-', '').slice(0, 10);
const marker = `[TEST SAFE DELETE RACE ${tag}]`;
const file = path.resolve('.codex-logs/safe-delete', `${runId}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const report = { ref, runId, marker, ids, status: 'PREFLIGHT', races: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
save();
const q = v => "'" + String(v).replaceAll("'", "''") + "'";
const pause = ms => new Promise(r => setTimeout(r, ms));
async function sql(query, readOnly = true, timeout = 60000) {
  const res = await fetch(endpoint + (readOnly ? '/read-only' : ''), {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }), signal: AbortSignal.timeout(timeout),
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try { const parsed = JSON.parse(body); message = parsed.message || parsed.error || body; } catch {}
    throw Error(`SQL_${res.status}: ${String(message).slice(0, 450)}`);
  }
  return body ? JSON.parse(body) : [];
}
const one = async query => (await sql(query))[0];
const guard = `IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard
  WHERE project_ref=${q(ref)} AND purpose='CANDIDATE_REVIEW')
  THEN RAISE EXCEPTION 'CANDIDATE_ONLY'; END IF;`;
const actor = `(SELECT id FROM public.team_members WHERE role='admin' AND is_active
  AND deleted_at IS NULL ORDER BY id LIMIT 1)`;
const claims = `jsonb_build_object('email',(SELECT email FROM public.team_members WHERE
  role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),
  'role','authenticated')::text`;
function rpc(expr, label) {
  return `WITH ctx AS MATERIALIZED (SELECT
    set_config('request.jwt.claims',${claims},true) AS claims,
    set_config('application_name',${q(label)},true) AS label)
    SELECT pg_backend_pid() pid,${expr} result FROM ctx`;
}
async function setup() {
  assert.equal(Number((await one(`SELECT count(*) n FROM review_private.environment_guard
    WHERE project_ref=${q(ref)} AND purpose='CANDIDATE_REVIEW'`)).n), 1);
  await sql(`DO $$ BEGIN ${guard}
    INSERT INTO public.projects(id,project_name) VALUES(${q(ids.project)},${q(marker)});
    INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,
      is_se_maintenance_equipment,canonical_identity_key)
    VALUES(${q(ids.item)},${q('TEST-SAFE-DELETE-' + tag)},${q(marker + ' item')},
      'pcs','General',false,false,${q('TEST_SAFE_DELETE_RACE_' + ids.item)});
    INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by)
      VALUES(${q(ids.batch)},${q(ids.project)},${q(marker)},${actor});
    INSERT INTO public.project_materials(id,project_id,batch_id,item_name,quantity,unit,
      created_by,inventory_item_id,delivery_destination) VALUES
      (${q(ids.arrivalSource)},${q(ids.project)},${q(ids.batch)},${q(marker + ' arrival')},
        1,'pcs',${actor},${q(ids.item)},'OFFICE'),
      (${q(ids.matchSource)},${q(ids.project)},${q(ids.batch)},${q(marker + ' match')},
        1,'pcs',${actor},${q(ids.item)},'OFFICE');
  END $$;`, false);
  report.status = 'FIXTURES_CREATED'; save();
}
const code = e => String(e?.message || e).match(/MATCH_PENDING_INACTIVE|PENDING_DELETE_(?:DOWNSTREAM_EXISTS|VERSION_CONFLICT|INACTIVE)/)?.[0] || '';
async function race(name, source, deleteExpr, otherExpr) {
  const labels = [`sd_${tag}_${name}_barrier`,`sd_${tag}_${name}_delete`,
    `sd_${tag}_${name}_other`];
  const result = { name, source, labels };
  const barrier = sql(`BEGIN; SET LOCAL statement_timeout='35s';
    SET LOCAL application_name=${q(labels[0])};
    SELECT id FROM public.project_materials WHERE id=${q(source)} FOR UPDATE;
    SELECT pg_sleep(25); COMMIT;`, false, 45000);
  let released = false, left, right, leftDone = false, rightDone = false;
  barrier.finally(() => { released = true; }).catch(() => {});
  try {
    let held = false;
    for (let i = 0; i < 30; i++) {
      held = Number((await one(`SELECT count(*) n FROM pg_stat_activity
        WHERE application_name=${q(labels[0])} AND state='active'`)).n) === 1;
      if (held) break;
      await pause(200);
    }
    assert(held && !released, 'BARRIER_NOT_HELD');
    left = sql(rpc(deleteExpr, labels[1]), false).then(
      x => { leftDone = true; return { ok: true, pid: x[0]?.pid, result: x[0]?.result }; },
      e => { leftDone = true; return { ok: false, error: code(e), detail: e.message }; });
    right = sql(rpc(otherExpr, labels[2]), false).then(
      x => { rightDone = true; return { ok: true, pid: x[0]?.pid, result: x[0]?.result }; },
      e => { rightDone = true; return { ok: false, error: code(e), detail: e.message }; });
    for (let i = 0; i < 45 && !released; i++) {
      const rows = await sql(`SELECT pid,application_name,wait_event_type,
        pg_blocking_pids(pid) blockers FROM pg_stat_activity
        WHERE application_name IN (${labels.slice(1).map(q).join(',')})`);
      if (rows.length === 2 && rows.every(r => r.wait_event_type === 'Lock')
        && new Set(rows.map(r => Number(r.pid))).size === 2 && !leftDone && !rightDone) {
        result.waitingBeforeRelease = rows;
        break;
      }
      await pause(200);
    }
    result.barrierHeld = !released;
    result.bothUnresolved = !leftDone && !rightDone;
    await barrier;
    result.outcomes = await Promise.all([left, right]);
    report.races.push(result); save();
    assert(result.waitingBeforeRelease && result.barrierHeld && result.bothUnresolved,
      'TRUE_CONCURRENCY_NOT_PROVEN');
    if (result.outcomes.every(x => x.ok)) throw Error('RACE_BUG_BOTH_SUCCEEDED');
    assert.equal(result.outcomes.filter(x => x.ok).length, 1, 'NO_SINGLE_WINNER');
    assert.match(result.outcomes.find(x => !x.ok).error,
      /MATCH_PENDING_INACTIVE|PENDING_DELETE_(?:DOWNSTREAM_EXISTS|VERSION_CONFLICT|INACTIVE)/);
    return result;
  } finally {
    await barrier.catch(() => {});
    if (left && right) await Promise.allSettled([left, right]);
  }
}
async function sourceState(source) {
  return one(`SELECT m.receiving_deleted_at IS NOT NULL deleted,
    m.receiving_archived_at IS NOT NULL archived,
    (SELECT count(*) FROM public.receiving_arrival_matches x WHERE x.project_material_id=m.id) matches,
    (SELECT count(*) FROM public.material_receipts r WHERE r.project_material_id=m.id) source_receipts,
    (SELECT count(*) FROM public.activity_logs a WHERE a.action='DELETE_RECEIVING_PENDING'
      AND a.target_id=m.id::text) delete_audits,
    (SELECT count(*) FROM public.receiving_serial_entries e WHERE e.project_material_id=m.id
      AND e.retired_at IS NULL) active_serials
    FROM public.project_materials m WHERE m.id=${q(source)}`);
}
async function inventoryState() {
  return one(`SELECT
    (SELECT count(*) FROM public.inventory_transactions WHERE item_id=${q(ids.item)}) transactions,
    (SELECT count(*) FROM public.material_receipts r JOIN public.receiving_arrival_lines l
      ON l.id=r.arrival_line_id WHERE l.inventory_item_id=${q(ids.item)}) receipts,
    (SELECT count(*) FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l
      ON l.id=m.arrival_line_id WHERE l.inventory_item_id=${q(ids.item)}) matches,
    (SELECT count(*) FROM public.receiving_arrival_match_serials s
      JOIN public.receiving_arrival_matches m ON m.id=s.match_id
      JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
      WHERE l.inventory_item_id=${q(ids.item)}) serial_links,
    (SELECT COALESCE(sum(CASE WHEN transaction_type='IN' THEN quantity
      WHEN transaction_type='OUT' THEN -quantity ELSE 0 END),0)
      FROM public.inventory_transactions WHERE item_id=${q(ids.item)} AND NOT is_voided) balance`);
}
async function integrity() {
  const a = await sourceState(ids.arrivalSource), m = await sourceState(ids.matchSource);
  const inv = await inventoryState(), x = report.races[0].outcomes, y = report.races[1].outcomes;
  const arrivals = await one(`SELECT count(*) FILTER (WHERE notes=${q(marker + ' arrival')}) race,
    count(*) FILTER (WHERE notes=${q(marker + ' seed')}) seed
    FROM public.receiving_arrivals WHERE project_id=${q(ids.project)}`);
  const orphan = await one(`SELECT count(*) n FROM public.receiving_arrival_matches x
    LEFT JOIN public.project_materials p ON p.id=x.project_material_id
    LEFT JOIN public.receiving_arrival_lines l ON l.id=x.arrival_line_id
    LEFT JOIN public.receiving_arrivals r ON r.id=l.arrival_id
    WHERE x.project_material_id IN (${q(ids.arrivalSource)},${q(ids.matchSource)})
      AND (p.id IS NULL OR l.id IS NULL OR r.id IS NULL)`);
  assert.equal(Boolean(a.deleted), x[0].ok); assert.equal(Boolean(a.archived), x[0].ok);
  assert.equal(Boolean(m.deleted), y[0].ok); assert.equal(Boolean(m.archived), y[0].ok);
  assert.equal(Number(a.matches), x[1].ok ? 1 : 0);
  assert.equal(Number(m.matches), y[1].ok ? 1 : 0);
  assert.equal(Number(a.delete_audits), x[0].ok ? 1 : 0);
  assert.equal(Number(m.delete_audits), y[0].ok ? 1 : 0);
  assert.equal(Number(a.source_receipts) + Number(m.source_receipts), 0);
  assert.equal(Number(a.active_serials) + Number(m.active_serials), 0);
  assert.equal(Number(arrivals.race), x[1].ok ? 1 : 0);
  assert.equal(Number(arrivals.seed), 1);
  assert.equal(Number(inv.receipts), x[1].ok ? 2 : 1);
  assert.equal(Number(inv.transactions), Number(inv.receipts));
  assert.equal(Number(inv.balance), Number(inv.receipts));
  assert.equal(Number(inv.matches), Number(a.matches) + Number(m.matches));
  assert.equal(Number(inv.serial_links) + Number(orphan.n), 0);
  report.integrity = { arrivalSource: a, matchSource: m, inventory: inv, arrivals, orphans: 0 };
  save();
}
async function cleanup() {
  if (report.status === 'PREFLIGHT') return;
  const sources = [ids.arrivalSource, ids.matchSource].map(q).join(',');
  await sql(`BEGIN;
    DO $$ BEGIN ${guard}
      IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=${q(ids.project)}
        AND project_name=${q(marker)}) THEN RAISE EXCEPTION 'FIXTURE_PROJECT_MISMATCH'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.inventory_items WHERE id=${q(ids.item)}
        AND canonical_identity_key=${q('TEST_SAFE_DELETE_RACE_' + ids.item)})
        THEN RAISE EXCEPTION 'FIXTURE_ITEM_MISMATCH'; END IF;
    END $$;
    CREATE TEMP TABLE sd_lines ON COMMIT DROP AS SELECT l.id FROM public.receiving_arrival_lines l
      JOIN public.receiving_arrivals a ON a.id=l.arrival_id
      WHERE a.project_id=${q(ids.project)} AND a.notes LIKE ${q(marker + '%')};
    CREATE TEMP TABLE sd_targets ON COMMIT DROP AS
      SELECT id::text value FROM public.project_materials WHERE id IN (${sources})
      UNION SELECT id::text FROM public.receiving_arrivals WHERE project_id=${q(ids.project)}
      UNION SELECT id::text FROM sd_lines
      UNION SELECT id::text FROM public.material_receipts WHERE arrival_line_id IN (SELECT id FROM sd_lines)
      UNION SELECT id::text FROM public.receiving_arrival_matches WHERE project_material_id IN (${sources})
      UNION SELECT id::text FROM public.inventory_transactions WHERE item_id=${q(ids.item)};
    DELETE FROM public.activity_logs WHERE target_id IN (SELECT value FROM sd_targets)
      OR changes::text LIKE ${q('%' + ids.item + '%')}
      OR changes::text LIKE ${q('%' + ids.project + '%')}
      OR changes::text LIKE ${q('%' + ids.arrivalSource + '%')}
      OR changes::text LIKE ${q('%' + ids.matchSource + '%')};
    DELETE FROM app_private.receiving_requests WHERE request_id IN
      (${[ids.deleteArrival,ids.arrival,ids.seed,ids.deleteMatch,ids.match].map(q).join(',')})
      OR payload::text LIKE ${q('%' + ids.item + '%')}
      OR payload::text LIKE ${q('%' + ids.project + '%')}
      OR payload::text LIKE ${q('%' + ids.arrivalSource + '%')}
      OR payload::text LIKE ${q('%' + ids.matchSource + '%')};
    DELETE FROM public.receiving_arrival_match_serials WHERE match_id IN
      (SELECT id FROM public.receiving_arrival_matches WHERE project_material_id IN (${sources})
        OR arrival_line_id IN (SELECT id FROM sd_lines));
    DELETE FROM public.receiving_arrival_matches WHERE project_material_id IN (${sources})
      OR arrival_line_id IN (SELECT id FROM sd_lines);
    UPDATE public.receiving_arrival_lines SET receipt_id=NULL,resolution_state='UNRESOLVED',posting_date=NULL
      WHERE id IN (SELECT id FROM sd_lines);
    DELETE FROM public.material_receipts WHERE arrival_line_id IN (SELECT id FROM sd_lines);
    DELETE FROM public.receiving_serial_entries WHERE arrival_line_id IN (SELECT id FROM sd_lines)
      OR project_material_id IN (${sources});
    DELETE FROM public.receiving_arrival_lines WHERE id IN (SELECT id FROM sd_lines);
    DELETE FROM public.receiving_arrivals WHERE project_id=${q(ids.project)}
      AND notes LIKE ${q(marker + '%')};
    DELETE FROM public.inventory_batches WHERE item_id=${q(ids.item)};
    DELETE FROM public.inventory_transactions WHERE item_id=${q(ids.item)};
    DELETE FROM public.project_materials WHERE id IN (${sources});
    DELETE FROM public.project_material_batches WHERE id=${q(ids.batch)};
    DELETE FROM public.inventory_items WHERE id=${q(ids.item)};
    DELETE FROM public.projects WHERE id=${q(ids.project)};
    COMMIT;`, false);
  const remaining = await one(`SELECT
    (SELECT count(*) FROM public.projects WHERE id=${q(ids.project)})+
    (SELECT count(*) FROM public.inventory_items WHERE id=${q(ids.item)})+
    (SELECT count(*) FROM public.project_material_batches WHERE id=${q(ids.batch)})+
    (SELECT count(*) FROM public.project_materials WHERE id IN (${sources}))+
    (SELECT count(*) FROM public.receiving_arrivals WHERE project_id=${q(ids.project)})+
    (SELECT count(*) FROM public.inventory_transactions WHERE item_id=${q(ids.item)})+
    (SELECT count(*) FROM public.inventory_batches WHERE item_id=${q(ids.item)})+
    (SELECT count(*) FROM public.receiving_arrival_matches WHERE project_material_id IN (${sources}))+
    (SELECT count(*) FROM app_private.receiving_requests WHERE payload::text LIKE
      ${q('%' + ids.arrivalSource + '%')} OR payload::text LIKE ${q('%' + ids.matchSource + '%')})+
    (SELECT count(*) FROM public.activity_logs WHERE changes::text LIKE
      ${q('%' + ids.project + '%')} OR changes::text LIKE ${q('%' + ids.item + '%')}) n`);
  assert.equal(Number(remaining.n), 0, 'FIXTURE_CLEANUP_NONZERO');
  report.cleanup = 0; save();
}
async function main() {
  try {
    await setup();
    const versionA = (await one(`SELECT updated_at::text v FROM public.project_materials
      WHERE id=${q(ids.arrivalSource)}`)).v;
    await race('arrival', ids.arrivalSource,
      `public.delete_receiving_pending_source(${q(ids.deleteArrival)},'PROJECT_MATERIAL',
        ${q(ids.arrivalSource)},${q(versionA)}::timestamptz)`,
      `public.create_receiving_arrival(${q(ids.arrival)},'2099-03-15T00:00:00Z',
        ${q(JSON.stringify([{inventory_item_id:ids.item,quantity:1}]))}::jsonb,
        ${q(ids.project)},${q(marker + ' arrival')},'2099-03-15',
        ${q(JSON.stringify([{line_index:0,project_material_id:ids.arrivalSource,quantity:1}]))}::jsonb,true)`);
    const seeded = (await sql(rpc(`public.create_receiving_arrival(${q(ids.seed)},
      '2099-03-15T00:00:00Z',
      ${q(JSON.stringify([{inventory_item_id:ids.item,quantity:1}]))}::jsonb,
      ${q(ids.project)},${q(marker + ' seed')},'2099-03-15','[]'::jsonb,true)`,
      `sd_${tag}_seed`), false))[0]?.result;
    const lineId = seeded?.lines?.[0]?.id;
    assert(lineId, 'MATCH_SEED_LINE_MISSING');
    const before = await inventoryState();
    const versionM = (await one(`SELECT updated_at::text v FROM public.project_materials
      WHERE id=${q(ids.matchSource)}`)).v;
    await race('match', ids.matchSource,
      `public.delete_receiving_pending_source(${q(ids.deleteMatch)},'PROJECT_MATERIAL',
        ${q(ids.matchSource)},${q(versionM)}::timestamptz)`,
      `public.match_receiving_arrival_line(${q(ids.match)},${q(lineId)},1,
        ${q(ids.matchSource)},NULL,'{}'::uuid[])`);
    const after = await inventoryState();
    assert.equal(Number(after.transactions), Number(before.transactions), 'MATCH_CHANGED_INVENTORY');
    assert.equal(Number(after.balance), Number(before.balance), 'MATCH_CHANGED_BALANCE');
    await integrity();
    report.status = 'PASS'; save();
  } catch (e) {
    report.status = 'BLOCKED'; report.firstFailure = String(e.message || e); save();
  } finally {
    try { await cleanup(); }
    catch (e) { report.status = 'BLOCKED_CLEANUP_REQUIRED'; report.cleanupFailure = String(e.message || e); save(); }
    console.log(JSON.stringify({status:report.status,races:report.races,integrity:report.integrity,
      cleanup:report.cleanup,firstFailure:report.firstFailure,cleanupFailure:report.cleanupFailure,file}));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}
main();
