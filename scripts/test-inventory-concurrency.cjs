// Disposable LOCAL DB only. No remote connection strings accepted.
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const path=require('node:path');
const pg=process.env.INVENTORY_TEST_PSQL || 'C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const port=process.env.INVENTORY_TEST_PORT || '55446';
const args=['-X','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-Atq'];
const sync=sql=>execFileSync(pg,args,{input:sql,encoding:'utf8'}).trim();
const item=n=>`73000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const payload=(n,kind,qty,extra={})=>JSON.stringify({item_id:item(n),transaction_type:kind,quantity:qty,transaction_date:'2099-01-15',project_id:project,notes:'[TEST] race',...extra});
const lit=s=>`'${String(s).replaceAll("'","''")}'`;
const create=(n,kind,qty,serials=[],extra={})=>`public.write_inventory_transaction_atomic('CREATE',${lit(payload(n,kind,qty,extra))}::jsonb,${lit(JSON.stringify(serials))}::jsonb)`;
const auth=`SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true); SET LOCAL ROLE authenticated;`;
let project;
function session(sql,name,onData){let out='',err='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});child.stdout.on('data',b=>{out+=b;onData?.(out);});child.stderr.on('data',b=>err+=b);child.stdin.end(sql);return new Promise(resolve=>child.on('close',code=>resolve({code,out,err})));}
async function race(label,first,second,expectedSuccesses){
 let release; const ready=new Promise(r=>release=r);
 const a=session(`BEGIN; ${auth} SELECT ${first}; SELECT 'LOCKED'; SELECT pg_sleep(2); COMMIT;`,'inventory-race-a',s=>{if(s.includes('LOCKED'))release();});
 await Promise.race([ready,a.then(r=>{if(r.code)throw Error(r.err);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('lock barrier timeout')),8000))]);
 const b=session(`BEGIN; ${auth} SELECT ${second}; COMMIT;`,'inventory-race-b');
 let observed=false;
 for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,50)); if(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='inventory-race-b' AND wait_event_type='Lock'")==='1'){observed=true;break;}}
 const results=await Promise.all([a,b]);
 assert(observed,`${label}: competitor must actually wait on a DB lock`);
 assert.equal(results.filter(r=>r.code===0).length,expectedSuccesses,results.map(r=>r.err).join('\n'));
 for(const r of results.filter(r=>r.code!==0))assert.match(r.err,/INSUFFICIENT_INVENTORY|STALE_INVENTORY|Serial is not available/);
 console.log(`PASS ${label}: lock wait observed; ${expectedSuccesses} success`);
}
const cleanup=`BEGIN;
DELETE FROM activity_logs WHERE target_type='INVENTORY_TRANSACTION' AND target_id IN(SELECT id::text FROM inventory_transactions WHERE item_id::text LIKE '73000000-0000-4000-8000-%');
DELETE FROM inventory_batches WHERE item_id::text LIKE '73000000-0000-4000-8000-%';
DELETE FROM inventory_transactions WHERE item_id::text LIKE '73000000-0000-4000-8000-%';
DELETE FROM inventory_serials WHERE item_id::text LIKE '73000000-0000-4000-8000-%';
DELETE FROM inventory_items WHERE id::text LIKE '73000000-0000-4000-8000-%'; COMMIT;`;
(async()=>{
 project=sync('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
 assert.equal(sync("SELECT count(*) FROM inventory_items WHERE id::text LIKE '73000000-0000-4000-8000-%'"),'0','fixture prefix already exists: refuse overwrite');
 try{
 sync(`INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial) VALUES ${[1,2,3,4,5,6].map(n=>`('${item(n)}','RACE-${n}','[TEST] race ${n}','個','設備維修',${n===3||n===4?0:5},${n===3||n===4})`).join(',')};`);
 await race('OUT vs OUT',create(1,'OUT',4),create(1,'OUT',4),1);
 assert.equal(sync(`SELECT app_private.inventory_effective_balance('${item(1)}')`),'1');
 await race('OUT vs stale ADJUST',create(2,'OUT',4),create(2,'ADJUST',0,[],{expected_balance:5,counted_quantity:0}),1);
 assert.equal(sync(`SELECT app_private.inventory_effective_balance('${item(2)}')`),'1');
 await race('ADJUST vs OUT reverse order',create(6,'ADJUST',0,[],{expected_balance:5,counted_quantity:0}),create(6,'OUT',4),1);
 sync(`BEGIN;${auth} SELECT ${create(3,'IN',2,['RACE00001-AA','RACE00002-AA'])};SELECT ${create(4,'IN',2,['RACE00003-AA','RACE00004-AA'])}; COMMIT;`);
 await race('serial vs same serial',create(3,'OUT',1,['RACE00001-AA']),create(3,'OUT',1,['RACE00001-AA']),1);
 const old=JSON.parse(sync(`BEGIN;${auth} SELECT ${create(4,'OUT',1,['RACE00003-AA'])}; COMMIT;`).split('\n').at(-1));
 const edit=`public.write_inventory_transaction_atomic('EDIT',${lit(payload(4,'OUT',1))}::jsonb,'["RACE00004-AA"]','${old.id}','swap','${old.updated_at}')`;
 // Both may succeed sequentially: after edit commits, old serial is legitimately free.
 await race('edit releases old serial vs OUT',edit,create(4,'OUT',1,['RACE00003-AA']),2);
 assert.equal(sync(`SELECT count(DISTINCT l.serial_id) FROM inventory_transaction_serials l JOIN inventory_transactions t ON t.id=l.transaction_id WHERE t.item_id='${item(4)}' AND t.transaction_type='OUT' AND NOT t.is_voided`),'2');
 const credit=JSON.parse(sync(`BEGIN;${auth} SELECT ${create(5,'RETURN',5)};COMMIT;`).split('\n').at(-1));
 const voidCredit=`public.write_inventory_transaction_atomic('VOID','{}','[]','${credit.id}','undo credit')`;
 await race('void credit vs OUT',voidCredit,create(5,'OUT',6),1);
 assert.equal(sync(`SELECT app_private.inventory_effective_balance('${item(5)}')`),'5');
 // Same fixture is evaluated by the existing App helpers and the DB helper.
 const fixture=JSON.parse(sync(`SELECT json_build_object('opening',i.opening_quantity,'transactions',(SELECT json_agg(t) FROM inventory_transactions t WHERE t.item_id=i.id),'db',app_private.inventory_effective_balance(i.id)) FROM inventory_items i WHERE id='${item(4)}'`));
 const load=require('../src/lib/test-load-ts.cjs');
 const {getInventoryTransactionQuantityDelta:delta}=load(path.resolve('src/lib/db/inventory-stock.ts'));
 const {isActiveFormalTransaction:active}=load(path.resolve('src/lib/db/types.ts'));
 assert.equal(fixture.opening+(fixture.transactions||[]).filter(active).reduce((sum,t)=>sum+delta(t.transaction_type,t.quantity),0),fixture.db);
 console.log('PASS actual App/DB balance parity');
 const allTypes=JSON.parse(sync(`BEGIN;
 INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity) VALUES('${item(7)}','RACE-PARITY','[TEST] full parity','個','設備維修',10);
 INSERT INTO inventory_initializations(baseline_date,initialized_by) SELECT '2026-08-31','fixture' WHERE NOT EXISTS(SELECT 1 FROM inventory_initializations);
 INSERT INTO inventory_transactions(item_id,transaction_type,transaction_date,quantity,is_voided,excluded_by_initialization_id)
 SELECT '${item(7)}',kind,'2099-01-15',qty,voided,CASE WHEN excluded THEN (SELECT id FROM inventory_initializations LIMIT 1) ELSE NULL END
 FROM (VALUES('IN',5,false,false),('OUT',3,false,false),('RETURN',2,false,false),('ADJUST',2,false,false),('ADJUST',-1,false,false),('IN',100,true,false),('OUT',100,false,true)) v(kind,qty,voided,excluded);
 SELECT json_build_object('opening',i.opening_quantity,'transactions',(SELECT json_agg(t) FROM inventory_transactions t WHERE t.item_id=i.id),'db',app_private.inventory_effective_balance(i.id)) FROM inventory_items i WHERE id='${item(7)}'; ROLLBACK;`));
 assert.equal(allTypes.opening+allTypes.transactions.filter(active).reduce((sum,t)=>sum+delta(t.transaction_type,t.quantity),0),allTypes.db);
 assert.equal(allTypes.db,15);
 console.log('PASS actual App/DB parity: IN OUT RETURN +/-ADJUST void initialization exclusion');
 }finally{sync(cleanup);console.log('Fixture cleanup complete');}
})().catch(e=>{console.error(e);process.exitCode=1;});
