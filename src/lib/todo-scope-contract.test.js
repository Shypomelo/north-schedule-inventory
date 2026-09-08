const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260908155148_scope_private_and_team_todos.sql'),
  'utf8',
);

test('todo scope migration defines the private row contract', () => {
  assert.match(migration, /ADD COLUMN scope text NOT NULL DEFAULT 'TEAM'/);
  assert.match(migration, /CHECK \(scope IN \('TEAM', 'PRIVATE'\)\)/);
  for (const field of [
    'project_id', 'task_type', 'assigned_to', 'assigned_by', 'converted_task_id',
    'rejected_by', 'rejected_at', 'rejection_reason',
  ]) {
    assert.match(migration, new RegExp(`${field} IS NULL`));
  }
  assert.match(migration, /status IN \('待安排', '已完成'\)/);
});

test('todo RLS replaces permissive policies with scoped policies', () => {
  assert.match(migration, /DROP POLICY IF EXISTS "Enable read access for active members" ON public\.todos/);
  assert.match(migration, /scope = 'TEAM'/);
  assert.match(migration, /scope = 'PRIVATE'[\s\S]*created_by = \(SELECT app_private\.current_member_id\(\)\)/);
  assert.match(migration, /"Editors can update their private todos"[\s\S]*USING[\s\S]*WITH CHECK/);
  assert.doesNotMatch(migration, /CREATE POLICY "Enable read access for active members"/);
});

test('private todos never enter shared activity logs and cannot be rejected', () => {
  assert.match(migration, /TG_OP = 'INSERT' AND NEW\.scope = 'PRIVATE'/);
  assert.match(migration, /TG_OP = 'UPDATE' AND \(OLD\.scope = 'PRIVATE' OR NEW\.scope = 'PRIVATE'\)/);
  assert.match(migration, /WHERE todo\.id = p_todo_id\s+AND todo\.scope = 'TEAM'/);
  assert.match(migration, /WHERE id = p_todo_id\s+AND scope = 'TEAM'/);
});

test('todo scope transitions are rejected by the update trigger', () => {
  const transitionMigration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260908160036_lock_todo_scope_transitions.sql'),
    'utf8',
  );
  assert.match(transitionMigration, /OLD\.scope IS DISTINCT FROM NEW\.scope/);
  assert.match(transitionMigration, /RAISE EXCEPTION 'Todo scope cannot be changed'/);
  assert.match(transitionMigration, /CREATE OR REPLACE FUNCTION app_private\.set_todo_updated_at\(\)/);
});
