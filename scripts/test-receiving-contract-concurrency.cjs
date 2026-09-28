// Run only against the disposable V5-A.1 clone; drop that clone after verification.
const {execFileSync,spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const pg='C:/Vibecode/tools/postgresql-17.11/bin/psql.exe';
const database='receiving_v5a1_contract_20260926';
const args=['-X','-h','127.0.0.1','-p','55453','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-Atq'];
const sync=q=>execFileSync(pg,args,{input:q,encoding:'utf8',timeout:20000}).trim();
const lit=s=>s==null?'NULL':"'"+String(s).replaceAll("'","''")+"'";
const auth="DO $$ BEGIN PERFORM set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true); END $$;SET LOCAL ROLE authenticated;";
const run=q=>JSON.parse(sync('BEGIN;'+auth+'SELECT '+q+';COMMIT;').split('\n').at(-1));
const item=randomUUID(),serialItem=randomUUID(),projectA=randomUUID(),projectB=randomUUID();
const fixtureNote='[TEST V5A.1 RACE]';
function pending(qty,project=null,serialized=false){return run(`public.create_office_equipment_arrival(${lit(randomUUID())},${lit(serialized?serialItem:item)},${qty},now(),${lit(project)},${lit(fixtureNote)})`).id;}
function arrival(qty,project=null,serials=null){return run(`public.create_receiving_arrival(${lit(randomUUID())},'2000-01-01',${lit(JSON.stringify([{inventory_item_id:serials?serialItem:item,quantity:qty,raw_serials:serials||[]}]))},${lit(project)},${lit(fixtureNote)},'2099-03-15')`);}
const line=a=>a.lines[0].id;
const version=l=>Number(sync('SELECT version FROM public.receiving_arrival_lines WHERE id='+lit(l)));
const spec=(source,qty,entries=[])=>({se_supply_record_id:source,quantity:qty,entry_ids:entries});
const replace=(l,matches,req=randomUUID(),ver=version(l))=>`public.replace_receiving_arrival_matches(${lit(req)},${lit(l)},${ver},${lit(JSON.stringify(matches))})`;
const match=(l,s,qty)=>`public.match_receiving_arrival_line(${lit(randomUUID())},${lit(l)},${qty},NULL,${lit(s)})`;
const cancel=s=>`public.cancel_receiving_pending_remaining(${lit(randomUUID())},'SE_SUPPLY',${lit(s)},'remaining not needed')`;
const metadata=(a,p,ver=1)=>`public.update_receiving_arrival_metadata(${lit(randomUUID())},${lit(a.arrival.id)},${ver},${lit(p)},${lit(fixtureNote)})`;
const fulfilled=s=>run(`public.get_receiving_pending_fulfilment(NULL,${lit(s)})`);
function session(sql,name,onData){let stdout='',stderr='';const child=spawn(pg,args,{env:{...process.env,PGAPPNAME:name}});
 child.stdout.on('data',b=>{stdout+=b;onData?.(stdout);});child.stderr.on('data',b=>stderr+=b);
 child.stdin.end(sql);return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});}
