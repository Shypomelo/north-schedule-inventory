const { getDbAdapter } = require('./src/lib/db/adapter');

async function debug() {
  const db = await getDbAdapter();
  const projects = await db.getProjects();
  const p = projects.find(x => x.project_code === 'B2026017');
  console.log("B2026017:", p);
}

debug().catch(console.error);
