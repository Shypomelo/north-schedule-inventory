// Disposable LOCAL cluster only; never accepts a remote connection string.
const {execFileSync,spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const args=['-X','-h','127.0.0.1','-p','55456','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'];
const sync=q=>execFileSync(pg,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const auth="SET LOCAL test.actor='editor';SET LOCAL ROLE authenticated;";
const call=(key,unit='台',serial=true)=>`public.get_or_create_inventory_item('${key}','${unit}',${serial})`;
function fail(sql,pattern){try{sync('BEGIN;'+auth+sql+';ROLLBACK;');assert.fail('should reject');}catch(e){assert.match(String(e.stderr||e.message),pattern);}}
function session(q,name,onData){let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});child.stdin.end(q);child.stdout.on('data',s=>{stdout+=s;onData?.(stdout)});child.stderr.on('data',s=>stderr+=s);return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});}
(async()=>{
 assert.equal(sync("SELECT inet_server_addr()::text"),'127.0.0.1/32');
 assert.equal(sync("SELECT count(*) FROM inventory_items WHERE canonical_identity_key IS NULL"),'3');
 const reused=JSON.parse(sync('BEGIN;'+auth+'SELECT '+call(' p401 ')+';ROLLBACK;'));assert.equal(reused.created,false);assert.equal(reused.item.canonical_identity_key,null);
 fail('SELECT '+call('P401','台',false),/INVENTORY_ITEM_DEFINITION_CONFLICT/);
 fail('SELECT '+call('P401','pcs'),/INVENTORY_ITEM_DEFINITION_CONFLICT/);
 fail('SELECT '+call('MC4','pcs',false),/AMBIGUOUS_EXISTING_ITEMS/);
 fail("INSERT INTO inventory_items(code,name,unit,category,canonical_identity_key) VALUES('X','X','台','設備維修','x')",/permission denied/);
 try{sync("BEGIN;SET LOCAL test.actor='viewer';SET LOCAL ROLE authenticated;SELECT "+call('VIEWER')+';ROLLBACK;');assert.fail();}catch(e){assert.match(String(e.stderr),/active editor/);}
 try{sync("BEGIN;SET LOCAL ROLE anon;SELECT "+call('ANON')+';ROLLBACK;');assert.fail();}catch(e){assert.match(String(e.stderr),/permission denied/);}
 let ready;const started=new Promise(r=>ready=r);const key='V6B-CONCURRENT-'+Date.now();
 const first=session('BEGIN;'+auth+'SELECT '+call(key)+";SELECT 'LOCKED';SELECT pg_sleep(2);COMMIT;",'v6b-first',s=>{if(s.includes('LOCKED'))ready();});await started;
 const second=session('BEGIN;'+auth+'SELECT '+call(' '+key.toLowerCase()+' ')+';COMMIT;','v6b-second');
 await new Promise(r=>setTimeout(r,300));assert.equal(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='v6b-second' AND wait_event_type='Lock'"),'1');
 const results=await Promise.all([first,second]);results.forEach(r=>assert.equal(r.code,0,r.stderr));
 const [a,b]=results.map(r=>JSON.parse(r.stdout.split('\n').find(l=>l.startsWith('{'))));assert.equal(a.item.id,b.item.id);assert.equal(a.created,true);assert.equal(b.created,false);
 assert.equal(sync(`SELECT count(*) FROM inventory_items WHERE canonical_identity_key=lower('${key}')`),'1');
 sync(`DELETE FROM inventory_items WHERE id='${a.item.id}' AND canonical_identity_key=lower('${key}')`);
 console.log('PASS local: legacy NULL reuse, unit/serial conflict, ambiguous name, direct INSERT denied, Viewer/anon denied, two-session same-key create (observed Lock wait; one item)');
})().catch(e=>{console.error(e);process.exitCode=1;});