let cases=0;
async function race(label,a,b,successes,pattern=/MATCH_CAPACITY_CONFLICT|MATCH_LINE_VERSION_CONFLICT|MATCH_PENDING_INACTIVE|MATCH_PROJECT_CONFLICT|ARRIVAL_PROJECT_CONFLICT_WITH_MATCH|could not serialize access/,isolation='READ COMMITTED'){
 let ready,timer;const started=new Promise(r=>ready=r);
 const begin='BEGIN ISOLATION LEVEL '+isolation+";SET LOCAL statement_timeout='12s';SET LOCAL lock_timeout='8s';"+auth;
 const first=session(begin+'SELECT '+a+";SELECT 'LOCKED';SELECT pg_sleep(1.2);COMMIT;",'v51-first',s=>{if(s.includes('LOCKED'))ready();});
 try {await Promise.race([started,first.then(r=>{if(r.code!==0)throw Error(r.stderr);}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('first session did not lock')),10000))]);}
 finally{clearTimeout(timer);}
 const second=session(begin+'SELECT '+b+';COMMIT;','v51-second');
 await new Promise(r=>setTimeout(r,250));
 assert.equal(sync("SELECT count(*) FROM pg_stat_activity WHERE application_name='v51-second' AND wait_event_type='Lock'"),'1',label+' actual Lock wait');
 const results=await Promise.all([first,second]);
 assert.equal(results.filter(r=>r.code===0).length,successes,label+' '+results.map(r=>r.stderr).join('\n'));
 if(successes===1)assert.match(results.find(r=>r.code!==0).stderr,pattern,label);
 cases++;console.log('PASS '+label+'; observed cross-session Lock wait');
}
function stockFingerprint(){return sync("SELECT md5(jsonb_build_object('tx',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.inventory_transactions t),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.material_receipts r),'serials',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.inventory_serials s),'links',(SELECT jsonb_agg(to_jsonb(s) ORDER BY receipt_id,entry_id) FROM public.material_receipt_serials s))::text)");}
(async()=>{
 assert.equal(sync("SELECT inet_server_addr()::text||'/'||current_database()"),'127.0.0.1/32/'+database);
 sync(`INSERT INTO public.projects(id,project_name) VALUES(${lit(projectA)},'${fixtureNote} A'),(${lit(projectB)},'${fixtureNote} B');
 INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES
 (${lit(item)},'${fixtureNote} plain','${fixtureNote} plain','個','一般',false,false),
 (${lit(serialItem)},'${fixtureNote} serial','${fixtureNote} serial','台','設備維修',true,true);`);
 let s=pending(5),a=arrival(4),b=arrival(4);
 let before=stockFingerprint();
 await race('MATCH overflow: separate arrivals each request 4 of pending 5',replace(line(a),[spec(s,4)]),replace(line(b),[spec(s,4)]),1);
 assert.equal(fulfilled(s).fulfilled,4);assert.equal(stockFingerprint(),before);
 s=pending(5);a=arrival(4);before=stockFingerprint();
 await race('PENDING-5 cancellation wins, future match rejects',cancel(s),match(line(a),s,4),1);
 assert.equal(fulfilled(s).remaining_status,'CANCELLED');assert.equal(fulfilled(s).fulfilled,0);assert.equal(stockFingerprint(),before);
 s=pending(5);a=arrival(4);before=stockFingerprint();
 await race('PENDING-5 match wins, cancellation sees latest fulfilled',match(line(a),s,4),cancel(s),2);
 assert.deepEqual([fulfilled(s).fulfilled,fulfilled(s).remaining,fulfilled(s).remaining_status],[4,1,'CANCELLED']);assert.equal(stockFingerprint(),before);
 s=pending(5);a=arrival(4);
 await race('PENDING-5 cancellation versus final-set replacement',cancel(s),replace(line(a),[spec(s,4)]),1);
 assert.equal(fulfilled(s).fulfilled,0);
 s=pending(8,projectB);a=arrival(8);before=stockFingerprint();
 await race('PROJECT-5 metadata wins, incompatible new match rejects',metadata(a,projectA),match(line(a),s,8),1);
 assert.equal(fulfilled(s).fulfilled,0);assert.equal(stockFingerprint(),before);
 s=pending(8,projectB);a=arrival(8);before=stockFingerprint();
 await race('PROJECT-5 match wins, current-version incompatible metadata rejects',match(line(a),s,8),metadata(a,projectA,2),1);
 assert.equal(fulfilled(s).fulfilled,8);assert.equal(stockFingerprint(),before);
 s=pending(8);const s2=pending(8);a=arrival(8);before=stockFingerprint();
 await race('MATCH-10 same-line replacements reject stale desired set',replace(line(a),[spec(s,8)]),replace(line(a),[spec(s2,8)]),1);
 assert.equal(fulfilled(s).fulfilled+fulfilled(s2).fulfilled,8);assert.equal(stockFingerprint(),before);
 const serials=['V51R0001-AA','V51R0002-AA','V51R0003-AA'];
 s=pending(3,null,true);const serialB=pending(3,null,true);a=arrival(3,null,serials);
 const ids=JSON.parse(sync('SELECT jsonb_agg(id ORDER BY normalized_serial) FROM public.receiving_serial_entries WHERE arrival_line_id='+lit(line(a))));
 before=stockFingerprint();
 await race('MATCH-10 serialized concurrent allocation changes',replace(line(a),[spec(s,2,ids.slice(0,2)),spec(serialB,1,ids.slice(2))]),replace(line(a),[spec(serialB,3,ids)]),1);
 assert.equal(sync('SELECT count(*) FROM public.receiving_arrival_match_serials WHERE cancelled_at IS NULL AND arrival_entry_id IN ('+ids.map(lit).join(',')+')'),'3');assert.equal(stockFingerprint(),before);
 s=pending(8);a=arrival(8);const sameReplace=replace(line(a),[spec(s,8)]);before=stockFingerprint();
 await race('IDEMPOTENCY concurrent same replacement request',sameReplace,sameReplace,2);
 assert.equal(sync('SELECT count(*) FROM public.receiving_arrival_matches WHERE arrival_line_id='+lit(line(a))),'1');assert.equal(stockFingerprint(),before);
 const sameCancel=cancel(s=pending(8));
 await race('IDEMPOTENCY concurrent same cancel request',sameCancel,sameCancel,2);
 assert.equal(sync("SELECT count(*) FROM public.activity_logs WHERE action='PENDING_REMAINING_CANCELLED' AND target_id="+lit(s)),'1');
 a=arrival(1);const sameMetadata=metadata(a,projectA);
 await race('IDEMPOTENCY concurrent same metadata request',sameMetadata,sameMetadata,2);
 assert.equal(sync("SELECT count(*) FROM public.activity_logs WHERE action='ARRIVAL_METADATA' AND target_id="+lit(a.arrival.id)),'1');
 s=pending(5);a=arrival(4);b=arrival(4);
 await race('REPEATABLE READ capacity owners reject stale snapshot',replace(line(a),[spec(s,4)]),replace(line(b),[spec(s,4)]),1,/could not serialize access/,'REPEATABLE READ');
 assert.equal(fulfilled(s).fulfilled,4);
 s=pending(8,projectB);a=arrival(8);
 await race('REPEATABLE READ match touches parent for metadata conflict',match(line(a),s,8),metadata(a,projectA,2),1,/could not serialize access/,'REPEATABLE READ');
 assert.equal(sync('SELECT project_id IS NULL FROM public.receiving_arrivals WHERE id='+lit(a.arrival.id)),'t');
 assert.equal(sync('SELECT count(*) FROM app_private.receiving_contract_context'),'0');
 assert.equal(sync('SELECT count(*) FROM public.receiving_arrival_match_serials s JOIN public.receiving_arrival_matches m ON m.id=s.match_id WHERE s.cancelled_at IS DISTINCT FROM m.cancelled_at'),'0');
 console.log('PASS '+cases+' concurrent scenarios; canonical fingerprints unchanged. Fixture cleanup: drop the verified disposable '+database+' clone.');
})().catch(e=>{console.error(e);process.exitCode=1;});
