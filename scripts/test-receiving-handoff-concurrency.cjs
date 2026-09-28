// Disposable LOCAL V6-A clone only. No remote DSN; fixtures are removed by dropping this clone.
const {execFileSync,spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const database='receiving_v6a_handoff_final_20260926';
const args=['-X','-h','127.0.0.1','-p','55453','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-Atq'];
const sync=q=>execFileSync(pg,args,{input:q,encoding:'utf8',timeout:20000}).trim();
const lit=s=>s==null?'NULL':"'"+String(s).replaceAll("'","''")+"'";
const auth="DO $$ BEGIN PERFORM set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true); END $$;SET LOCAL ROLE authenticated;";
const run=q=>JSON.parse(sync('BEGIN;'+auth+'SELECT '+q+';COMMIT;').split('\n').at(-1));
const item=randomUUID(),plain=randomUUID(),project=randomUUID(),task=randomUUID();
const serialPrefix=randomUUID().slice(0,4).toUpperCase();
let serialIndex=0,cases=0;
function arrival(qty=1,serialized=true){
 const names=serialized?Array.from({length:qty},()=>`${serialPrefix}${String(++serialIndex).padStart(4,'0')}-AA`):[];
 const a=run(`public.create_receiving_arrival(${lit(randomUUID())},'2000-01-01',${lit(JSON.stringify([{inventory_item_id:serialized?item:plain,quantity:qty,raw_serials:names}]))},NULL,'[TEST V6-A RACE]','2099-03-15')`);
 const r=a.lines[0].receipt_id;
 return {receipt:r,serials:JSON.parse(sync(`SELECT COALESCE(jsonb_agg(inventory_serial_id ORDER BY raw_serial),'[]') FROM public.receiving_serial_entries WHERE active_receipt_id=${lit(r)}`)),names};
}
const route=(a,kind,qty=1,req=randomUUID())=>`public.route_receiving_inventory(${lit(req)},${lit(a.receipt)},${lit(kind)},${qty},ARRAY[${a.serials.slice(0,qty).map(lit)}]::uuid[],${lit(project)},NULL,true,'2099-03-16','[TEST V6-A RACE]')`;
const scope=a=>run(`public.get_receiving_handoff_scope(${lit(a.receipt)})`);
const active=(a,kind)=>sync(`SELECT id FROM public.receiving_inventory_allocations WHERE office_receipt_id=${lit(a.receipt)} AND route_type=${lit(kind)} AND cancelled_at IS NULL ORDER BY id LIMIT 1`);
const retract=(id,req=randomUUID())=>`public.retract_receiving_handoff(${lit(req)},${lit(id)},'[TEST V6-A RACE] retract','2099-03-17')`;
function session(sql,name,onData){
 let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});
 child.stdout.on('data',b=>{stdout+=b;onData?.(stdout)});child.stderr.on('data',b=>stderr+=b);child.stdin.end(sql);
 return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
}
async function race(label,a,b,successes,pattern=/HANDOFF_|DOWNSTREAM_CORRECTION_REQUIRED|EQUIPMENT_CONFLICT|在庫|到貨已取消|SOURCE_INACTIVE|資料|could not serialize access|RETURN serial/ ,isolation='READ COMMITTED'){
 let ready,timer;const started=new Promise(r=>ready=r);
 const begin=`BEGIN ISOLATION LEVEL ${isolation};SET LOCAL statement_timeout='12s';SET LOCAL lock_timeout='8s';`+auth;
 const first=session(begin+'SELECT '+a+";SELECT 'LOCKED';SELECT pg_sleep(1.2);COMMIT;",'v6a-first',s=>{if(s.includes('LOCKED'))ready();});
 try{await Promise.race([started,first.then(r=>{if(r.code!==0)throw Error(r.stderr)}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('no first lock')),10000))]);}finally{clearTimeout(timer);}
 const second=session(begin+'SELECT '+b+';COMMIT;','v6a-second');
 await new Promise(r=>setTimeout(r,250));
 assert.equal(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='v6a-second' AND wait_event_type='Lock'"),'1',label+' must observe Lock wait');
 const results=await Promise.all([first,second]);
 assert.equal(results.filter(r=>r.code===0).length,successes,label+' '+results.map(r=>r.stderr).join('\n'));
 if(successes===1)assert.match(results.find(r=>r.code!==0).stderr,pattern,label+' '+results.find(r=>r.code!==0).stderr);
 cases++;console.log('PASS '+label+'; observed cross-session Lock wait');
 return results;
}
function maintenance(a,se){
 const candidate=run(`public.search_maintenance_equipment(${lit(task)})`).find(c=>c.se_supply_record_id===se);
 assert.ok(candidate?.eligible,'maintenance eligible before race');
 return `public.register_maintenance_equipment_replacement(${lit(randomUUID())},${lit(task)},${lit(a.serials[0])},${lit(se)},now(),'[TEST V6-A RACE]',${lit(candidate.version)},false)`;
}
const ret=a=>`public.write_inventory_transaction_atomic('CREATE',${lit(JSON.stringify({item_id:item,transaction_type:'RETURN',quantity:1,unit:'台',project_id:project,transaction_date:'2099-03-17'}))},${lit(JSON.stringify(a.names))})`;
function legacy(){
 const source=run(`public.create_office_equipment_arrival(${lit(randomUUID())},${lit(plain)},10,now(),NULL,'[TEST V6-A RACE]')`).id;
 const r=run(`public.confirm_receiving_into_inventory(${lit(randomUUID())},'SE_SUPPLY',${lit(source)},${lit(plain)},10,'{}','2099-03-15','[TEST V6-A RACE]')`);
 return {source,receipt:r.id,serials:[]};
}
const cancel=a=>`public.cancel_receiving_arrival(${lit(randomUUID())},'SE_SUPPLY',${lit(a.source)},'[TEST V6-A RACE] cancel',false)`;
(async()=>{
 assert.equal(sync("SELECT inet_server_addr()::text||'/'||current_database()"),'127.0.0.1/32/'+database);
 sync(`INSERT INTO public.projects(id,project_name) VALUES(${lit(project)},'[TEST V6-A RACE]');
 INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES
 (${lit(item)},'[TEST V6-A RACE] serial ${serialPrefix}','[TEST V6-A RACE] serial','台','設備維修',true,true),
 (${lit(plain)},'[TEST V6-A RACE] plain ${serialPrefix}','[TEST V6-A RACE] plain','m','一般',false,false);
 INSERT INTO public.schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id)
 VALUES(${lit(task)},'[TEST V6-A RACE]',current_date,'維修','未完成',${lit(project)},(SELECT id FROM public.work_groups LIMIT 1));`);
 let a=arrival(); await race('same serial SE vs SE',route(a,'SE'),route(a,'SE'),1);assert.equal(scope(a).se,1);
 a=arrival();await race('same serial SE vs Project',route(a,'SE'),route(a,'SITE'),1);assert.equal(scope(a).site,0);
 a=arrival();await race('same serial Project vs SE',route(a,'SITE'),route(a,'SE'),1);assert.equal(scope(a).se,0);
 a=arrival(10,false);await race('nonserial 10, reserve 8 vs reserve 8',route(a,'SE',8),route(a,'SE',8),1);assert.equal(scope(a).available,2);
 a=arrival(10,false);await race('nonserial Repeatable Read stale snapshot',route(a,'SE',8),route(a,'SE',8),1,/could not serialize access/,'REPEATABLE READ');assert.equal(scope(a).se,8);
 a=arrival();let se=run(route(a,'SE'))[0];await race('SE retract wins vs Maintenance use',retract(active(a,'SE')),maintenance(a,se.id),1);assert.equal(scope(a).available,1);
 a=arrival();se=run(route(a,'SE'))[0];await race('Maintenance use wins vs SE retract',maintenance(a,se.id),retract(active(a,'SE')),1);assert.equal(scope(a).allocations[0].state,'USED');
 a=arrival();run(route(a,'SITE'));await race('Project retract wins vs serial downstream RETURN',retract(active(a,'SITE')),ret(a),1,/Serial is not available|SERIAL_STATE_CONFLICT|已出庫|RETURN serial/);assert.equal(scope(a).available,1);
 a=arrival();run(route(a,'SITE'));await race('serial downstream RETURN wins vs Project retract',ret(a),retract(active(a,'SITE')),1);assert.equal(scope(a).allocations[0].state,'TERMINAL');
 a=legacy();await race('handoff wins vs legacy Receiving cancellation',route(a,'SE',5),cancel(a),1);assert.equal(scope(a).se,5);
 // A fresh item avoids unrelated earlier nonserial OUT chronology in cancellation.
 a=legacy();await race('legacy Receiving cancellation wins vs handoff',cancel(a),route(a,'SE',5),1,/到貨已取消|SOURCE_INACTIVE/);
 for(const kind of ['SE','SITE']){
  a=arrival();let req=randomUUID(),q=route(a,kind,1,req);let results=await race(kind+' handoff identical concurrent request',q,q,2);
  assert.equal(sync(`SELECT count(*) FROM public.receiving_inventory_allocations WHERE office_receipt_id=${lit(a.receipt)}`),'1');
  assert.equal(sync(`SELECT count(*) FROM public.activity_logs WHERE action='ROUTE_RECEIVING' AND target_id=${lit(a.receipt)}`),'1');
  req=randomUUID();q=retract(active(a,kind),req);results=await race(kind+' retract identical concurrent request',q,q,2);
  assert.equal(sync(`SELECT count(*) FROM public.activity_logs WHERE action='RETRACT_RECEIVING_HANDOFF' AND target_id IN(SELECT id::text FROM public.receiving_inventory_allocations WHERE office_receipt_id=${lit(a.receipt)})`),'1');
 }
 assert.equal(sync('SELECT count(*) FROM app_private.inventory_routing_context'),'0');
 assert.equal(sync("SELECT count(*) FROM public.receiving_inventory_allocations a JOIN public.material_receipts r ON r.id=a.office_receipt_id JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id WHERE a.cancelled_at IS NULL AND t.is_voided"),'0');
 console.log(`PASS ${cases} real concurrency scenarios; fixtures only in disposable ${database}`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
