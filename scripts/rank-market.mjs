// Node 22+ and Dolt. Private price data stays in --cache. Only the final
// CC BY-SA score dataset is written to the site's public data directory.
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {buildAccumulation,buildFactorTape,ACCUMULATION_VERSION,ACCUMULATION_WEIGHTS} from '../src/accumulation.mjs';
import {BOTTOM_TIMING_VERSION,BOTTOM_TIMING_WEIGHTS,latestBottomTiming} from '../src/bottom-timing.mjs';
import {UNIFIED_VERSION,UNIFIED_MIN_BARS,latestUnifiedIndex,encodeUnifiedResult} from '../src/unified-index.mjs';
import {BOTTOM_TARGET_ID,CALIBRATION,CALIBRATION_VERSION} from '../src/bottom-calibration.mjs';
import {assessListing,assessUnifiedListing} from '../src/unified-eligibility.mjs';

const {values:args}=parseArgs({options:{
  dolt:{type:'string'},cache:{type:'string'},db:{type:'string'},'data-dir':{type:'string'},
  'as-of':{type:'string'},revision:{type:'string'},update:{type:'boolean',default:false},
  'export-private-bars':{type:'string'},'prepare-bars':{type:'boolean'},'lag-report':{type:'string'}
}});
if(args.revision!==undefined && !/^[0-9a-v]{32}$/.test(args.revision))
  throw Error('A pinned revision must be the full 32-character Dolt commit hash');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.resolve(args['data-dir']??path.join(root,'public','data'));
const cache=path.resolve(args.cache??path.join(root,'.rank-cache')),db=path.resolve(args.db??path.join(cache,'stockdb'));
const binary=args.dolt && /[\\/]/.test(args.dolt)?path.resolve(args.dolt):(args.dolt??'dolt');
const sourceRepo='post-no-preference/stocks';
const buildVersion='rank-market-4.0';
const reasonLabels={unsupported_structure:'모델 대상 외 증권 유형',no_source:'가격 자료 없음',not_current:'기준일 체결 자료 없음',
  short_history:'확정 거래일 504개 미만',invalid_history:'종가·OHLC 품질 확인 필요',uncertain_action:'분할 또는 가격 단절 확인 필요',
  halted:'장기 거래 공백 이후 이력 부족',benchmark_unavailable:'기준시장 이력 부족'};
const unifiedReasonLabels={...reasonLabels,short_history:'확정 거래일 252개 미만',
  insufficient_calibration:'비슷한 과거 저점에서 40거래일 결과가 확정된 표본 부족',
  inactive_or_discontinuous:'최근 63거래일의 가격 변화 또는 거래 연속성 부족'};
delete unifiedReasonLabels.benchmark_unavailable;
const lookback=1008; // 252 high observations + up to 756 preceding drawdown observations.
const shardCount=48;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const sha=string=>createHash('sha256').update(string).digest('hex');
const barFile=id=>path.join(barCache,'bars-'+String(id).padStart(2,'0')+'.csv');
const zeroCounts=()=>Object.fromEntries(Object.keys(reasonLabels).map(k=>[k,0]));

