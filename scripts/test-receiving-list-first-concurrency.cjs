// Local-only, unique disposable fixtures. No remote DSN is accepted.
const {execFileSync,spawn}=require('node:child_process'),assert=require('node:assert/strict');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const args=['-X','-h','127.0.0.1','-p','55453','-U','postgres','-d',process.env.RECEIVING_V4_TEST_DB||'receiving_v4_fresh_20260924','-v','ON_ERROR_STOP=1','-Atq'];
if(!/^receiving_v4_[a-z0-9_]+$/.test(args[8]))throw Error('Disposable receiving_v4 database required');
const sync=sql=>execFileSync(pg,args,{input:sql,encoding:'utf8'}).trim();const lit=x=>"'"+String(x).replaceAll("'","''")+"'";
const id=n=>`85000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const auth=`SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);SET LOCAL ROLE authenticated;`;
const project=sync('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
const run=q=>JSON.parse(sync(`BEGIN;${auth} SELECT ${q};COMMIT;`).split('\n').at(-1));
const arrival=(n,item,qty,names=[])=>run(`create_office_equipment_arrival('${id(n)}','${id(item)}',${qty},'2099-01-15',NULL,'[TEST V4 race]',${lit(JSON.stringify(names))})`).id;
const receive=(n,source,item,qty)=>`confirm_receiving_into_inventory('${id(n)}','SE_SUPPLY','${source}','${id(item)}',${qty},ARRAY(SELECT id FROM receiving_serial_entries WHERE se_supply_record_id='${source}' AND retired_at IS NULL),'2099-01-15','[TEST V4 race]')`;
const route=(n,receipt,kind,qty,serials=[])=>`route_receiving_inventory('${id(n)}','${receipt}','${kind}',${qty},ARRAY[${serials.map(lit).join(',')}]::uuid[],'${project}',NULL,true,'2099-01-15','[TEST V4 race]')`;
const cancel=(n,source)=>`cancel_receiving_arrival('${id(n)}','SE_SUPPLY','${source}','[TEST V4 race]',false)`;
function session(sql,name,onData){let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});child.stdout.on('data',b=>{stdout+=b;onData?.(stdout)});child.stderr.on('data',b=>stderr+=b);child.stdin.end(sql);return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));}
async function race(label,a,b,successes){let ready;const started=new Promise(r=>ready=r);let timer;const first=session(`BEGIN;${auth} SELECT ${a};SELECT 'LOCKED';SELECT pg_sleep(1.2);COMMIT;`,'v4-first',s=>{if(s.includes('LOCKED'))ready();});await Promise.race([started,new Promise((_,rej)=>timer=setTimeout(()=>rej(Error('lock timeout')),8000))]);clearTimeout(timer);const second=session(`BEGIN;${auth} SELECT ${b};COMMIT;`,'v4-second');await new Promise(r=>setTimeout(r,200));const waits=sync("select count(*) from pg_stat_activity where application_name='v4-second' and wait_event_type='Lock'");const results=await Promise.all([first,second]);assert.equal(waits,'1',label+' must wait on real lock');assert.equal(results.filter(r=>r.code===0).length,successes,results.map(r=>r.stderr).join('\n'));console.log('PASS '+label+'; observed Lock wait');}
(async()=>{
assert.equal(sync(`select count(*) from inventory_items where id='${id(1)}'`),'0','fresh fixtures required');
sync(`insert into inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) values('${id(1)}','[TEST V4 race] plain','[TEST V4 race] plain','個','一般',false,false),('${id(2)}','[TEST V4 race] serial','[TEST V4 race] serial','台','設備維修',true,true)`);
let source=arrival(10,1,20),receipt=run(receive(11,source,1,20)).id;
await race('same receipt route retry creates one OUT allocation',route(12,receipt,'SITE',5),route(12,receipt,'SITE',5),2);
assert.equal(sync(`select sum(quantity) from receiving_inventory_allocations where office_receipt_id='${receipt}'`),'5');
await race('competing quantities cannot over-allocate',route(13,receipt,'SITE',12),route(14,receipt,'SITE',12),1);
source=arrival(20,2,1,['V4RACE01-AA']);receipt=run(receive(21,source,2,1)).id;let serial=sync("select id from inventory_serials where serial_number='V4RACE01-AA'");
await race('SE routing wins; cancellation rejects',route(22,receipt,'SE',1,[serial]),cancel(23,source),1);
source=arrival(30,2,1,['V4RACE02-AA']);receipt=run(receive(31,source,2,1)).id;serial=sync("select id from inventory_serials where serial_number='V4RACE02-AA'");
await race('cancellation wins; stale routing rejects',cancel(32,source),route(33,receipt,'SE',1,[serial]),1);
source=arrival(40,2,1,['V4RACE03-AA']);await race('pending cancellation wins; stale receive rejects',cancel(41,source),receive(42,source,2,1),1);
source=arrival(50,2,1,['V4RACE04-AA']);run(receive(51,source,2,1));await race('same cancellation retry only one reversal',cancel(52,source),cancel(52,source),2);
assert.equal(sync(`select count(*) from material_receipts where se_supply_record_id='${source}' and event_type='REVERSAL'`),'1');
assert.equal(sync('select count(*) from app_private.inventory_routing_context'),'0');console.log('PASS 6 allocation/cancellation concurrency races');
})().catch(e=>{console.error(e);process.exitCode=1;});
