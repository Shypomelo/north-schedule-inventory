// LOCAL only: independent psql sessions with observed database lock waits.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const pg = 'C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const args = ['-X','-h','127.0.0.1','-p','55447','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-Atq'];
const sync = sql => execFileSync(pg,args,{input:sql,encoding:'utf8'}).trim();
const id = (kind,n) => `79000000-0000-4000-${kind}-${String(n).padStart(12,'0')}`;
const quote = value => value == null ? 'NULL' : `'${String(value).replaceAll("'","''")}'`;
const auth = `SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true); SET LOCAL ROLE authenticated;`;
function session(sql,name,onData) {
  let out='',err=''; const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});
  child.stdout.on('data',b=>{out+=b;onData?.(out);});child.stderr.on('data',b=>err+=b);child.stdin.end(sql);
  return new Promise(resolve=>child.on('close',code=>resolve({code,out,err})));
}
async function race(label,first,second,successes) {
  let release;const ready=new Promise(resolve=>release=resolve);
  const a=session(`BEGIN; ${auth} SELECT ${first}; SELECT 'LOCKED'; SELECT pg_sleep(2); COMMIT;`,'equipment-race-a',out=>{if(out.includes('LOCKED'))release();});
  let timer;
  try {await Promise.race([ready,a.then(r=>{if(r.code)throw Error(r.err);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('barrier timeout')),8000);})]);}finally{clearTimeout(timer);}
  const b=session(`BEGIN; ${auth} SELECT ${second}; COMMIT;`,'equipment-race-b');
  let locked=false;
  for(let n=0;n<25;n++){await new Promise(resolve=>setTimeout(resolve,40));if(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='equipment-race-b' AND wait_event_type='Lock'")==='1'){locked=true;break;}}
  const results=await Promise.all([a,b]);assert(locked,`${label}: lock wait required`);
  assert.equal(results.filter(r=>r.code===0).length,successes,results.map(r=>r.err).join('\n'));
  for(const result of results.filter(r=>r.code!==0))assert.match(result.err,/EQUIPMENT_CONFLICT|Serial is not available/);
  console.log(`PASS ${label}: observed lock wait; ${successes} successful responses`);return results;
}
const pick = n => JSON.parse(sync(`SELECT c FROM app_private.maintenance_equipment_candidates((SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1))c WHERE c->>'serial'='EQR${String(n).padStart(6,'0')}-AA'`));
const register=(request,task,c)=>`public.register_maintenance_equipment_replacement('${id(6000,request)}','${id(9000,task)}',${quote(c.inventory_serial_id)},${quote(c.se_supply_record_id)},'2026-08-01T06:00:00Z','equipment concurrency',${quote(c.version)},true)`;
const cleanup=`BEGIN;
DELETE FROM app_private.maintenance_equipment_requests WHERE request_id::text LIKE '79000000-%';
DELETE FROM activity_logs WHERE target_id IN(SELECT id::text FROM maintenance_equipment_records WHERE schedule_task_id::text LIKE '79000000-%') OR target_id IN(SELECT id::text FROM inventory_transactions WHERE item_id='${id(8000,1)}');
DELETE FROM maintenance_equipment_records WHERE schedule_task_id::text LIKE '79000000-%';
DELETE FROM se_supply_records WHERE id::text LIKE '79000000-%';
DELETE FROM inventory_transaction_serials WHERE transaction_id IN(SELECT id FROM inventory_transactions WHERE item_id='${id(8000,1)}');
DELETE FROM inventory_serials WHERE item_id='${id(8000,1)}';
DELETE FROM inventory_batches WHERE item_id='${id(8000,1)}';
DELETE FROM inventory_transactions WHERE item_id='${id(8000,1)}';
DELETE FROM schedule_tasks WHERE id::text LIKE '79000000-%';
DELETE FROM inventory_items WHERE id='${id(8000,1)}';COMMIT;`;
(async()=>{
 assert.equal(sync("SELECT count(*) FROM inventory_items WHERE id::text LIKE '79000000-%'"),'0');
 try {
  sync(`INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial,is_se_maintenance_equipment) VALUES('${id(8000,1)}','EQ-RACE','EQ-RACE','台','設備維修',0,true,true);
   INSERT INTO schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id) SELECT ('79000000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'[TEST equipment race]',CURRENT_DATE,'維修','已排程',(SELECT id::text FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),(SELECT id FROM work_groups ORDER BY id LIMIT 1) FROM generate_series(1,6)n;
   INSERT INTO se_supply_records(id,new_model,new_serial,quantity) SELECT ('79000000-0000-4000-7000-'||lpad(n::text,12,'0'))::uuid,'EQ-RACE','EQR'||lpad(n::text,6,'0')||'-AA',1 FROM generate_series(1,3)n;
   BEGIN;${auth} SELECT public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id','${id(8000,1)}','quantity',5,'transaction_type','IN','transaction_date',CURRENT_DATE),'["EQR000001-AA","EQR000002-AA","EQR000004-AA","EQR000005-AA","EQR000006-AA"]');COMMIT;`);
  const one=pick(1);const same=await race('same request BOTH retry',register(1,1,one),register(1,1,one),2);
  assert(same[1].out.includes('"already_registered": true'));
  await race('same BOTH serial / different schedules',register(2,2,pick(2)),register(3,3,pick(2)),1);
  await race('SE-only competing requests',register(4,4,pick(3)),register(5,5,pick(3)),1);
  const ordinary=`public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id','${id(8000,1)}','quantity',1,'transaction_type','OUT','transaction_date',CURRENT_DATE,'project_id',(SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1)),'["EQR000004-AA"]')`;
  await race('equipment vs ordinary canonical OUT',register(6,6,pick(4)),ordinary,1);
  await race('same schedule same item different devices',register(7,6,pick(5)),register(8,6,pick(6)),2);
  assert.equal(sync(`SELECT count(*) FROM maintenance_equipment_records WHERE schedule_task_id='${id(9000,6)}'`),'3');
  assert.equal(sync(`SELECT count(*) FROM inventory_transactions WHERE item_id='${id(8000,1)}' AND transaction_type='OUT'`),'5');
  sync(`BEGIN;${auth} SELECT public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id','${id(8000,1)}','quantity',2,'transaction_type','IN','transaction_date',CURRENT_DATE),'["EQR000007-AA","EQR000008-AA"]');COMMIT;`);
  const event=()=>JSON.parse(sync(`SELECT to_jsonb(e) FROM maintenance_equipment_records e WHERE request_id='${id(6000,7)}'`));
  const correct=(request,e,c)=>`public.correct_maintenance_equipment_replacement('${id(6000,request)}','${e.id}',${quote(c.inventory_serial_id)},${quote(c.se_supply_record_id)},'2026-08-02T06:00:00Z','correction race',${quote(c.version)},${e.revision},true)`;
  const seven=correct(10,event(),pick(7));
  const retried=await race('same correction request retry',seven,seven,2);
  assert(retried[1].out.includes('"already_corrected": true'));
  const before=event(),eight=pick(8);
  await race('competing corrections reject stale revision',correct(11,before,eight),correct(12,before,eight),1);
  assert.equal(event().revision,3);
 } finally {sync(cleanup);assert.equal(sync("SELECT (SELECT count(*) FROM maintenance_equipment_records WHERE schedule_task_id::text LIKE '79000000-%')+(SELECT count(*) FROM inventory_items WHERE id::text LIKE '79000000-%')+(SELECT count(*) FROM se_supply_records WHERE id::text LIKE '79000000-%')"),'0');console.log('PASS concurrency fixtures cleaned');}
})().catch(error=>{console.error(error);process.exitCode=1;});