async function atomic(file,data) {
  const tmp=file+'.tmp-'+process.pid;
  await writeFile(tmp,data);
  await rename(tmp,file);
}
function command(argv,cwd,output='pipe') {
  const child=spawn(binary,argv,{cwd,stdio:['ignore',output,'pipe'],windowsHide:true});
  let errorText='';
  child.stderr.on('data',s=>{errorText=(errorText+s).slice(-2500);});
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(Error('Dolt command failed ('+code+'). '+errorText)));
  });
  done.catch(()=>{}); // The consumer can finish draining stdout after an early process error.
  return {child,done};
}
async function textCommand(argv,cwd=db) {
  const {child,done}=command(argv,cwd);
  let output='';
  for await(const s of child.stdout)output+=s;
  await done;return output;
}
const query=q=>textCommand(['sql','-r','csv','-q',q]);
const scalar=async q=>(await query(q)).trim().split(/\r?\n/)[1];
async function streamQuery(q,handle) {
  const {child,done}=command(['sql','-r','csv','-q',q],db);
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  let header=true;
  try{
    for await(const line of lines){if(header){header=false;continue;}const wait=handle(line);if(wait)await wait;}
    await done;
  } catch(error){child.kill();throw error;}
}
function shard(symbol) {
  let n=0;for(const ch of symbol)n=(n*31+ch.charCodeAt(0))>>>0;
  return n%shardCount;
}
async function partition() {
  const marker=path.join(barCache,'parts.done');
  if(existsSync(marker))return;
  // Composite primary key (date, act_symbol) permits one local chronological
  // scan of the source, independent of the number of listings.
  const temporary=Array.from({length:shardCount},(_,i)=>barFile(i)+'.tmp-'+process.pid);
  const streams=temporary.map(file=>createWriteStream(file));
  const startDate=new Date(asOf+'T00:00:00Z');
  startDate.setUTCFullYear(startDate.getUTCFullYear()-5);
  const start=startDate.toISOString().slice(0,10);
  let retained=0;
  const sql="SELECT act_symbol,date,open,high,low,close,volume FROM ohlcv AS OF '"+commit+"' WHERE date >= '"+start+"' AND date <= '"+asOf+"' ORDER BY date,act_symbol";
  try{
    await streamQuery(sql,line=>{
      const symbol=line.slice(0,line.indexOf(','));
      if(!listedSymbols.has(symbol))return;
      retained++;
      const file=streams[shard(symbol)];
      if(!file.write(line+'\n'))return once(file,'drain');
    });
    await Promise.all(streams.map(s=>new Promise((resolve,reject)=>{s.on('error',reject);s.end(resolve);})));
    for(let i=0;i<temporary.length;i++)await rename(temporary[i],barFile(i));
    await atomic(marker,JSON.stringify({retained,start,asOf}));
    console.log('Source scan complete:',retained,'candidate bars');
  } catch(error){streams.forEach(s=>s.destroy());throw error;}
}
async function loadShard(id,only) {
  const map=new Map(),lines=createInterface({input:createReadStream(barFile(id)),crlfDelay:Infinity});
  for await(const line of lines) {
    const [symbol,date,...s]=line.split(',');
    if(only && !only.has(symbol))continue;
    let bars=map.get(symbol);if(!bars){bars=[];map.set(symbol,bars);}
    bars.push([date,...s.map(v=>v===''?null:Number(v))]);
  }
  return map;
}
function validBar(c) {
  const [date,o,h,l,x,v]=c;
  return datePattern.test(date) && [o,h,l,x].every(v=>Number.isFinite(v)&&v>0) &&
    h>=Math.max(o,l,x) && l<=Math.min(o,x) && Number.isFinite(v) && v>=0;
}
function adjusted(symbol,raw,maxSessions=lookback,minimumSessions=504) {
  if(!raw?.length)return {reason:'no_source'};
  if(raw.at(-1)[0]!==asOf || !(raw.at(-1)[5]>0))return {reason:'not_current'};
  const bars=[];
  let priorSession=-1,cutForGap=false;
  for(const c of raw) {
    // A zero-volume observation does not establish a traded price that day.
    if(c[5]===0)continue;
    const session=calendar.get(c[0]);
    if(session==null)continue;
    if(priorSession>=0 && session-priorSession>10){bars.length=0;cutForGap=true;}
    priorSession=session;bars.push(c);
  }
  if(bars.length<minimumSessions)return {reason:cutForGap?'halted':'short_history'};
  const subset=bars.slice(-maxSessions);
  if(!subset.every(validBar))return {reason:'invalid_history'};
  const adjustedBars=new Array(subset.length);
  const actions=splits.get(symbol)??[];
  let actionIndex=actions.length-1,scale=1;
  for(let i=subset.length-1;i>=0;i--) {
    const c=subset[i];
    const next=[c[0],c[1]*scale,c[2]*scale,c[3]*scale,c[4]*scale,c[5]/scale];
    if(!next.slice(1).every(Number.isFinite))return {reason:'invalid_history'};
    adjustedBars[i]=next;
    if(i===0)break;
    const prior=subset[i-1];let factor=1;
    while(actionIndex>=0 && actions[actionIndex].date>prior[0]) {
      const action=actions[actionIndex--];
      if(action.date<=c[0])factor*=action.ratio;
    }
    if(!Number.isFinite(factor)||factor<=0)return {reason:'uncertain_action'};
    // Cash dividends are untouched. The ex-date is already quoted on its new
    // share basis, so only preceding observations receive the conversion.
    const overnight=c[1]/prior[4],adjustedOvernight=overnight*factor;
    if(Math.abs(Math.log(factor))>Math.log(1.25) &&
      Math.abs(Math.log(adjustedOvernight))>=Math.abs(Math.log(overnight)))return {reason:'uncertain_action'};
    if(adjustedOvernight>1.70 || adjustedOvernight<1/1.70)return {reason:'uncertain_action'};
    scale/=factor;
  }
  return {ticker:symbol,asOf,candles:adjustedBars,availableSessions:bars.length};
}
function evaluate(listing,raw,refs) {
  const symbol=listing.symbol,asset=adjusted(symbol,raw);
  if(asset.reason)return {symbol,reason:asset.reason};
  const reference=assessListing(listing).reference;
  const set={...refs,[symbol]:asset};
  const tape=buildFactorTape(set,symbol,{referenceTicker:reference});
  if(!tape)return {symbol,reason:'benchmark_unavailable'};
  const model=buildAccumulation(set,symbol,{referenceTicker:reference,factorTape:tape});
  if(!model)return {symbol,reason:'benchmark_unavailable'};
  const {252:one,504:two}=model.horizons;
  return {symbol,providerSymbol:listing.providerSymbol??symbol,name:listing.name,exchange:listing.exchange,
    type:listing.type,reference,asOf,nBars:asset.candles.length,score252:one.score,score504:two.score,
    factors:one.components.map(c=>c.score),inputs:model.inputs,timing:latestBottomTiming(tape)};
}
function assignRank(rows,horizon) {
  const score='score'+horizon,rank='rank'+horizon;
  rows.sort((a,b)=>b[score]-a[score] || a.symbol.localeCompare(b.symbol,'en'));
  for(let i=0;i<rows.length;i++)rows[i][rank]=i && rows[i][score]===rows[i-1][score]?rows[i-1][rank]:i+1;
}

