// Disposable LOCAL replay database only. No remote connection strings are accepted.
const {execFileSync,spawn}=require('node:child_process');const assert=require('node:assert/strict');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const args=['-X','-h','127.0.0.1','-p','5432','-U','postgres','-d','receiving_routing_replay','-v','ON_ERROR_STOP=1','-Atq'];
const sync=sql=>execFileSync(pg,args,{input:sql,encoding:'utf8'}).trim();
const id=n=>`83000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const lit=v=>`'${String(v).replaceAll("'","''")}'`;
const auth=`SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true); SET LOCAL ROLE authenticated;`;
const project=sync('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
const at='2099-01-15T06:00:00Z';
const run=expr=>JSON.parse(sync(`BEGIN; ${auth} SELECT ${expr}; COMMIT;`).split('\n').at(-1));
const inTx=(serial,qty=1)=>`public.write_inventory_transaction_atomic('CREATE',${lit(JSON.stringify({item_id:id(1),quantity:qty,transaction_type:'IN',transaction_date:'2099-01-15'}))}::jsonb,${lit(JSON.stringify(serial))}::jsonb)`;
const out=serial=>`public.write_inventory_transaction_atomic('CREATE',${lit(JSON.stringify({item_id:id(1),quantity:1,transaction_type:'OUT',transaction_date:'2099-01-15',project_id:project}))}::jsonb,${lit(JSON.stringify([serial]))}::jsonb)`;
const arrive=(n,serial)=>run(`public.create_office_equipment_arrival('${id(n)}','${id(1)}',1,'${at}',NULL,'[TEST concurrency]',${lit(JSON.stringify([serial]))})`).id;
const receive=(n,source)=>`public.confirm_receiving_into_inventory('${id(n)}','SE_SUPPLY','${source}','${id(1)}',1,ARRAY(SELECT id FROM receiving_serial_entries WHERE se_supply_record_id='${source}'),'${at}','[TEST concurrency]')`;
function session(sql,name,onData){let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});child.stdout.on('data',b=>{stdout+=b;onData?.(stdout)});child.stderr.on('data',b=>stderr+=b);child.stdin.end(sql);return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));}
async function race(label,a,b,successes){
 let ready;const started=new Promise(r=>ready=r);let timer;
 const first=session(`BEGIN; ${auth} SELECT ${a}; SELECT 'LOCKED'; SELECT pg_sleep(1.4); COMMIT;`,'receiving-race-first',s=>{if(s.includes('LOCKED'))ready()});
 await Promise.race([started,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('first session did not acquire locks')),5000))]);clearTimeout(timer);
 const second=session(`BEGIN; ${auth} SELECT ${b}; COMMIT;`,'receiving-race-second');
 await new Promise(r=>setTimeout(r,250));
 const waits=sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='receiving-race-second' AND wait_event_type='Lock'");
 const results=await Promise.all([first,second]);assert.equal(waits,'1',`${label}: second session must wait for actual DB lock`);assert.equal(results.filter(r=>r.code===0).length,successes,results.map(r=>r.stderr).join('\n'));console.log(`PASS ${label}; observed Lock wait`);
}
(async()=>{
 assert.equal(sync(`SELECT count(*) FROM inventory_items WHERE id='${id(1)}'`),'0','use a fresh replay database for each run');
 sync(`INSERT INTO inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES('${id(1)}','[TEST] race','[TEST] race','台','設備維修',true,true)`);
 let source=arrive(10,'RACE0001-AA');await race('same receipt request retry',receive(11,source),receive(11,source),2);
 assert.equal(sync(`SELECT count(*) FROM material_receipts WHERE se_supply_record_id='${source}'`),'1');
 source=arrive(20,'RACE0002-AA');await race('different requests cannot receive same unit twice',receive(21,source),receive(22,source),1);
 const serial1=sync("SELECT id FROM inventory_serials WHERE serial_number='RACE0001-AA'");
 await race('reservation wins against ordinary OUT',`public.reserve_inventory_for_se('${id(30)}','${serial1}',NULL)`,out('RACE0001-AA'),1);
 const serial2=sync("SELECT id FROM inventory_serials WHERE serial_number='RACE0002-AA'");
 await race('ordinary OUT wins against later reservation',out('RACE0002-AA'),`public.reserve_inventory_for_se('${id(31)}','${serial2}',NULL)`,1);
 run(inTx(['RACE0003-AA']));
 const serial3=sync("SELECT id FROM inventory_serials WHERE serial_number='RACE0003-AA'");
 const deliver=`public.deliver_inventory_to_project('${id(40)}','${id(1)}','${project}',1,ARRAY['${serial3}']::uuid[],NULL,true,'${at}','[TEST concurrency]')`;
 await race('same delivery request creates one OUT and one SITE receipt',deliver,deliver,2);
 assert.equal(sync(`SELECT count(*) FROM material_receipts r JOIN inventory_transactions t ON t.id=r.inventory_transaction_id WHERE t.item_id='${id(1)}' AND receipt_location='SITE'`),'1');
 assert.equal(sync('SELECT count(*) FROM app_private.inventory_routing_context'),'0');
 console.log('PASS 5 concurrency/idempotency races; fixtures confined to disposable LOCAL replay DB');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
