// Append only completed, positive-volume SPY sessions to a separate data checkout.
// The exporter and applier run from main. This process never pushes to GitHub.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify,parseArgs} from 'node:util';
import {completedSessionDay} from '../src/market-clock.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const baseCommit='2fd62a22f088acdf6d6a1e1b66d43f533230d3c0';
const manifestSha='749f8cb9321ec632c75280a2b19e94f210d254731fbfa3be8ebf01945b8e1a4e';
const baseDate='2026-11-20',baseRevision='aef7n6a07m0r9tn7nrr0gfsjpstfdhr3';
const marketRepo='post-no-preference/stocks';
const gitRemote='https://github.com/eric-choi-dev/semiscope-public-market-ranks.git';
const dbAPI='https://www.dolthub.com/api/v2/databases/'+marketRepo;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha256=/^[a-f0-9]{64}$/,doltSha=/^[0-9a-v]{32}$/;
const runFile=promisify(execFile);
const {values}=parseArgs({options:{checkout:{type:'string'},db:{type:'string'},dolt:{type:'string'},archive:{type:'string'}}});
const dolt=values.dolt??process.env.DOLT_EXECUTABLE??'dolt';
async function run(executable,args,cwd=root) {
  const env={...process.env};
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','RANK_PUBLISH_TOKEN'])delete env[key];
  const {stdout}=await runFile(executable,args,{cwd,env,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  return stdout.trim();
}
async function exists(file){try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function day(value) {
  assert(typeof value==='string' && /^\d{4}-\d\d-\d\d$/.test(value) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value,'Invalid trading date');
  return value;
}
async function readIndex(checkout) {
  const index=JSON.parse(await readFile(path.join(checkout,'index.json')));
  assert.equal(index.schemaVersion,1);
  assert.equal(index.baseGitCommit,baseCommit);
  assert.equal(index.baseRevision,baseRevision);
  assert.equal(index.baseAsOf,baseDate);
  assert(day(index.latestDate)>=baseDate);
  assert(doltSha.test(index.sourceRevision));
  assert(index.days && typeof index.days==='object' && !Array.isArray(index.days));
  const dates=Object.keys(index.days).sort();
  assert.equal(dates.at(-1)??baseDate,index.latestDate);
  if(dates.length)assert.equal(index.days[index.latestDate],index.lastDeltaSha256);
  return index;
}
async function readRoot() {
  const response=await fetch(dbAPI+'/branches',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  assert(response.ok,'DoltHub branch head unavailable');
  const json=await response.json();
  const head=json.data?.find(row=>row.name==='master')?.head_commit_sha;
  assert(doltSha.test(head),'Invalid market source commit');
  return head;
}
const sql=(db,q)=>run(dolt,['sql','-r','csv','-q',q],db);
// The public SQL endpoint can verify an empty recent interval with a handful
// of indexed key lookups. A timeout falls back to the pinned local database.
async function noNewDays(revision,after,until) {
  const days=[];
  for(let ms=Date.parse(after)+86400000;ms<=Date.parse(until);ms+=86400000){
    if(days.length>=64)return false;
    days.push("('"+new Date(ms).toISOString().slice(0,10)+"','SPY')");
  }
  const q="SELECT date FROM ohlcv AS OF '"+revision+"' WHERE (date,act_symbol) IN ("+days.join(',')+") AND volume>0";
  try{
    const res=await fetch(dbAPI+'/sql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q,ref:'master',limit:64,timeout_ms:7000}),signal:AbortSignal.timeout(10000)});
    if(!res.ok)return false;
    const {data}=await res.json();
    return data?.status==='success' && Array.isArray(data.rows) && data.rows.length===0;
  }catch{return false;}
}
async function sourceDatabase(workspace,shared,head,priorRevision) {
  if(await exists(path.join(shared,'.dolt'))){
    try{
      for(const revision of new Set([head,priorRevision,baseRevision])){
        const probe=await sql(shared,"SELECT close FROM ohlcv AS OF '"+revision+"' WHERE date='"+baseDate+"' AND act_symbol='SPY'");
        assert(Number(probe.split(/\r?\n/)[1])>0);
      }
      return shared;
    }catch(error){console.log('Shared Dolt checkout lacks a required historical revision; opening the full source history.');}
  }
  const dir=path.join(workspace,'stocks');
  await run(dolt,['clone','--single-branch','--branch','master',marketRepo,dir],workspace);
  return dir;
}
async function archiveRoot(workspace) {
  const dir=values.archive?path.resolve(values.archive):path.join(workspace,'baseline');
  if(!values.archive){
    await mkdir(dir);
    await run('git',['init','--quiet'],dir);
    await run('git',['fetch','--quiet','--depth=1',gitRemote,baseCommit],dir);
    await run('git',['checkout','--quiet','--detach','FETCH_HEAD'],dir);
  }
  assert.equal(await run('git',['rev-parse','HEAD'],dir),baseCommit,'Incorrect original history checkout');
  assert.equal(await run('git',['status','--porcelain'],dir),'','Original history checkout must be clean');
  assert.equal(hash(await readFile(path.join(dir,'manifest.json'))),manifestSha,'Original manifest checksum mismatch');
  return dir;
}
async function validateTree(checkout,start) {
  const delta=await run('git',['diff','--raw','--no-renames','-z',start,'HEAD'],checkout);
  const fields=delta.split('\0');
  for(let i=0;i<fields.length && fields[i];i+=2){
    const [meta,name]=fields.slice(i,i+2);
    assert(/^:(?:000000|100644) 100644 [0-9a-f]+ [0-9a-f]+ [AM]$/.test(meta),'Unexpected data tree change: '+meta);
    assert(name==='index.json'||/^shards\/\d{4}-(?:0[1-9]|1[0-2])\/[a-f0-9]{2}\.json$/.test(name)||
      (meta.endsWith(' A') && /^days\/\d{4}-\d\d-\d\d\.json$/.test(name)),'Unexpected or rewritten data path: '+name);
  }
  assert.equal(await run('git',['status','--porcelain'],checkout),'','Delta writer left uncommitted files');
}
async function refresh(workspace,checkout) {
  assert.equal(await run('git',['status','--porcelain'],checkout),'','Data checkout must initially be clean');
  const tracked=await run('git',['ls-tree','-r','--format=%(objectmode)','HEAD'],checkout);
  assert(tracked && tracked.split(/\r?\n/).every(mode=>mode==='100644'),'Data branch contains a non-regular file');
  const start=await run('git',['rev-parse','HEAD'],checkout);
  let index=await readIndex(checkout);
  const cutoff=day(completedSessionDay());
  if(index.latestDate>=cutoff){console.log('Regular sessions are current through '+index.latestDate);return;}
  const head=await readRoot();
  if(await noNewDays(head,index.latestDate,cutoff)){console.log('No new completed SPY session at '+head+' after '+index.latestDate);return;}
  const shared=path.resolve(values.db??path.join(process.env.RANK_CACHE_DIR??path.join(tmpdir(),'semiscope-rank-cache'),'stockdb'));
  const db=await sourceDatabase(workspace,shared,head,index.sourceRevision);
  const dates=(await sql(db,"SELECT date FROM ohlcv AS OF '"+head+"' WHERE act_symbol='SPY' AND date>'"+index.latestDate+"' AND date<='"+cutoff+"' AND volume>0 ORDER BY date")).split(/\r?\n/);
  assert.equal(dates.shift(),'date');
  let prior=index.latestDate;
  for(const date of dates){assert(day(date)>prior && date<=cutoff,'Invalid SPY session sequence');prior=date;}
  if(!dates.length){console.log('No new completed price session after '+index.latestDate);return;}
  const archive=await archiveRoot(workspace),out=path.join(workspace,'deltas');
  await mkdir(out);
  const manifest=JSON.parse(await readFile(path.join(archive,'manifest.json')));
  let precedingCount=manifest.coverage.exported;
  if(index.latestDate>baseDate){
    const last=await readFile(path.join(checkout,'days',index.latestDate+'.json'));
    assert.equal(hash(last),index.lastDeltaSha256);
    precedingCount=JSON.parse(last).coverage.exported;
  }
  assert(Number.isSafeInteger(precedingCount)&&precedingCount>0);
  for(const date of dates){
    const args=['scripts/export-history-delta.mjs','--archive',archive,'--db',db,'--dolt',dolt,'--from-revision',index.sourceRevision,'--to-revision',head,'--prev-date',index.latestDate,'--date',date,'--out',out];
    for(const earlierDate of Object.keys(index.days).sort()){
      assert(day(earlierDate)>baseDate && earlierDate<=index.latestDate);
      const earlier=path.join(checkout,'days',earlierDate+'.json'),digest=index.days[earlierDate];
      assert(sha256.test(digest) && hash(await readFile(earlier))===digest,'Previous daily bytes do not match the index');
      args.push('--previous',earlier,'--previous-sha',digest);
    }
    await run(process.execPath,args);
    const file=path.join(out,date+'.json'),bytes=await readFile(file),data=JSON.parse(bytes);
    assert.equal(data.prevDate,index.latestDate);
    assert.equal(data.date,date);
    assert.equal(data.sourceRevision,head);
    assert.equal(data.baseRevision,baseRevision);
    assert.equal(data.license,'CC BY-SA 4.0');
    assert(Number.isSafeInteger(data.coverage.exported) && data.coverage.exported>=precedingCount*.90,'Daily market coverage dropped by more than 10%; retaining the preceding public release');
    await run(process.execPath,['scripts/apply-history-delta.mjs','--delta',file,'--repo',checkout]);
    const updated=await readIndex(checkout);
    assert.equal(updated.latestDate,date);
    assert.equal(updated.sourceRevision,head);
    assert.equal(updated.lastDeltaSha256,hash(bytes));
    assert.equal(hash(await readFile(path.join(checkout,'days',date+'.json'))),hash(bytes));
    precedingCount=data.coverage.exported;
    index=updated;
  }
  await validateTree(checkout,start);
  console.log('Validated '+dates.length+' completed market sessions through '+index.latestDate+' at '+head);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert(values.checkout,'Specify the isolated history-deltas Git checkout');
  const stage=await mkdtemp(path.join(tmpdir(),'semiscope-history-delta-'));
  try{await refresh(stage,path.resolve(values.checkout));}finally{await rm(stage,{recursive:true,force:true});}
}
