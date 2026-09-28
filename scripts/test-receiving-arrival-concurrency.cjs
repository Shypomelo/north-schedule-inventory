// Local-only targeted concurrency tests. Not a Production-baseline replay gate.
const {execFileSync,spawn}=require('node:child_process');
const assert=require('node:assert/strict'),fs=require('node:fs');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const args=['-X','-h','127.0.0.1','-p','55453','-U','postgres','-d','receiving_v5a_concurrency_20260924','-v','ON_ERROR_STOP=1','-Atq'];
const sync=q=>execFileSync(pg,args,{input:q,encoding:'utf8'}).trim();
const id=n=>'88000000-0000-4000-8000-'+String(n).padStart(12,'0');
const lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const auth="SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);SET LOCAL ROLE authenticated;";
function session(sql,name,onData){let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});
 child.stdout.on('data',b=>{stdout+=b;onData?.(stdout)});child.stderr.on('data',b=>stderr+=b);
 child.stdin.end(sql);return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));
}
async function race(label,a,b,successes,isolation='READ COMMITTED'){
 let ready,timer;const started=new Promise(r=>ready=r);
 const first=session('BEGIN ISOLATION LEVEL '+isolation+';'+auth+'SELECT '+a+";SELECT 'LOCKED';SELECT pg_sleep(1.5);COMMIT;",'v5a-first',s=>{if(s.includes('LOCKED'))ready()});
 await Promise.race([started,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('first did not acquire lock')),10000))]);clearTimeout(timer);
 const second=session('BEGIN ISOLATION LEVEL '+isolation+';'+auth+'SELECT '+b+';COMMIT;','v5a-second');
 await new Promise(r=>setTimeout(r,300));
 assert.equal(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='v5a-second' AND wait_event_type='Lock'"),'1',label+' real lock wait');
 const results=await Promise.all([first,second]);
 assert.equal(results.filter(x=>x.code===0).length,successes,label+' '+results.map(x=>x.stderr).join('\n'));
 if(successes===1)assert.match(results.find(x=>x.code!==0).stderr,/MATCH_CAPACITY_CONFLICT|ARRIVAL_ALREADY_POSTED|could not serialize access/,label+' expected conflict');
 console.log('PASS '+label+'; observed actual Lock wait');
}
const cleanup=`
BEGIN;
DO $$ BEGIN IF inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR current_database()<>'receiving_v5a_concurrency_20260924'
 THEN RAISE EXCEPTION 'LOCAL ONLY'; END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_items WHERE id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902') AND code NOT LIKE '[TEST V5A RACE]%') THEN RAISE EXCEPTION 'Fixture ownership mismatch'; END IF; END $$;
CREATE TEMP TABLE v5_cleanup_arrivals ON COMMIT DROP AS SELECT id FROM public.receiving_arrivals WHERE notes LIKE '[TEST V5A RACE]%';
CREATE TEMP TABLE v5_cleanup_lines ON COMMIT DROP AS SELECT id FROM public.receiving_arrival_lines WHERE arrival_id IN (SELECT id FROM v5_cleanup_arrivals);
CREATE TEMP TABLE v5_cleanup_targets ON COMMIT DROP AS
 SELECT id FROM v5_cleanup_arrivals UNION SELECT id FROM v5_cleanup_lines
 UNION SELECT id FROM public.material_receipts WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines)
 UNION SELECT id FROM public.inventory_transactions WHERE item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902')
 UNION SELECT id FROM public.se_supply_records WHERE inventory_item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902')
 UNION SELECT id FROM public.receiving_arrival_matches WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines);
DELETE FROM public.activity_logs WHERE target_id IN (SELECT id::text FROM v5_cleanup_targets);
DELETE FROM public.receiving_arrival_match_serials WHERE match_id IN (SELECT id FROM public.receiving_arrival_matches WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines));
DELETE FROM public.receiving_arrival_matches WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines);
DELETE FROM public.material_receipt_serials WHERE receipt_id IN (SELECT id FROM public.material_receipts WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines));
DELETE FROM public.receiving_serial_entries WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines);
UPDATE public.receiving_arrival_lines SET receipt_id=NULL,resolution_state='UNRESOLVED',posting_date=NULL WHERE id IN (SELECT id FROM v5_cleanup_lines);
DELETE FROM public.material_receipts WHERE arrival_line_id IN (SELECT id FROM v5_cleanup_lines);
DELETE FROM public.receiving_arrival_lines WHERE id IN (SELECT id FROM v5_cleanup_lines);
DELETE FROM public.receiving_arrivals WHERE id IN (SELECT id FROM v5_cleanup_arrivals);
DELETE FROM public.se_supply_records WHERE inventory_item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902');
DELETE FROM public.inventory_transaction_serials WHERE transaction_id IN (SELECT id FROM public.inventory_transactions WHERE item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902'));
DELETE FROM public.inventory_serials WHERE item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902');
DELETE FROM public.inventory_batches WHERE item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902');
DELETE FROM public.inventory_transactions WHERE item_id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902');
DELETE FROM public.inventory_items WHERE id IN ('88000000-0000-4000-8000-000000000901','88000000-0000-4000-8000-000000000902');
DELETE FROM app_private.receiving_requests WHERE request_id::text LIKE '88000000-0000-4000-8000-%';
COMMIT;`;
(async()=>{
 assert.equal(sync("SELECT count(*) FROM public.inventory_items WHERE id IN ('"+id(901)+"','"+id(902)+"')"),'0','no pre-existing fixtures');
 try{
 const f=JSON.parse(sync(fs.readFileSync('supabase/tests/receiving-arrival-concurrency-seed.sql','utf8')).split('\n').at(-1));
 assert.equal(sync("SELECT resolution_state||':'||COALESCE(inventory_item_id::text,'NULL') FROM public.receiving_arrival_lines WHERE id="+lit(f.unknown_line)),'UNRESOLVED:NULL','unknown persisted across DB sessions');
 const match=(req,line,qty)=>"public.match_receiving_arrival_line("+lit(id(req))+","+lit(line)+","+qty+",NULL,"+lit(f.source)+")";
 await race('MATCH-6 parallel 4 + 4 cannot fulfil pending 5',match(920,f.line_a,4),match(921,f.line_b,4),1);
 assert.equal(sync("SELECT sum(quantity) FROM public.receiving_arrival_matches WHERE se_supply_record_id="+lit(f.source)),'4');
 assert.equal(sync("SELECT count(*) FROM public.receiving_arrival_lines WHERE id="+lit(f.line_b)),'1','failed match preserves arrival');
 const complete=req=>"public.complete_receiving_arrival_line("+lit(id(req))+","+lit(f.unknown_line)+","+lit(id(902))+",'2099-03-15')";
 await race('concurrent same completion request returns one first IN',complete(922),complete(922),2);
 assert.equal(sync("SELECT count(*) FROM public.inventory_transactions WHERE item_id="+lit(id(902))),'1');
 const create="public.create_receiving_arrival("+lit(id(923))+",'2000-01-01','[{\"inventory_item_id\":\""+id(901)+"\",\"quantity\":1}]',NULL,'[TEST V5A RACE] CREATE','2099-03-15')";
 const before=Number(sync("SELECT count(*) FROM public.inventory_transactions WHERE item_id="+lit(id(901))));
 await race('concurrent same create request produces one receipt and IN',create,create,2);
 assert.equal(Number(sync("SELECT count(*) FROM public.inventory_transactions WHERE item_id="+lit(id(901)))),before+1);
 // Separate requests completing an already posted line both reject, without another IN.
 const rejected=await session('BEGIN;'+auth+'SELECT '+complete(924)+';COMMIT;','v5a-second');
 assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/ARRIVAL_ALREADY_POSTED/);
 console.log('PASS posted line cannot be reposted under a new request');
 } finally {sync(cleanup);}
 assert.equal(sync("SELECT count(*) FROM public.receiving_arrivals WHERE notes LIKE '[TEST V5A RACE]%'"),'0');
 assert.equal(sync("SELECT count(*) FROM public.inventory_items WHERE id IN ('"+id(901)+"','"+id(902)+"')"),'0');
 console.log('PASS local fixture cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
