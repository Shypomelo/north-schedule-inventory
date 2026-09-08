const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Fixed loopback target: never use PGHOST/PGDATABASE or a remote connection URL.
// Start an empty disposable PostgreSQL instance on port 55439 first.
const env = { ...process.env };
delete env.PGSERVICE;
delete env.PGSERVICEFILE;
delete env.PGOPTIONS;
delete env.PGHOSTADDR;
const result = spawnSync(process.argv[2] || 'psql', [
  '-X', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', '55439',
  '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  '-f', path.join(__dirname, '../supabase/tests/workflow-refresh-rls.sql'),
], { encoding: 'utf8', env });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) console.error(result.error.message);
// SQL prints all diagnostics and rolls back before this process reports failure.
process.exitCode = result.error || result.status !== 0 || /FAIL:/.test(result.stdout || '') ? 1 : 0;
