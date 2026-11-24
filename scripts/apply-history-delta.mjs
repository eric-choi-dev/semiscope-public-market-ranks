// Append one independently verified EOD export to a local history-deltas branch.
// node scripts/apply-history-delta.mjs --delta YYYY-MM-DD.json --repo <clean checkout>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {isTradingDay,previousTradingDay,publishedCalendar} from '../src/market-clock.mjs';

const baseAsOf='2026-11-20',baseRevision='aef7n6a07m0r9tn7nrr0gfsjpstfdhr3';
const baseGitCommit='2fd62a22f088acdf6d6a1e1b66d43f533230d3c0';
const baseManifestSha256='749f8cb9321ec632c75280a2b19e94f210d254731fbfa3be8ebf01945b8e1a4e';
const sha=b=>createHash('sha256').update(b).digest('hex');
const gitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const isDate=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const dictionary=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const shardIds=Array.from({length:256},(_,i)=>i.toString(16).padStart(2,'0'));
const gitSHA=/^[\da-f]{40}$/,doltSHA=/^[0-9a-v]{32}$/,sha256=/^[\da-f]{64}$/;
const goodSymbol=s=>/^[A-Z][A-Z0-9]{0,7}(?:[.$-][A-Z0-9]{1,5}){0,2}$/.test(s);
const bytes=x=>Buffer.from(JSON.stringify(x)+'\n');
const hex=s=>{
  let h=0;for(const c of s)h=(Math.imul(h,31)+c.charCodeAt(0))&255;
  return shardIds[h];
};
function validBar(b){
  if(!Array.isArray(b)||b.length!==5)return false;
  const [o,h,l,c,v]=b;
  return [o,h,l,c].every(n=>Number.isFinite(n)&&n>0)&&Number.isSafeInteger(v)&&v>0&&
    h>=Math.max(o,l,c)&&l<=Math.min(o,c);
}
const {values:args}=parseArgs({options:{repo:{type:'string'},delta:{type:'string'}}});
assert(args.repo&&args.delta,'Use --delta <verified JSON file> --repo <local history-deltas checkout>');
const repo=await realpath(path.resolve(args.repo));
const run=(argv,options={})=>execFileSync('git',['-c','core.autocrlf=false','-c','commit.gpgSign=false',...argv],
  {cwd:repo,windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024,...options});
const ident={...process.env,GIT_AUTHOR_NAME:'SemiScope market data',GIT_AUTHOR_EMAIL:'market-data@localhost',
  GIT_COMMITTER_NAME:'SemiScope market data',GIT_COMMITTER_EMAIL:'market-data@localhost'};
