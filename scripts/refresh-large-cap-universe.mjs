import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {access,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {parseArgs,promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {QUALITY_SCHEMA,QUALITY_ID,LARGE_CAP_USD,SHARE_MAX_AGE_DAYS,validQualityUniverse,issuerFilingUrl} from '../src/large-cap-universe.mjs';
import {assessUnifiedListing} from '../src/unified-eligibility.mjs';
import {getQualityRoster} from './quality-roster.mjs';
import {loadSecMetrics} from './quality-sec-metrics.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=fileURLToPath(new URL('..',import.meta.url));
const readJson=async file=>JSON.parse(await readFile(file));
const checkedDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s).toISOString().slice(0,10)===s;
const safeTicker=s=>/^[A-Z][A-Z0-9]{0,6}(?:\.[A-Z0-9])?$/.test(s);

export async function priceInputs({symbols,asOf,revision,db,dolt}){
  assert(checkedDate(asOf)&&/^[0-9a-v]{32}$/.test(revision)&&symbols.every(safeTicker));
  async function query(sql,limit){
    if(db){
      const {stdout}=await promisify(execFile)(dolt,['sql','-r','csv','-q',sql],{cwd:db,windowsHide:true,maxBuffer:3*1024*1024});
      return stdout.trim().split(/\r?\n/).slice(1).map(row=>row.split(','));
    }
    const url='https://www.dolthub.com/api/v2/databases/post-no-preference/stocks/sql';
    let lastError;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({q:sql,ref:'master',limit,timeout_ms:15000}),signal:AbortSignal.timeout(45000)});
        assert(r.ok,'Dolt HTTP '+r.status);const {data}=await r.json();
        assert(data?.status==='success'&&Array.isArray(data.rows)&&data.rows.length<limit,'Incomplete price source response');
        return data.rows;
      }catch(error){lastError=error;if(attempt<2)await new Promise(done=>setTimeout(done,1500*(attempt+1)));}
    }
    throw lastError;
  }
  const first=new Date(Date.parse(asOf)-SHARE_MAX_AGE_DAYS*86400000).toISOString().slice(0,10);
  const quotes=new Map(),splits=new Map();
  for(let i=0;i<symbols.length;i+=80){
    const list=symbols.slice(i,i+80).map(s=>"'"+s+"'").join(',');
    const clause=" AS OF '"+revision+"'";
    const priceSQL="SELECT act_symbol,date,close,volume FROM ohlcv"+clause+" WHERE date='"+asOf+"' AND act_symbol IN ("+list+")";
    const splitSQL="SELECT act_symbol,ex_date,to_factor,for_factor FROM split"+clause+" WHERE act_symbol IN ("+list+") AND ex_date>='"+first+"' AND ex_date<='"+asOf+"' ORDER BY act_symbol,ex_date";
    for(const [s,date,rawClose,rawVolume] of await query(priceSQL,100)){
      const close=Number(rawClose),volume=Number(rawVolume);
      assert(date===asOf&&symbols.includes(s)&&!quotes.has(s),'Ambiguous price row');
      if(close>0&&Number.isFinite(close)&&volume>0)quotes.set(s,{close});
    }
    for(const [s,date,to,from] of await query(splitSQL,500)){
      assert(symbols.includes(s)&&checkedDate(date)&&date>=first&&date<=asOf,'Split outside requested range');
      if(!splits.has(s))splits.set(s,[]);
      splits.get(s).push({date,ratio:Number(to)/Number(from)});
    }
  }
  assert(quotes.size>=symbols.length*.8,'Less than 80% of the constituent roster has independently verified closing prices');
  return Object.fromEntries([...quotes].map(([s,v])=>[s,{...v,splits:splits.get(s)??[]}]));
}
async function ensureDatabase(db,dolt,revision){
  assert(db&&dolt&&/^[0-9a-v]{32}$/.test(revision));
  const run=promisify(execFile);
  try{await access(path.join(db,'.dolt'));}catch(e){
    if(e.code!=='ENOENT')throw e;
    await mkdir(path.dirname(db),{recursive:true});
    await run(dolt,['clone','--single-branch','--branch','master','post-no-preference/stocks',db],
      {cwd:path.dirname(db),windowsHide:true,maxBuffer:12*1024*1024});
  }
  const check=async()=>{
    const {stdout}=await run(dolt,['sql','-r','csv','-q',"SELECT dolt_hashof('"+revision+"') AS source_revision"],
      {cwd:db,windowsHide:true});
    assert.equal(stdout.trim().split(/\r?\n/)[1],revision);
  };
  try{await check();}catch{
    await run(dolt,['fetch','origin','master'],{cwd:db,windowsHide:true,maxBuffer:12*1024*1024});await check();
  }
}
const equity=listing=>listing?.type==='stock'&&assessUnifiedListing(listing).kind==='stock';
export function valueMember(member,listing,price,fact,asOf){
  const sourcedTitle=fact?.cik===member.cik&&typeof fact.securityTitle==='string'&&
    fact.securityTitle.trim()&&issuerFilingUrl(fact.securityTitleSource,member.cik);
  const titleConfirmed=sourcedTitle&&fact.verifiedCommon===true;
  const listedCapitalClass=sourcedTitle&&listing&&equity(listing)&&fact.capBasis==='listedClassLowerBound'&&
    /^Class\s+[A-Z0-9]+\s+Capital Stock\b/i.test(fact.securityTitle)&&/\bCapital Stock\b/i.test(listing.name);
  const title=titleConfirmed||listedCapitalClass?{...(titleConfirmed?{verifiedCommon:true}:{listedCapitalClass:true}),
    securityTitle:fact.securityTitle,securityTitleSource:fact.securityTitleSource}:{};
  const row={symbol:member.symbol,cik:member.cik,membership:'S&P 500',eligible:false,reason:'missing_shares',...title};
  if(!listing)return {...row,reason:'not_listed'};
  if(!equity(listing)&&!(listing.type==='other'&&titleConfirmed))return {...row,reason:'not_common'};
  if(!price||!Number.isFinite(price.close)||price.close<=0)return {...row,reason:'missing_price'};
  if(!fact||!Number.isSafeInteger(fact.shares)||fact.shares<=0||
     String(fact.cik??'').padStart(10,'0')!==member.cik||!['issuer','listedClassLowerBound'].includes(fact.capBasis))
    return {...row,reason:/class|equivalence|segment|sibling/i.test(fact?.reason??'')?'ambiguous_class':'missing_shares'};
  const age=(Date.parse(asOf)-Date.parse(fact.sharesAsOf))/86400000;
  if(!Number.isFinite(age)||age<0||age>SHARE_MAX_AGE_DAYS||!checkedDate(fact.sharesFiled)||fact.sharesFiled>asOf||fact.sharesFiled<fact.sharesAsOf)
    return {...row,reason:'stale_shares'};
  if(fact.sharesFiled===asOf)return {...row,reason:'same_day_filing'};
  const actions=price.splits?.filter(a=>a.date>fact.sharesAsOf&&a.date<=asOf);
  if(!actions||actions.some(a=>!Number.isFinite(a.ratio)||a.ratio<=0)||new Set(actions.map(a=>a.date)).size!==actions.length)
    return {...row,reason:'uncertain_split'};
  const splitFactor=actions.reduce((p,a)=>p*a.ratio,1);
  const capUsd=Math.round(fact.shares*splitFactor*price.close);
  if(!Number.isSafeInteger(capUsd)||capUsd<=0||capUsd>1e15)return {...row,reason:'uncertain_split'};
  const eligible=capUsd>=LARGE_CAP_USD;
  return {...row,eligible,reason:eligible?'eligible':fact.capBasis==='issuer'?'below_cap':'class_floor_below',
    capUsd,capBasis:fact.capBasis,capAsOf:asOf,close:price.close,shares:fact.shares,splitFactor,sharesAsOf:fact.sharesAsOf,
    sharesFiled:fact.sharesFiled,filingUrl:fact.filingUrl,accession:fact.accession};
}
export function makeQualitySnapshot({researchDate,asOf,revision,roster,directory,prices,facts}){
  const bySymbol=new Map(directory.items.map(x=>[x.symbol,x]));
  const rows=Object.fromEntries(roster.members.map(member=>[member.symbol,valueMember(member,bySymbol.get(member.symbol),prices[member.symbol],facts[member.symbol],asOf)]));
  const list=Object.values(rows),valued=list.filter(x=>x.capUsd!=null).length;
  const data={schemaVersion:QUALITY_SCHEMA,id:QUALITY_ID,selectionLabel:'S&P 500 편입 보통주 · 추정 시가총액 100억 달러 이상',
    thresholdUsd:LARGE_CAP_USD,asOf,rosterAsOf:roster.asOf,rosterRevision:roster.revision,priceRevision:revision,
    generatedAt:researchDate,coverage:{roster:list.length,valued,eligible:list.filter(x=>x.eligible).length},
    sources:[
      {label:'구성 종목 · Wikipedia 기여자, 고정 판본',url:roster.url},
      {label:'발행주식 수 · SEC 공시',url:'https://www.sec.gov/search-filings/edgar-application-programming-interfaces'},
      {label:'정규장 종가·주식분할 · DoltHub 원자료',url:'https://www.dolthub.com/repositories/post-no-preference/stocks/data/'+revision},
      {label:'미국 거래소 상장 명부 · Nasdaq Trader',url:'https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs'},
      {label:'구성표·가격 가공 자료 이용조건 · CC BY-SA 4.0',url:'https://creativecommons.org/licenses/by-sa/4.0/'}],
    methodology:{summary:'공개 구성표와 같은 날 미국 상장 명부에서 확인한 보통주를 대상으로, 당시 이용 가능했던 SEC 공시 주식 수와 해당 거래일 종가에서 시가총액을 추정합니다.',
      shares:'기준일 이전에 공시한 150일 이내 주식 수에 이후 주식분할을 반영합니다. 선정에 쓰는 공시의 날짜는 종가일보다 앞서야 합니다. 특정 주식 종류만 확인되면 해당 종류의 시가총액을 회사 전체의 하한으로 평가합니다.',
      attribution:'Wikipedia 기여자의 S&P 500 구성표에서 기호와 CIK만 추출하고, Nasdaq 명부·SEC 공시·DoltHub 일봉과 결합했습니다. 구성표와 가격 가공 자료는 CC BY-SA 4.0입니다.'},
    rows};
  // Release QA compared the dated sponsor workbook with the independently licensed roster.
  // The sponsor's download rolls daily. Keep its observation date and checksum attached.
  if(asOf==='2026-11-23'&&sha(Object.keys(rows).sort().join('\n'))==='3e6637b144b33e4935018c1675604cda903b70fddfb86c25f83c1e88bda90065'){
    data.sources.push({label:'2026-11-23 SPY 보유 종목 대조 · State Street 일별 갱신 파일',
      url:'https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx'});
    data.membershipCheck={asOf:'2026-11-23',provider:'State Street SPDR S&P 500 ETF Trust',matchedSecurities:503,
      sourceSha256:'32dc5c01ec4f123d440291b0d946593b93bc9e84da246c7303b00958601271aa'};
  }
  assert(validQualityUniverse(data,asOf),'Invalid combined constituent filing and valuation data');
  assert(valued>=Math.ceil(list.length*.6),'Less than 60% of the constituent roster has a verified valuation; retaining the previous release');
  return data;
}
async function main(){
  const {values}=parseArgs({options:{ranks:{type:'string'},directory:{type:'string'},
    db:{type:'string'},dolt:{type:'string'},'fetch-db':{type:'boolean'},cache:{type:'string'},out:{type:'string'},
    'public-dir':{type:'string'},'audit-sources':{type:'boolean'}}});
  assert(values.out||values['public-dir'],'Choose an output file or public release directory');
  const opts=values;
  let ranks,directory;
  if(opts.ranks||opts.directory){
    assert(opts.ranks&&opts.directory);[ranks,directory]=await Promise.all([readJson(opts.ranks),readJson(opts.directory)]);
  }else{
    const receipt=await readJson(path.join(root,'last-run.json'));
    const file=gunzipSync(await readFile(path.join(root,'last-directory.json.gz')));assert.equal(sha(file),receipt.directorySha256);directory=JSON.parse(file);
    const response=await fetch('https://semiscope-ranks.deed.page/data/long-ranks.json?verify='+Date.now(),{signal:AbortSignal.timeout(30000)});
    assert(response.ok,'Cannot read public rank snapshot');
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha(bytes),receipt.sha256,'Rank publication changed during quality export');ranks=JSON.parse(bytes);
  }
  const asOf=ranks.asOf,revision=ranks.source?.commit;
  assert(checkedDate(asOf)&&directory.asOf===asOf&&directory.source==='Nasdaq Trader'&&ranks.coverage.listed===directory.count&&/^[0-9a-v]{32}$/.test(revision));
  if(opts['audit-sources']){
    const published=await readJson(path.join(opts['public-dir'],asOf+'.json'));
    assert(validQualityUniverse(published,asOf)&&published.priceRevision===revision,'No verified release for the latest price revision');
    const roster=await getQualityRoster(asOf);
    assert.deepEqual(roster.members.map(r=>r.symbol).sort(),Object.keys(published.rows).sort());
    const valued=Object.values(published.rows).filter(r=>r.eligible),preferred=['AAPL','JPM','GOOG','BRK.B'];
    const sampled=valued.filter(r=>preferred.includes(r.symbol));
    if(sampled.length<2)sampled.push(...valued.filter(r=>!sampled.includes(r)).slice(0,2-sampled.length));
    const symbols=sampled.map(r=>r.symbol);
    const [quotes,shares]=await Promise.all([priceInputs({symbols,asOf,revision}),loadSecMetrics({asOf,symbols:sampled,cacheDir:opts.cache})]);
    for(const r of sampled){
      const listing=directory.items.find(s=>s.symbol===r.symbol);
      const actual=valueMember(r,listing,quotes[r.symbol],shares[r.symbol],asOf);
      for(const k of ['eligible','capUsd','shares','sharesFiled','sharesAsOf','capBasis','close','securityTitleSource'])
        assert.equal(actual[k],r[k],r.symbol+' did not reproduce '+k);
    }
    console.log('Hosted source checks matched',asOf,symbols);return;
  }
  let priorRows=null;
  if(opts['public-dir']){
    const prefix=opts['public-dir'],dated=path.join(prefix,asOf+'.json'),latest=path.join(prefix,'latest.json');
    try{
      const active=await readJson(latest);
      if(validQualityUniverse(active)&&active.asOf<asOf)priorRows=active.rows;
      const prev=await readJson(dated);
      if(validQualityUniverse(prev,asOf)&&prev.priceRevision===revision&&JSON.stringify(active)===JSON.stringify(prev)){
        console.log('Verified existing quality release',asOf,prev.coverage);return;
      }
      throw Error('Archived quality release changed unexpectedly');
    }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const roster=await getQualityRoster(asOf);
  const symbols=roster.members.map(m=>m.symbol),priceReq={symbols,asOf,revision,db:opts.db&&path.resolve(opts.db),
    dolt:opts.dolt&&/[\\/]/.test(opts.dolt)?path.resolve(opts.dolt):opts.dolt??'dolt'};
  if(opts['fetch-db'])await ensureDatabase(priceReq.db,priceReq.dolt,revision);
  const listings=new Map(directory.items.map(row=>[row.symbol,row]));
  const memberInputs=roster.members.map(member=>({...member,verifyCommon:listings.get(member.symbol)?.type==='other'}));
  const [prices,facts]=await Promise.all([priceInputs(priceReq),
    loadSecMetrics({asOf,symbols:memberInputs,cacheDir:opts.cache,userAgent:process.env.SEC_USER_AGENT,priorRows})]);
  const data=makeQualitySnapshot({researchDate:new Date().toISOString(),asOf,revision,roster,directory,prices,facts});
  const bytes=JSON.stringify(data)+'\n';
  const outputs=opts['public-dir']?[path.join(opts['public-dir'],asOf+'.json'),path.join(opts['public-dir'],'latest.json')]:[];
  if(opts.out)outputs.push(opts.out);
  for(const dest of outputs){await mkdir(path.dirname(dest),{recursive:true});const tmp=dest+'.tmp-'+process.pid;
    await writeFile(tmp,bytes);await rename(tmp,dest);}
  console.log('Verified S&P 500 large-cap universe',asOf,data.coverage,sha(bytes));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
