// Append one fully verified trading session to the immutable CC BY-SA market archive.
// node scripts/export-history-delta.mjs --manifest <history checkout>/manifest.json --db <Dolt checkout> --from-revision <previous source commit> --to-revision <source commit> --prev-date <last verified date> --date <next session> --out days/<next session>.json [--dolt <binary>]
// Keep the manifest's 256 shards beside it in shards/. In order of trading date, pass
// --previous days/<earlier day>.json --previous-sha <trusted collection digest> for
// EACH already-published delta since the base. Both Dolt commits must be present.
// The tool only reads the archive and Dolt database; existing daily files are immutable.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {link, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {completedSessionDay, isTradingDay, previousTradingDay, publishedCalendar} from '../src/market-clock.mjs';

const {values:args}=parseArgs({options:{
  archive:{type:'string'},db:{type:'string'},revision:{type:'string'},date:{type:'string'},out:{type:'string'},dolt:{type:'string'},
  manifest:{type:'string'},'prev-date':{type:'string'},'from-revision':{type:'string'},'to-revision':{type:'string'},
  previous:{type:'string',multiple:true,default:[]},'previous-sha':{type:'string',multiple:true,default:[]}
}});
for(const k of ['db','date','out']) if(!args[k])throw Error('Missing --'+k);
if(!args.archive&&!args.manifest)throw Error('Provide --manifest or --archive');
if(args.archive&&args.manifest)assert.equal(path.resolve(args.archive,'manifest.json'),path.resolve(args.manifest));
if(args.revision&&args['to-revision'])assert.equal(args.revision,args['to-revision']);
const manifestPath=path.resolve(args.manifest??path.join(args.archive,'manifest.json'));
const archive=path.dirname(manifestPath), date=args.date, revision=args['to-revision']??args.revision;
const sha=data=>createHash('sha256').update(data).digest('hex');
const manifestBytes=await readFile(manifestPath);
const manifest=JSON.parse(manifestBytes), baseAsOf=manifest.asOf, baseRevision=manifest.sourceRevision;
const isDate=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
assert(isDate(date)&&isDate(baseAsOf));
assert(date<=completedSessionDay(),'Requested session has not completed and settled');
assert.equal(manifest.schemaVersion,1);
assert.equal(manifest.license,'CC BY-SA 4.0');
assert.match(baseRevision,/^[0-9a-v]{32}$/);
assert.match(revision,/^[0-9a-v]{32}$/);
const names=Object.keys(manifest.symbols).sort();
assert.equal(names.length,manifest.coverage.exported);
const last=new Map();
function valid(bar) {
  if(!Array.isArray(bar)||bar.length!==5) return false;
  const [o,h,l,c,v]=bar;
  return [o,h,l,c].every(n=>Number.isFinite(n)&&n>0)&&Number.isSafeInteger(v)&&v>0&&
    h>=Math.max(o,c,l)&&l<=Math.min(o,c);
}
for(const [id,expected] of Object.entries(manifest.shas)){
  assert.match(id,/^[\da-f]{2}$/);
  const bytes=await readFile(path.join(archive,'shards',id+'.json'));
  assert.equal(sha(bytes),expected,'Archive shard hash mismatch: '+id);
  const shard=JSON.parse(bytes);
  assert.equal(shard.v,1);assert.equal(shard.asOf,baseAsOf);assert.equal(shard.revision,baseRevision);
  for(const [symbol,history] of Object.entries(shard.rows)){
    assert.equal(manifest.symbols[symbol][0],id);assert.equal(manifest.symbols[symbol][1],history.length);
    assert.equal(history.at(-1)[0],baseAsOf);assert(!last.has(symbol));
    const bar=history.at(-1).slice(1);
    assert(valid(bar),symbol+' invalid archived last bar');
    last.set(symbol,bar);
  }
}
assert.equal(last.size,names.length);
let previousDate=baseAsOf, previousRevision=baseRevision;
assert.equal(args.previous.length,args['previous-sha'].length);
function requireNext(previous,current){
  assert(publishedCalendar(previous)&&publishedCalendar(current)&&isTradingDay(previous)&&isTradingDay(current)&&
    previousTradingDay(current)===previous,previous+' and '+current+' must be consecutive published regular trading days');
}
for(const [i,file] of args.previous.entries()){
  const bytes=await readFile(file);assert.equal(sha(bytes),args['previous-sha'][i],'Previous delta digest mismatch');
  const d=JSON.parse(bytes);assert.equal(d.schemaVersion,1);assert.equal(d.baseAsOf,baseAsOf);assert.equal(d.baseRevision,baseRevision);
  assert.equal(d.prevDate,previousDate);assert.equal(d.previousRevision,previousRevision);assert.equal(d.baseManifestSha256,sha(manifestBytes));
  assert.match(d.sourceRevision,/^[0-9a-v]{32}$/);assert(isDate(d.date));requireNext(previousDate,d.date);
  assert.equal(Object.keys(d.rows).length,d.coverage.exported);
  assert.equal(Object.keys(d.rows).length+Object.keys(d.omitted).length,names.length);
  for(const symbol of names){
    if(Object.hasOwn(d.rows,symbol)){
      assert(!Object.hasOwn(d.omitted,symbol)&&last.has(symbol)&&valid(d.rows[symbol]),'Invalid child row '+symbol);
      last.set(symbol,d.rows[symbol]);
    } else {assert(Object.hasOwn(d.omitted,symbol));last.delete(symbol);}
  }
  previousRevision=d.sourceRevision;previousDate=d.date;
}
if(args['prev-date'])assert.equal(previousDate,args['prev-date'],'Previous date does not match the verified delta chain');
if(args['from-revision'])assert.equal(previousRevision,args['from-revision'],'Previous revision does not match the verified delta chain');
requireNext(previousDate,date);
const exec=promisify(execFile);
async function query(sql){
  const {stdout}=await exec(args.dolt||'dolt',['sql','-r','json','-q',sql],
    {cwd:path.resolve(args.db),encoding:'utf8',windowsHide:true,maxBuffer:96*1024*1024});
  const payload=JSON.parse(stdout);
  if(payload && !Object.keys(payload).length) return []; // Dolt JSON encodes a successful empty query as {}.
  assert(Array.isArray(payload.rows));return payload.rows;
}
const old=" AS OF '"+previousRevision+"'",current=" AS OF '"+revision+"'";
const diff=table=>"DOLT_DIFF('"+previousRevision+"','"+revision+"','"+table+"')";
const dayFields='act_symbol,open,high,low,close,volume';
const metaFields='act_symbol,security_name,listing_exchange,is_etf,is_test_issue,is_next_shares,cqs_symbol,nasdaq_symbol,last_seen';
const tables=await Promise.all([
  query('SELECT '+dayFields+' FROM ohlcv'+old+" WHERE date='"+previousDate+"'"),
  query('SELECT '+dayFields+' FROM ohlcv'+current+" WHERE date='"+date+"'"),
  query('SELECT '+metaFields+' FROM symbol'+old),query('SELECT '+metaFields+' FROM symbol'+current),
  query('SELECT COALESCE(to_act_symbol,from_act_symbol) AS act_symbol,COALESCE(to_date,from_date) AS d,diff_type FROM '+diff('ohlcv')),
  query('SELECT COALESCE(to_act_symbol,from_act_symbol) AS act_symbol,COALESCE(to_ex_date,from_ex_date) AS d FROM '+diff('split')),
  query('SELECT act_symbol,ex_date AS d FROM split'+current+" WHERE ex_date>'"+previousDate+"' AND ex_date<='"+date+"'"),
  query('SELECT date FROM ohlcv'+current+" WHERE act_symbol='SPY' AND volume>0 AND date>'"+previousDate+"' AND date<='"+date+"' ORDER BY date"),
  query("SELECT (SELECT MAX(date) FROM ohlcv"+old+") AS previous_max,(SELECT MAX(date) FROM ohlcv"+current+") AS current_max"),
  query("SELECT doc_text FROM dolt_docs"+current+" WHERE doc_name='LICENSE.md'"),
  query('SELECT '+dayFields+' FROM ohlcv'+old+" WHERE date='"+date+"'")
]);
const [previousRaw,newRaw,oldMetadata,newMetadata,priceChanges,splitChanges,newActions,sessions,latest,license,alreadyPresent]=tables;
assert.deepEqual(sessions.map(r=>r.date),[date],'SPY does not confirm exactly one new trading session');
assert(latest[0].previous_max>=previousDate && latest[0].current_max>=date,'Pinned sources do not cover the requested dates');
assert.match(license[0]?.doc_text??'',/Attribution-ShareAlike 4\.0 International/i);
const keyed=rows=>new Map(rows.map(r=>[r.act_symbol,r]));
const olderBars=keyed(previousRaw),newBars=keyed(newRaw),oldMeta=keyed(oldMetadata),newMeta=keyed(newMetadata);
const oldTargetBars=keyed(alreadyPresent);
const closestDirectory=(rows,cutoff)=>{
  let mostRecent='';
  // A weekly source can arrive after an intermediate EOD; its last_seen verifies
  // identity only. Exact target-date trades and the historical ledger are checked separately.
  for(const row of rows) if(row.last_seen>mostRecent)mostRecent=row.last_seen;
  assert(isDate(mostRecent)&&Math.abs(Date.parse(cutoff)-Date.parse(mostRecent))<=8*86400000,'No nearby verified listing snapshot for this session');
  return mostRecent;
};
const oldStamp=closestDirectory(oldMetadata,previousDate),newStamp=closestDirectory(newMetadata,date);
const changedPrices=new Set(),confirmedAdditions=new Set(),changedSplits=new Set();
for(const {act_symbol:symbol,d,diff_type:type} of priceChanges){
  if(!Object.hasOwn(manifest.symbols,symbol)) continue;
  if(d===date&&type==='added')confirmedAdditions.add(symbol);
  else if(d>=manifest.symbols[symbol][2] && d<=date)changedPrices.add(symbol);
}
for(const {act_symbol:symbol,d} of [...splitChanges,...newActions]){
  if(Object.hasOwn(manifest.symbols,symbol)&& d>=manifest.symbols[symbol][2]&&d<=date)changedSplits.add(symbol);
}
const exchanges={'NYSE':'NYSE','NASDAQ':'Nasdaq','NYSE ARCA':'NYSE Arca','NYSE MKT':'NYSE American','BATS':'Cboe BZX','TXSE':'Texas Stock Exchange'};
const identityFields=['security_name','listing_exchange','is_etf','is_test_issue','is_next_shares','cqs_symbol','nasdaq_symbol'];
const norm=s=>String(s??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const bar=row=>['open','high','low','close','volume'].map(k=>row?.[k]==null?null:Number(row[k]));
function checked(symbol){
  if(!last.has(symbol))return 'previously_omitted';
  const oldId=oldMeta.get(symbol),newId=newMeta.get(symbol),identity=manifest.identities[symbol];
  if(!oldId || !newId || oldId.last_seen!==oldStamp || newId.last_seen!==newStamp)return 'listing_unverified';
  if(identityFields.some(k=>oldId[k]!==newId[k]) || Number(newId.is_test_issue)!==0 || newId.is_test_issue==null ||
    !newId.security_name || norm(newId.security_name)!==norm(identity[1]) ||
    exchanges[newId.listing_exchange]!==identity[2] || newId.is_etf==null ||
    Boolean(Number(newId.is_etf))!==(identity[3]==='etf'))return 'identity_changed';
  if(changedPrices.has(symbol))return 'historical_price_change';
  if(changedSplits.has(symbol))return 'split_or_basis_change';
  const anchor=bar(olderBars.get(symbol));
  if(!valid(anchor)||anchor.some((n,i)=>n!==last.get(symbol)[i]))return 'previous_bar_mismatch';
  if(!newBars.has(symbol))return 'no_new_bar';
  const next=bar(newBars.get(symbol));
  if(next[4]===0)return 'no_trade';
  if(!valid(next))return 'invalid_ohlcv';
  if(!confirmedAdditions.has(symbol)){
    // On a backlog, several verified adjacent sessions can use the same commit.
    // A pre-existing row must match both pinned sources exactly; it need not be an addition.
    const oldTarget=bar(oldTargetBars.get(symbol));
    if(!valid(oldTarget)||oldTarget.some((v,i)=>v!==next[i]))return 'new_bar_unverified';
  }
  const overnight=next[0]/anchor[3];
  if(overnight>1.70 || overnight<1/1.70)return 'uncertain_action';
  return next;
}
const rows=Object.create(null),omitted=Object.create(null),reasons=Object.create(null);
for(const symbol of names){
  const result=checked(symbol);
  if(Array.isArray(result))rows[symbol]=result;
  else{omitted[symbol]=result;reasons[result]=(reasons[result]??0)+1;}
}
assert(Object.hasOwn(rows,'SPY'),'An eligible active SPY control must pass the full append-only verification');
const coverage={base:names.length,exported:Object.keys(rows).length,omitted:Object.keys(omitted).length,reasons};
const artifact={schemaVersion:1,baseAsOf,prevDate:previousDate,date,baseRevision,previousRevision,sourceRevision:revision,
  baseManifestSha256:sha(manifestBytes),source:{name:manifest.source.name,url:manifest.source.url,commitUrl:manifest.source.url+'/data/'+revision},
  license:manifest.license,licenseUrl:manifest.licenseUrl,columns:['open','high','low','close','volume'],
  adjustments:'Append-only regular-session OHLCV on the verified existing split basis. Cash dividends excluded. Unverified or changed histories are withheld.',
  rows,coverage,omitted};
const destination=path.resolve(args.out);
const target=path.extname(destination).toLowerCase()==='.json'?destination:path.join(destination,date+'.json');
assert.equal(path.basename(target),date+'.json','Output filename must identify the verified date');
await mkdir(path.dirname(target),{recursive:true});
const temporary=target+'.tmp-'+process.pid;
const bytes=JSON.stringify(artifact)+'\n';
await writeFile(temporary,bytes,{flag:'wx'});
try{
  try{await link(temporary,target);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(sha(await readFile(target)),sha(bytes),'An existing immutable delta differs');}
}finally{await unlink(temporary);}
console.log(JSON.stringify({target,date,coverage,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}));