assert.equal(await realpath(run(['rev-parse','--show-toplevel']).trim()),repo,'--repo must point to the checkout root');
const gitdir=await realpath(run(['rev-parse','--absolute-git-dir']).trim());
function cleanCheckout(){
  assert.equal(run(['symbolic-ref','--short','HEAD']).trim(),'history-deltas','Required branch: history-deltas');
  assert.equal(run(['status','--porcelain=v1','--untracked-files=all']),'','A clean history-deltas checkout is required');
}
function head(){
  try{return run(['rev-parse','--verify','HEAD'],{stdio:['ignore','pipe','pipe']}).trim();}
  catch(e){if(e.status===128)return null;throw e;}
}
async function optionalIndex(){
  try {
    const f=path.join(repo,'index.json');assert((await lstat(f)).isFile(),'Index must be a regular file');
    return JSON.parse(await readFile(f,'utf8'));
  }catch(e){if(e.code!=='ENOENT')throw e;}
  return {schemaVersion:1,baseAsOf,baseRevision,baseGitCommit,latestDate:baseAsOf,sourceRevision:baseRevision,periods:[],days:{},lastDeltaSha256:null};
}
cleanCheckout();
const oldHead=head(), index=await optionalIndex(), payload=await readFile(path.resolve(args.delta)), digest=sha(payload), d=JSON.parse(payload);
for(const record of [index,d]){
  assert.equal(record.schemaVersion,1);assert.equal(record.baseAsOf,baseAsOf);assert.equal(record.baseRevision,baseRevision);
}
assert.equal(index.baseGitCommit,baseGitCommit);assert.equal(d.baseManifestSha256,baseManifestSha256);
assert(isDate(d.date)&&isDate(d.prevDate)&&doltSHA.test(d.sourceRevision)&&doltSHA.test(d.previousRevision));
// A later immutable source revision can contain several successive market
// sessions. The trading date advances even if the revision is reused.
assert(d.date>d.prevDate,'Delta trading date must increase');
assert(publishedCalendar(d.date)&&isTradingDay(d.date)&&previousTradingDay(d.date)===d.prevDate,'Nonconsecutive trading dates');
assert.equal(d.license,'CC BY-SA 4.0');assert.equal(d.licenseUrl,'https://creativecommons.org/licenses/by-sa/4.0/');
assert.deepEqual(d.columns,['open','high','low','close','volume']);
assert(dictionary(d.rows)&&dictionary(d.omitted)&&dictionary(index.days)&&Array.isArray(index.periods));
const symbols=Object.keys(d.rows),withheld=Object.keys(d.omitted);
assert(symbols.length>0&&Object.hasOwn(d.rows,'SPY')&&symbols.length===d.coverage?.exported);
assert.equal(withheld.length,d.coverage.omitted);assert.equal(symbols.length+withheld.length,d.coverage.base);
for(const symbol of symbols)assert(goodSymbol(symbol)&&validBar(d.rows[symbol])&&!Object.hasOwn(d.omitted,symbol),'Invalid OHLCV '+symbol);
for(const symbol of withheld)assert(goodSymbol(symbol)&&typeof d.omitted[symbol]==='string'&&d.omitted[symbol].length>0);
const indexedDates=index.periods.flatMap(p=>p.dates);
assert.deepEqual(Object.keys(index.days).sort(),indexedDates);assert.equal(indexedDates.at(-1)??baseAsOf,index.latestDate);
assert.equal(index.days[index.latestDate]??null,index.lastDeltaSha256);assert(doltSHA.test(index.sourceRevision));
let priorDate=baseAsOf,priorMonth='';
for(const p of index.periods){
  assert(/^\d{4}-\d\d$/.test(p.month)&&p.month>priorMonth&&gitSHA.test(p.gitCommit)&&p.dates.length>0);
  assert.deepEqual(Object.keys(p.shas).sort(),[...shardIds].sort());assert(Object.values(p.shas).every(s=>sha256.test(s)));
  assert.equal(p.first,p.dates[0]);assert.equal(p.last,p.dates.at(-1));
  for(const date of p.dates){
    assert(isDate(date)&&date.startsWith(p.month+'-')&&previousTradingDay(date)===priorDate&&sha256.test(index.days[date]));
    priorDate=date;
  } priorMonth=p.month;
}
if(Object.hasOwn(index.days,d.date)){
  assert.equal(index.days[d.date],digest,'Same date has different verified bytes');
  assert.equal(sha(await readFile(path.join(repo,'days',d.date+'.json'))),digest,'Stored day hash mismatch');
  console.log(JSON.stringify({status:'already_applied',date:d.date,latestDate:index.latestDate,sha256:digest,indexCommit:oldHead}));process.exit(0);
}
assert.equal(index.latestDate,d.prevDate,'Delta does not extend the published date');
assert.equal(index.sourceRevision,d.previousRevision,'Delta does not extend the published revision');
const month=d.date.slice(0,7),currentPeriod=index.periods.find(p=>p.month===month);
const grouped=Object.fromEntries(shardIds.map(id=>[id,Object.create(null)]));
for(const symbol of symbols.sort())grouped[hex(symbol)][symbol]=d.rows[symbol];
const temporaryRoot=await realpath(os.tmpdir());
const staged=await mkdtemp(path.join(temporaryRoot,'semiscope-delta-'));
try{
  const tree=path.join(staged,'tree');await mkdir(tree);
  const env={...ident,GIT_INDEX_FILE:path.join(staged,'git-index'),GIT_DIR:gitdir,GIT_WORK_TREE:tree};
  const git=argv=>run(argv,{cwd:tree,env}).trim();
  if(oldHead)git(['read-tree',oldHead]);else git(['read-tree','--empty']);
  const paths=[],shas={},blobs=new Map(),directory='shards/'+month+'/';
  await mkdir(path.join(tree,directory),{recursive:true});await mkdir(path.join(tree,'days'));
  for(const id of shardIds){
    const name=directory+id+'.json';
    let shard={schemaVersion:1,baseAsOf,baseRevision,month,days:[]};
    if(currentPeriod){
      const old=await readFile(path.join(repo,name));
      assert.equal(sha(old),currentPeriod.shas[id],'Existing month hash mismatch '+id);
      shard=JSON.parse(old);
      assert.equal(shard.schemaVersion,1);assert.equal(shard.month,month);assert.equal(shard.baseRevision,baseRevision);assert.equal(shard.baseAsOf,baseAsOf);
      assert.deepEqual(shard.days.map(x=>x.date),currentPeriod.dates);
    }
    shard.days.push({prevDate:d.prevDate,date:d.date,sourceRevision:d.sourceRevision,rows:grouped[id]});
    const content=bytes(shard);shas[id]=sha(content);paths.push(name);blobs.set(name,gitBlob(content));await writeFile(path.join(tree,name),content);
  }
  const dayFile='days/'+d.date+'.json';paths.push(dayFile);blobs.set(dayFile,gitBlob(payload));await writeFile(path.join(tree,dayFile),payload);
  git(['add','--',...paths]);
  // Reject a checkout filter that silently transforms an immutable daily input
  // or shard. All hashes in the index refer to the actual published Git bytes.
  for(const line of git(['ls-files','--stage','--',...paths]).split('\n')){
    const [metadata,name]=line.split('\t');assert.equal(metadata.split(' ')[1],blobs.get(name),'Git byte mismatch '+name);blobs.delete(name);
  }
  assert.equal(blobs.size,0,'Missing staged archive objects');
  const dataTree=git(['write-tree']);
  const dataCommit=git(['commit-tree',dataTree,...(oldHead?['-p',oldHead]:[]),'-m','Market history shards '+d.date]);
  const dates=[...(currentPeriod?.dates??[]),d.date];
  const period={month,first:dates[0],last:d.date,dates,gitCommit:dataCommit,shas};
  const nextIndex={...index,latestDate:d.date,sourceRevision:d.sourceRevision,
    periods:[...index.periods.filter(p=>p.month!==month),period],days:{...index.days,[d.date]:digest},lastDeltaSha256:digest};
  await writeFile(path.join(tree,'index.json'),bytes(nextIndex));git(['add','--','index.json']);
  const indexCommit=git(['commit-tree',git(['write-tree']),'-p',dataCommit,'-m','Market history index '+d.date]);
  // Both objects are durable before the ordinary fast-forward touches the
  // consumer checkout. A failed/interrupted preparation leaves its branch intact.
  cleanCheckout();assert.equal(head(),oldHead,'Checkout advanced concurrently; rerun');
  run(['-c','core.hooksPath='+path.join(staged,'no-hooks'),'merge','--ff-only','--no-edit',indexCommit],{env:ident});
  assert.equal(head(),indexCommit);
  console.log(JSON.stringify({status:'applied',date:d.date,exported:symbols.length,month,shards:256,sha256:digest,dataCommit,indexCommit}));
}finally{
  const owned=await realpath(staged);
  assert.equal(path.dirname(owned),temporaryRoot);assert.match(path.basename(owned),/^semiscope-delta-[A-Za-z0-9]{6}$/);
  await rm(owned,{recursive:true,force:true});
}