function unifiedEvaluation(listing,raw) {
  // The unified rubric uses exactly the final 252 prices. Corporate actions
  // before its input window cannot change a current quote or its eligibility.
  const asset=adjusted(listing.symbol,raw,UNIFIED_MIN_BARS,UNIFIED_MIN_BARS);
  if(asset.reason)return {reason:asset.reason};
  const result=latestUnifiedIndex(asset.candles);
  if(!result)return {reason:'inactive_or_discontinuous'};
  if(result.score===null)return {reason:'insufficient_calibration'};
  if(result.version!==UNIFIED_VERSION||!Number.isInteger(result.score)||result.score<0||result.score>100)
    throw Error('Unexpected bottom probability for '+listing.symbol);
  const packet=encodeUnifiedResult(result);
  if(!packet)throw Error('Unable to represent the verified unified score for '+listing.symbol);
  return {score:result.score,nBars:asset.availableSessions,packet};
}

function addUnifiedRanks(rows) {
  const order=[...rows].sort((a,b)=>b.score-a.score || a.row.symbol.localeCompare(b.row.symbol,'en'));
  let rank=0;
  for(const [i,item] of order.entries()) {
    if(!i || order[i-1].score!==item.score)rank=i+1;
    item.row.unifiedRank=rank;
  }
}

