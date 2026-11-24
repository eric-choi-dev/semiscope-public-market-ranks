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
import {UNIFIED_VERSION,UNIFIED_MIN_BARS,latestUnifiedIndex,encodeUnifiedResult,selectUnifiedHorizon} from '../src/unified-index.mjs';
import {assessUnifiedListing} from '../src/unified-eligibility.mjs';

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
const buildVersion='rank-market-5.0';
const horizons=[126,252];
const reasonLabels={unsupported_structure:'모델 대상 외 증권 유형',no_source:'가격 자료 없음',not_current:'기준일 체결 자료 없음',
  short_history:'지수 계산에 필요한 확정 거래일 부족',invalid_history:'종가·OHLC 품질 확인 필요',uncertain_action:'분할 또는 가격 단절 확인 필요',
  halted:'장기 거래 공백 이후 이력 부족',
  inactive_or_discontinuous:'확인된 가격 변화 또는 거래 연속성 부족'};
const archiveLookback=1008;
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
function adjusted(symbol,raw,maxSessions=archiveLookback,minimumSessions=504) {
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
function evaluate(listing,raw) {
  const symbol=listing.symbol;
  let input=adjusted(symbol,raw,UNIFIED_MIN_BARS+1,UNIFIED_MIN_BARS);
  // Keep the verifiable minimum suffix if only the optional preceding
  // transition is invalid or has an unresolved corporate action.
  if(input.reason==='invalid_history'||input.reason==='uncertain_action')
    input=adjusted(symbol,raw,UNIFIED_MIN_BARS,UNIFIED_MIN_BARS);
  if(input.reason)return {symbol,reason:input.reason};
  const model=latestUnifiedIndex(input.candles);
  if(!model)return {symbol,reason:'inactive_or_discontinuous'};
  if(model.version!==UNIFIED_VERSION||model.date!==asOf)throw Error('Mismatched model version or date for '+symbol);
  const row={symbol,providerSymbol:listing.providerSymbol??symbol,name:listing.name,exchange:listing.exchange,
    type:listing.type,asOf,nBars:input.candles.length,indices:{126:null,252:null},ranks:{126:null,252:null}};
  const scores={};
  for(const horizon of horizons) {
    const selected=selectUnifiedHorizon(model,horizon);
    if(!selected||selected.score==null)throw Error('Incomplete 126/252-session result for '+symbol);
    const packet=encodeUnifiedResult(model,horizon);
    if(!Array.isArray(packet)||!Number.isInteger(selected.score)||selected.score<0||selected.score>100)
      throw Error('Unrepresentable '+horizon+'-session result for '+symbol);
    row.indices[horizon]=packet;scores[horizon]=selected.score;
  }
  return {symbol,row,scores};
}

function rankHorizon(entries,horizon,excluded) {
  const order=entries.filter(entry=>Number.isInteger(entry.scores[horizon]))
    .sort((a,b)=>b.scores[horizon]-a.scores[horizon]||a.symbol.localeCompare(b.symbol,'en'));
  let rank=0,atLeast80=0;
  for(const [i,entry] of order.entries()) {
    const score=entry.scores[horizon];
    if(i===0||score!==order[i-1].scores[horizon])rank=i+1;
    entry.row.ranks[horizon]=rank;
    if(score>=80)atLeast80++;
  }
  return {scored:order.length,atLeast80,excluded};
}

async function modelDigest() {
  const files=new Map();
  async function readModule(url) {
    const name=path.relative(root,fileURLToPath(url)).split(path.sep).join('/');
    if(files.has(name))return;
    const code=(await readFile(url,'utf8')).replaceAll('\r\n','\n');
    files.set(name,code);
    if(name.endsWith('.json'))return;
    for(const match of code.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+\.(?:mjs|js|json))['"]/g))
      await readModule(new URL(match[1],url));
  }
  await readModule(new URL('../src/unified-index.mjs',import.meta.url));
  await readModule(new URL('../src/unified-eligibility.mjs',import.meta.url));
  return sha(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b,'en'))));
}

// Auditors can recreate the historical inputs for the fixed, currently ranked
// cohort without exposing price tapes in the website or publishing workflow.
async function exportPrivateBars(destination) {
  const target=path.resolve(destination), inside=path.relative(root,target);
  if(!inside.startsWith('..'+path.sep) && !path.isAbsolute(inside))throw Error('Private bar export must be outside the project.');
  const baseline=JSON.parse(await readFile(path.join(dir,'long-ranks.json'),'utf8'));
  if(baseline.asOf!==asOf || baseline.source.commit!==commit || !Array.isArray(baseline.rows) ||
     (baseline.schemaVersion===1 && baseline.coverage.scored!==baseline.rows.length))
    throw Error('Public cohort does not match the pinned date and source revision.');
  const cohort=new Map(baseline.rows.map(row=>[row.symbol,row.reference??'SPY']));
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
const wanted=new Map(catalog.items.filter(l=>assessUnifiedListing(l).eligible).map(l=>[l.symbol,l]));
const groups=Array.from({length:shardCount},()=>[]);
for(const listing of wanted.values())groups[shard(listing.symbol)].push(listing);
const modelSourceSha256=await modelDigest();
const configHash=sha([catalog.asOf,JSON.stringify(catalog.items),modelSourceSha256,
  await readFile(new URL('./rank-market.mjs',import.meta.url),'utf8')].join('\n')).slice(0,14);
const job=path.join(cache,asOf+'-'+commit+'-'+configHash);
await mkdir(job,{recursive:true});
const splits=new Map();
await streamQuery("SELECT act_symbol,ex_date,to_factor,for_factor FROM split AS OF '"+commit+"' WHERE ex_date <= '"+asOf+"' ORDER BY act_symbol,ex_date",line=>{
  const [symbol,date,to,from]=line.split(',');
  if(!wanted.has(symbol)&&!args['export-private-bars'])return;
  const a=splits.get(symbol)??[];a.push({date,ratio:Number(to)/Number(from)});splits.set(symbol,a);
});
const actionThrough=await scalar("SELECT MAX(ex_date) AS latest FROM split AS OF '"+commit+"' WHERE ex_date <= '"+asOf+"'");
const spy=(await loadShard(shard('SPY'),new Set(['SPY']))).get('SPY')??[];
if(spy.length<504 || spy.at(-1)[0]!==asOf || !(spy.at(-1)[5]>0))throw Error('SPY trading calendar unavailable for cutoff');
const calendar=new Map(spy.filter(c=>c[5]>0).map((c,i)=>[c[0],i]));
if(args['export-private-bars']) {
  await exportPrivateBars(args['export-private-bars']);
  process.exit(0);
}
const entries=[],excludedBySymbol={};
const exclusions=Object.fromEntries(horizons.map(h=>[h,zeroCounts()]));
for(const h of horizons)exclusions[h].unsupported_structure=catalog.count-wanted.size;
for(let id=0;id<shardCount;id++) {
  const part=path.join(job,'scores-'+String(id).padStart(2,'0')+'.json');
  let values;
  if(existsSync(part))values=JSON.parse(await readFile(part,'utf8'));
  else {
    const bars=await loadShard(id,wanted);
    values=groups[id].map(listing=>evaluate(listing,bars.get(listing.symbol)));
    await atomic(part,JSON.stringify(values));
  }
  for(const item of values) {
    const {symbol}=item;
    for(const horizon of horizons) {
      const reason=item.reason;
      if(reason) {
        exclusions[horizon][reason]++;
        (excludedBySymbol[symbol]??={})[horizon]=reason;
      }
    }
    if(item.row&&horizons.some(h=>Number.isInteger(item.scores[h])))entries.push(item);
  }
  if((id+1)%8===0)console.log('Evaluated shards',id+1,'/',shardCount,'· scored symbols',entries.length);
}
const byHorizon=Object.fromEntries(horizons.map(h=>[h,rankHorizon(entries,h,exclusions[h])]));
for(const h of horizons) {
  if(byHorizon[h].scored<1||byHorizon[h].scored+Object.values(exclusions[h]).reduce((sum,n)=>sum+n,0)!==catalog.count)
    throw Error('Unreconciled or empty '+h+'-session cohort');
}
const rows=entries.map(x=>x.row).sort((a,b)=>a.symbol.localeCompare(b.symbol,'en'));
const source={name:'DoltHub · post-no-preference/stocks',url:'https://www.dolthub.com/repositories/post-no-preference/stocks',
  license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',commit,actionThrough,
  changeNotice:'Semiscope가 분할 조정 일봉으로 126거래일 및 252거래일 장기 진입 지수와 기간별 순위를 계산했습니다. 가공 지수와 순위 자료에도 CC BY-SA 4.0을 적용합니다.'};
const output={schemaVersion:2,modelVersion:UNIFIED_VERSION,buildVersion,asOf,generatedAt:new Date().toISOString(),
  horizons,minimumSessions:UNIFIED_MIN_BARS,modelSourceSha256,source,listingSource:catalog.source,
  coverage:{listed:catalog.count,eligible:wanted.size,byHorizon},reasonLabels,excludedBySymbol,rows};
await atomic(path.join(dir,'long-ranks.json'),JSON.stringify(output));
console.log('Verified long-term index rankings written.',asOf,JSON.stringify(output.coverage));