// Auditors can recreate the historical inputs for the fixed, currently ranked
// cohort without exposing price tapes in the website or publishing workflow.
async function exportPrivateBars(destination) {
  const target=path.resolve(destination), inside=path.relative(root,target);
  if(!inside.startsWith('..'+path.sep) && !path.isAbsolute(inside))throw Error('Private bar export must be outside the project.');
  const baseline=JSON.parse(await readFile(path.join(dir,'long-ranks.json'),'utf8'));
  if(baseline.asOf!==asOf || baseline.source.commit!==commit || baseline.coverage.scored!==baseline.rows.length)
    throw Error('Public cohort does not match the pinned date and source revision.');
  const cohort=new Map(baseline.rows.map(row=>[row.symbol,row.reference]));
  for(const ticker of [...cohort.values(),'SPY'])if(!cohort.has(ticker))cohort.set(ticker,'SPY');
  await mkdir(path.dirname(target),{recursive:true});
  const temporary=target+'.tmp-'+process.pid,output=createWriteStream(temporary),digest=createHash('sha256');
  let count=0,fallbacks=0,shortest=Infinity,longest=0;
  for(let id=0;id<shardCount;id++) {
    for(const [symbol,raw] of await loadShard(id,cohort)){
      let asset=adjusted(symbol,raw,Number.MAX_SAFE_INTEGER);
      if(asset.reason){asset=adjusted(symbol,raw);fallbacks++;}
      if(asset.reason)throw Error('The retained cohort lost verified bars for '+symbol);
      const line=JSON.stringify({symbol,reference:cohort.get(symbol),candles:asset.candles})+'\n';
      digest.update(line);
      if(!output.write(line))await once(output,'drain');
      shortest=Math.min(shortest,asset.candles.length);longest=Math.max(longest,asset.candles.length);count++;
    }
  }
  await new Promise((resolve,reject)=>{output.once('error',reject);output.end(resolve);});
  if(count!==cohort.size)throw Error('Missing requested symbols in the private audit export');
  await rename(temporary,target);
  const meta={asOf,commit,source:'post-no-preference/stocks',actionThrough,scored:baseline.rows.length,
    exported:count,minimumBars:shortest,maximumBars:longest,truncatedFallbacks:fallbacks,sha256:digest.digest('hex'),
    basis:'Split-adjusted OHLCV. Zero-volume rows omitted. Gaps over 10 traded SPY sessions restart history; unclear split or >1.70x overnight dislocations fail quality checks. Invalid older history falls back to the last 1008 verified bars.'};
  await atomic(target+'.meta.json',JSON.stringify(meta));
  console.log('Private historical validation export complete.',JSON.stringify(meta));
}

await mkdir(cache,{recursive:true});
if(!existsSync(path.join(db,'.dolt'))) {
  await mkdir(path.dirname(db),{recursive:true});
  // A fresh historical replay needs the commit's objects even after the
  // source advances. Normal daily execution only needs the tip.
  const depth=args.revision?['--single-branch','--branch','master']:['--depth','1'];
  await textCommand(['clone',...depth,sourceRepo,db],cache);
} else if(args.update) {
  // Fetching a tracking ref needs no login or commit identity. Read immutable
  // tables at that ref below, without merging or altering the working branch.
  for(let attempt=0;;attempt++) {
    try {await textCommand(['fetch','origin','master'],db);break;}
    catch(error) {
      if(attempt>=2 || !/read only|lock/i.test(error.message))throw error;
      await pause((attempt+1)*1500);
    }
  }
}
const ref=args.revision??'origin/master';
const commit=await scalar("SELECT dolt_hashof('"+ref+"') AS revision");
if(!/^[0-9a-v]{32}$/.test(commit??''))throw Error('Dolt revision could not be established');
if(args.revision && commit!==args.revision)throw Error('Local Dolt mirror does not contain the requested revision');
const latest=await scalar("SELECT MAX(date) AS latest FROM ohlcv AS OF '"+commit+"'");
const asOf=args['as-of']??latest;
if(!datePattern.test(asOf)||asOf>latest)throw Error('No source close for requested date');
const catalog=JSON.parse(await readFile(path.join(dir,'us-listings.json'),'utf8'));
if (!args.revision && !args['as-of'] && datePattern.test(catalog.asOf) && latest<catalog.asOf) {
  if(args['lag-report'])await atomic(path.resolve(args['lag-report']),JSON.stringify({
    priceDate:latest,directoryDate:catalog.asOf,sourceCommit:commit
  }));
  console.error('Published price history ends '+latest+'; the listing directory is dated '+catalog.asOf);
  process.exit(75);
}
if(catalog.asOf!==asOf)throw Error('Listing date '+catalog.asOf+' differs from price date '+asOf);
if(!catalog.items?.length || catalog.items.length!==catalog.count || new Set(catalog.items.map(l=>l.symbol)).size!==catalog.count)
  throw Error('Incomplete or ambiguous listing directory');
// This private source cache depends only on the pinned price revision, cutoff,
// extraction window, and listing identities. Model versions share the same scan.
const listedSymbols=new Set(catalog.items.map(l=>l.symbol));
const extractionKey=sha(JSON.stringify(['ohlcv-5y-v1',shardCount,[...listedSymbols].sort()])).slice(0,14);
const barCache=path.join(cache,asOf+'-'+commit+'-'+extractionKey);
await mkdir(barCache,{recursive:true});
await partition();
if(args['prepare-bars'])process.exit(0);
const candidates=catalog.items.filter(l=>assessListing(l).reference);
const legacyEligible=new Set(candidates.map(l=>l.symbol));
const unifiedEligible=new Set(catalog.items.filter(l=>assessUnifiedListing(l).eligible).map(l=>l.symbol));
const wanted=new Map(catalog.items.filter(l=>legacyEligible.has(l.symbol)||unifiedEligible.has(l.symbol)).map(l=>[l.symbol,l]));
const groups=Array.from({length:shardCount},()=>[]);
for(const l of wanted.values())groups[shard(l.symbol)].push(l);
const defs=await Promise.all(['../src/accumulation.mjs','../src/bottom-timing.mjs',
  '../src/unified-index.mjs','../src/bottom-strength.mjs','../src/bottom-calibration.mjs','../src/bottom-calibration-data.json',
  '../src/unified-eligibility.mjs','../src/cef-registry.mjs','../src/bdc-registry.mjs',
  './rank-market.mjs'].map(rel=>readFile(new URL(rel,import.meta.url))));
const configHash=sha([catalog.asOf,JSON.stringify(catalog.items),...defs].join('\n')).slice(0,14);
const job=path.join(cache,asOf+'-'+commit+'-'+configHash);
await mkdir(job,{recursive:true});
// Fetch once locally, with commit-keyed partitions. Neither API requests per
// symbol nor exchange credentials are required. Later re-runs only Dolt-pull
// changed database chunks; a new commit causes a fresh split/action scan.
const splits=new Map();
await streamQuery("SELECT act_symbol,ex_date,to_factor,for_factor FROM split AS OF '"+commit+"' WHERE ex_date <= '"+asOf+"' ORDER BY act_symbol,ex_date",line=>{
  const [symbol,date,to,from]=line.split(',');
  if(!wanted.has(symbol))return;
  const a=splits.get(symbol)??[];a.push({date,ratio:Number(to)/Number(from)});splits.set(symbol,a);
});
const actionThrough=await scalar("SELECT MAX(ex_date) AS latest FROM split AS OF '"+commit+"' WHERE ex_date <= '"+asOf+"'");
const refSymbols=new Set(['SPY',...candidates.map(l=>assessListing(l).reference)]);
const rawRefs=new Map();
for(const id of new Set([...refSymbols].map(shard)))for(const [k,v] of await loadShard(id,refSymbols))rawRefs.set(k,v);
const spy=rawRefs.get('SPY')??[];
if(spy.length<504 || spy.at(-1)[0]!==asOf || !(spy.at(-1)[5]>0))throw Error('SPY trading calendar unavailable for cutoff');
const calendar=new Map(spy.filter(c=>c[5]>0).map((c,i)=>[c[0],i]));
if(args['export-private-bars']) {
  await exportPrivateBars(args['export-private-bars']);
  process.exit(0);
}
const vintage=CALIBRATION.vintages.findLast(v=>v.date<=asOf);
if(CALIBRATION.targetId!==BOTTOM_TARGET_ID||CALIBRATION.calibrationVersion!==CALIBRATION_VERSION||!vintage?.bins?.length||
   !datePattern.test(vintage.through)||vintage.through>=asOf)throw Error('No mature bottom calibration for this ranking date');
const unifiedCalibration={version:CALIBRATION_VERSION,sha256:sha(JSON.stringify(CALIBRATION)),
  vintage:vintage.date,outcomesThrough:vintage.through};
const refs={};
for(const [key,bars] of rawRefs){const ref=adjusted(key,bars);if(!ref.reason)refs[key]=ref;}
if(!refs.SPY)throw Error('Benchmark price integrity could not be verified');
const rows=[],excludedBySymbol={},excluded=zeroCounts();
const unifiedOnlyRows=[],unifiedRanked=[],unifiedExcludedBySymbol={};
const unifiedExcluded=Object.fromEntries(Object.keys(unifiedReasonLabels).map(key=>[key,0]));
excluded.unsupported_structure=catalog.count-candidates.length;
unifiedExcluded.unsupported_structure=catalog.count-unifiedEligible.size;
for(let id=0;id<shardCount;id++) {
  const part=path.join(job,'scores-'+String(id).padStart(2,'0')+'.json');
  let values;
  if(existsSync(part))values=JSON.parse(await readFile(part,'utf8'));
  else {
    const bars=await loadShard(id,wanted);
    values=groups[id].map(listing=>{
      const symbol=listing.symbol,raw=bars.get(symbol);
      const legacy=legacyEligible.has(symbol)?evaluate(listing,raw,refs):null;
      const unified=unifiedEligible.has(symbol)?unifiedEvaluation(listing,raw):null;
      return {symbol,legacy,unified};
    });
    await atomic(part,JSON.stringify(values));
  }
  for(const {symbol,legacy,unified} of values) {
    let row=null;
    if(legacy?.reason){excluded[legacy.reason]++;excludedBySymbol[symbol]=legacy.reason;}
    else if(legacy){row=legacy;row.unified=null;row.unifiedRank=null;rows.push(row);}
    if(unified?.reason){unifiedExcluded[unified.reason]++;unifiedExcludedBySymbol[symbol]=unified.reason;}
    else if(unified){
      if(!row){
        const listing=wanted.get(symbol);
        row={symbol,providerSymbol:listing.providerSymbol??symbol,name:listing.name,exchange:listing.exchange,
          type:listing.type,asOf,nBars:unified.nBars};
        unifiedOnlyRows.push(row);
      }
      row.unified=unified.packet;
      unifiedRanked.push({row,score:unified.score});
    }
  }
  if((id+1)%8===0)console.log('Evaluated shards',id+1,'/',shardCount,'· scores',rows.length);
}
assignRank(rows,504);assignRank(rows,252);
addUnifiedRanks(unifiedRanked);
unifiedOnlyRows.sort((a,b)=>a.unifiedRank-b.unifiedRank||a.symbol.localeCompare(b.symbol,'en'));
const source={name:'DoltHub · post-no-preference/stocks',url:'https://www.dolthub.com/repositories/post-no-preference/stocks',
  license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',commit,actionThrough,
  changeNotice:'Semiscope가 분할 조정 일봉으로 확인된 저점·반등 조건의 확률과 종목 순위를 계산했습니다. 가공한 순위 데이터에도 CC BY-SA 4.0을 적용합니다.'};
const output={schemaVersion:1,modelVersion:ACCUMULATION_VERSION,buildVersion,asOf,generatedAt:new Date().toISOString(),
  source,listingSource:catalog.source,weights:ACCUMULATION_WEIGHTS,minimumSessions:504,maximumSessions:lookback,
  coverage:{listed:catalog.count,eligible:candidates.length,scored:rows.length,excluded},reasonLabels,excludedBySymbol,rows,
  timingModelVersion:BOTTOM_TIMING_VERSION,timingWeights:BOTTOM_TIMING_WEIGHTS,
  timingCoverage:{scored:rows.filter(row=>row.timing?.date===asOf).length,eligible:rows.length},
  unifiedModelVersion:UNIFIED_VERSION,unifiedMinimumSessions:UNIFIED_MIN_BARS,unifiedTargetId:BOTTOM_TARGET_ID,unifiedCalibration,
  unifiedCoverage:{listed:catalog.count,eligible:unifiedEligible.size,scored:unifiedRanked.length,excluded:unifiedExcluded},
  unifiedOnlyRows,unifiedExcludedBySymbol,unifiedReasonLabels};
if(rows.length+Object.values(excluded).reduce((a,b)=>a+b,0)!==catalog.count || !rows.length)
  throw Error('Rank population reconciliation failed');
if(!unifiedRanked.length || unifiedRanked.length+Object.values(unifiedExcluded).reduce((a,b)=>a+b,0)!==catalog.count)
  throw Error('Unified rank population reconciliation failed');
await atomic(path.join(dir,'long-ranks.json'),JSON.stringify(output));
console.log('Verified ranking snapshot written.',asOf,'legacy',JSON.stringify(output.coverage),'unified',JSON.stringify(output.unifiedCoverage));
