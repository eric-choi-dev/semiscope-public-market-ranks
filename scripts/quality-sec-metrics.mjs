// Corporate facts from SEC filings. Prices and split adjustments belong to the
// caller so the trading day is identical to the ranking's verified close.
import {mkdir,readFile,writeFile,rename,open,stat,unlink} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32,inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const useForm = f=>['10-K','10-Q','10-K/A','10-Q/A'].includes(f);
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const accessionPattern=/^\d{10}-\d{2}-\d{6}$/;
const age=(asOf,date)=>(Date.parse(asOf)-Date.parse(date))/86400000;
const canon=s=>String(s).toUpperCase().replaceAll('-','.');
const cikKey=value=>/^\d{1,10}$/.test(String(value))&&Number(value)>0?String(Number(value)).padStart(10,'0'):null;
const goodDate=(asOf,date,limit)=>dayPattern.test(date)&&age(asOf,date)>=0&&age(asOf,date)<=limit;
const periodEndSort=(a,b)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed);
const accessionPage=(cik,accn)=>'https://www.sec.gov/Archives/edgar/data/'+Number(cik)+'/'+accn.replaceAll('-','')+'/'+accn+'-index.htm';
let nextCall=0;
const deniedHosts=new Map();

async function get(url,userAgent,text=false) {
  const host=new URL(url).hostname;
  for(let attempt=0;attempt<3;attempt++) {
    if((deniedHosts.get(host)??0)>=4){const e=Error('SEC temporarily declined access for '+host);e.status=403;throw e;}
    const start=Math.max(nextCall,Date.now()); nextCall=start+235;
    await delay(Math.max(0,start-Date.now()));
    const reply=await fetch(url,{headers:{'User-Agent':userAgent,Accept:text?'text/html,*/*':'application/json'},signal:AbortSignal.timeout(45000)});
    if(reply.ok){deniedHosts.delete(host);return text?reply.text():reply.json();}
    if(reply.status===403)deniedHosts.set(host,1+(deniedHosts.get(host)??0));
    if(reply.status===429||reply.status>=500){
      await reply.body?.cancel();const retry=Number(reply.headers.get('retry-after'));
      nextCall=Math.max(nextCall,Date.now()+Math.max(1500*2**attempt,Number.isFinite(retry)?retry*1000:0));continue;
    }
    await reply.body?.cancel();const error=Error('SEC HTTP '+reply.status);error.status=reply.status;throw error;
  }
  throw Error('SEC temporarily unavailable');
}

async function cached(file,fetcher) {
  try {return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const data=await fetcher(),temp=file+'.tmp-'+randomUUID();
  await writeFile(temp,JSON.stringify(data));await rename(temp,file);
  return data;
}

function lastUnique(rows) {
  const sorted=rows.toSorted(periodEndSort);
  if(!sorted.length)return null;
  const first=sorted[0];
  if(sorted.some(r=>r.end===first.end&&r.filed===first.filed&&r.val!==first.val))return null;
  return first;
}

// Each chosen row existed by the stated cutoff. Keep only the most recent
// periodic filing for share counts, so an obsolete share class cannot leak in
// from a preceding form that used a different tagging convention.
export function extractCompanyFacts(facts,asOf) {
  const base=facts.facts,query=(group,tag,unit)=>(base?.[group]?.[tag]?.units?.[unit]??[]).filter(r=>
    useForm(r.form)&&accessionPattern.test(r.accn)&&goodDate(asOf,r.filed,570)&&
    goodDate(asOf,r.end,570)&&r.filed<asOf&&r.filed>=r.end&&Number.isFinite(r.val));
  const shares=query('dei','EntityCommonStockSharesOutstanding','shares');
  const income=query('us-gaap','NetIncomeLoss','USD');
  const candidate=[...shares,...income,...query('us-gaap','Assets','USD')].filter(x=>!x.form.endsWith('/A'))
    .sort((a,b)=>b.filed.localeCompare(a.filed)||b.end.localeCompare(a.end))[0];
  const lastForm=candidate?{accn:candidate.accn,filed:candidate.filed,form:candidate.form}:null;
  const cover=lastForm?lastUnique(shares.filter(f=>f.accn===lastForm.accn&&!f.start&&f.val>0&&Number.isSafeInteger(f.val)&&goodDate(asOf,f.end,150))):null;
  const annual=lastUnique(income.filter(f=>/^10-K(?:\/A)?$/.test(f.form)&&dayPattern.test(f.start)&&
    age(f.end,f.start)>=350&&age(f.end,f.start)<=380&&goodDate(asOf,f.end,455)));
  return {cik:cikKey(facts.cik),lastForm,cover,annual};
}

const bulkUrl='https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip';
async function openBulkArchive(cacheDir,userAgent,archivePath) {
  if(archivePath)return open(archivePath,'r');
  const name=path.join(cacheDir,'companyfacts-'+new Date().toISOString().slice(0,10)+'.zip');
  try{return await open(name,'r');}catch(e){if(e.code!=='ENOENT')throw e;}
  const reply=await fetch(bulkUrl,{headers:{'User-Agent':userAgent,'Accept-Encoding':'identity'},signal:AbortSignal.timeout(600000)});
  if(!reply.ok)throw Error('SEC bulk archive HTTP '+reply.status);
  const temp=name+'.tmp-'+randomUUID();
  try {
    await pipeline(Readable.fromWeb(reply.body),createWriteStream(temp,{flags:'wx'}));
    const size=(await stat(temp)).size,expected=Number(reply.headers.get('content-length'));
    if(size<10e6||(expected&&size!==expected))throw Error('Incomplete SEC bulk archive');
    await rename(temp,name);
  }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return open(name,'r');
}
async function bytesAt(file,start,len) {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(len)||start<0||len<0||len>100*1024*1024)throw Error('Invalid SEC ZIP range');
  const buffer=Buffer.allocUnsafe(len);let pos=0;
  while(pos<len){
    const {bytesRead}=await file.read(buffer,pos,len-pos,start+pos);
    if(!bytesRead)throw Error('Truncated SEC ZIP range');
    pos+=bytesRead;
  }
  return buffer;
}
// The nightly SEC bulk file contains the same issuer JSON as the REST API.
// Read only requested entries and validate their individual checksums.
export async function bulkCompanyFacts({archive,asOf,ciks}) {
  const size=(await archive.stat()).size,tailLen=Math.min(size,65557);
  const tail=await bytesAt(archive,size-tailLen,tailLen),end=tail.lastIndexOf(Buffer.from([80,75,5,6]));
  if(end<0||end+22+tail.readUInt16LE(end+20)!==tail.length||tail.readUInt32LE(end+4)!==0)throw Error('Invalid SEC ZIP directory');
  const centralSize=tail.readUInt32LE(end+12),centralStart=tail.readUInt32LE(end+16);
  if(centralStart+centralSize>size-tailLen+end)throw Error('Unsupported SEC ZIP directory range');
  const directory=await bytesAt(archive,centralStart,centralSize),selected=new Map(),wanted=new Set(ciks);
  for(let at=0;at<directory.length;){
    if(directory.readUInt32LE(at)!==0x02014b50)throw Error('Invalid SEC ZIP entry');
    const nameSize=directory.readUInt16LE(at+28),extra=directory.readUInt16LE(at+30),comment=directory.readUInt16LE(at+32);
    const name=directory.toString('utf8',at+46,at+46+nameSize),cik=/^CIK(\d{10})\.json$/.exec(name)?.[1];
    if(wanted.has(cik)){
      if(selected.has(cik))throw Error('Duplicate SEC issuer in bulk archive');
      selected.set(cik,{name,crc:directory.readUInt32LE(at+16),offset:directory.readUInt32LE(at+42),
        compressed:directory.readUInt32LE(at+20),raw:directory.readUInt32LE(at+24),method:directory.readUInt16LE(at+10)});
    }
    at+=46+nameSize+extra+comment;
  }
  const out={};
  for(const [cik,item] of selected){
    const header=await bytesAt(archive,item.offset,30);
    if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==item.method||(header.readUInt16LE(6)&1))throw Error('Invalid SEC ZIP local entry');
    const nameLength=header.readUInt16LE(26),extra=header.readUInt16LE(28);
    const filename=(await bytesAt(archive,item.offset+30,nameLength)).toString('utf8');
    if(filename!==item.name||item.raw>80*1024*1024)throw Error('Unsupported SEC issuer ZIP entry');
    const packed=await bytesAt(archive,item.offset+30+nameLength+extra,item.compressed);
    const raw=item.method===8?inflateRawSync(packed,{maxOutputLength:Math.max(item.raw,1)}):item.method===0?packed:null;
    if(!raw||raw.length!==item.raw||crc32(raw)!==item.crc)throw Error('SEC issuer ZIP checksum mismatch');
    const facts=JSON.parse(raw);
    if(cikKey(facts.cik)!==cik)throw Error('SEC bulk issuer identity mismatch');
    out[cik]=extractCompanyFacts(facts,asOf);
  }
  return out;
}

export async function warmSecFacts({ciks,asOf,cacheDir,userAgent,archivePath=process.env.SEC_COMPANYFACTS_ZIP}) {
  if(!dayPattern.test(asOf)||!cacheDir||!userAgent)throw Error('SEC metrics need a cutoff, cache directory and identification');
  await mkdir(cacheDir,{recursive:true});
  const queue=[...new Set(ciks.map(cikKey).filter(Boolean))],records={},missing=new Set();let offset=0,unavailable=0;
  const file=cik=>path.join(cacheDir,'facts-3-'+asOf+'-'+cik+'.json');
  async function worker(){while(offset<queue.length){
    const cik=queue[offset++];
    try{
      records[cik]=await cached(file(cik),async()=>{
        if(archivePath||unavailable>=3)throw Error('Use bulk company facts');
        const data=await get('https://data.sec.gov/api/xbrl/companyfacts/CIK'+cik+'.json',userAgent);
        if(cikKey(data.cik)!==cik)throw Error('SEC issuer mismatch');
        return extractCompanyFacts(data,asOf);
      });
    }catch(e){records[cik]=null;if(e.status!==404){missing.add(cik);unavailable++;}}
  }}
  await Promise.all(Array.from({length:4},worker));
  if(missing.size){
    const archive=await openBulkArchive(cacheDir,userAgent,archivePath);
    let recovered;
    try{recovered=await bulkCompanyFacts({archive,asOf,ciks:missing});}finally{await archive.close();}
    for(const [cik,data] of Object.entries(recovered))records[cik]=await cached(file(cik),async()=>data);
  }
  return {records,failures:Object.values(records).filter(x=>!x).length};
}

function attrs(raw) {
  const entries=[...raw.matchAll(/([\w:.\-]+)\s*=\s*(["'])(.*?)\2/gs)];
  return Object.fromEntries(entries.map(m=>[m[1].toLowerCase(),m[3]]));
}
function plain(raw){return raw.replace(/<[^>]*>/g,'').replace(/(?:&nbsp;|&#160;|&#xA0;)/gi,' ').trim();}
function classContext(xml,cik) {
  const id=plain(xml.match(/<(?:\w+:)?identifier\b[^>]*>([\s\S]*?)<\/(?:\w+:)?identifier>/i)?.[1]??'');
  if(cikKey(id)!==cik||/<(?:\w+:)?(?:typedMember|scenario)\b/i.test(xml))return null;
  const dims=[...xml.matchAll(/<(?:\w+:)?explicitMember\b([^>]*?)>([^<>]+)<\/(?:\w+:)?explicitMember>/gi)];
  // A listing can carry both the stock class and the exchange. Exchange is a
  // listing dimension, never a partition of an issuer's outstanding shares.
  const dim=dims.map(m=>({axis:attrs(m[1]).dimension,member:m[2].trim()}));
  if(dim.some(d=>d.axis==='dei:LegalEntityAxis'))return {relatedEntity:true};
  if(new Set(dim.map(d=>d.axis)).size!==dim.length||dim.some(d=>!['dei:EntityListingsExchangeAxis','us-gaap:StatementClassOfStockAxis'].includes(d.axis)))return null;
  return {member:dim.find(d=>d.axis==='us-gaap:StatementClassOfStockAxis')?.member??'',exchange:dim.some(d=>d.axis==='dei:EntityListingsExchangeAxis'),
    date:xml.match(/<(?:\w+:)?instant>(\d{4}-\d{2}-\d{2})<\//)?.[1]??null};
}
function classShares(a,raw) {
  if(a['xsi:nil']==='true'||a.sign||a.continuedat)return null;
  const token=plain(raw),scale=Number(a.scale??0);
  if(!Number.isInteger(scale)||Math.abs(scale)>12)return null;
  const standard=a.format?.split(':').at(-1)?.toLowerCase().replaceAll('-','');
  if(standard&&!['numdotdecimal','numcommadecimal'].includes(standard))return null;
  const text=standard==='numcommadecimal'?token.replaceAll('.','').replace(',','.'):token.replaceAll(',','');
  if(!/^\d+(?:\.\d+)?$/.test(text))return null;
  // Scale the decimal literally. For example, JS evaluates 256.4 * 1e6 as
  // 256399999.99999997 even though the filed value is exactly 256400000.
  const [integer,fraction='']=text.split('.'),exponent=scale-fraction.length;
  if(integer.length+fraction.length>28||exponent < -28)return null;
  const digits=BigInt(integer+fraction),power=10n**BigInt(Math.abs(exponent));
  if(exponent<0&&digits%power!==0n)return null;
  const value=Number(exponent>=0?digits*power:digits/power);
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function commonTitle(title) {
  return /\b(?:common|ordinary)\s+(?:stock|shares?)\b|\bshares?\s+of\s+(?:common|ordinary)\s+stock\b|\bcommon\s+shares?\s+of\s+beneficial\s+interest\b/i.test(title)&&
    !/\b(?:preferred|preference|depositary|depository|notes?|bonds?|warrants?|rights?|units?|receipts?|debentures?|exchangeable|convertible)\b/i.test(title);
}
function explicitlyNonCommon(title) {
  // A company may repeat its stock ticker on exchange-listed notes. These
  // cover rows are a different security type, even when the symbol matches.
  return /\b(?:notes?|bonds?|debentures?|preferred\s+(?:shares?|stock)|preference\s+shares?)\b/i.test(title);
}
function addToSet(map,key,value) {
  if(!map.has(key))map.set(key,new Set());
  map.get(key).add(value);
}
function listedTicker(raw) {
  const text=plain(raw).replace(/^(?:“|&#8220;|&#x201c;)(.*?)(?:”|&#8221;|&#x201d;)$/i,'$1')
    .replace(/^"([^"]+)"$/,'$1').replace(/\s+\((?:NYSE|NASDAQ|AMEX)\)$/i,'');
  return canon(text);
}

// A listing is identified by the Security12bTitle and TradingSymbol in the
// same issuer context. A generic issuer total is usable only with exactly one
// generic common equity listing and no separately tagged share classes.
export function extractSecurityEvidence(html,cik,asOf,filed) {
  const contexts=new Map(),shareUnits=new Set(),titlesByRef=new Map(),symbolsByRef=new Map(),observed=new Map();
  let classSharesPresent=false;
  for(const m of html.matchAll(/<(?:\w+:)?context\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?context>/gi)){
    const id=attrs(m[1]).id,ctxt=classContext(m[2],cik);
    if(id&&ctxt)contexts.set(id,ctxt);
  }
  for(const m of html.matchAll(/<(?:\w+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?unit>/gi)){
    if(/^\s*<(?:\w+:)?measure\b[^>]*>(?:xbrli:)?shares<\/(?:\w+:)?measure>\s*$/i.test(m[2]))shareUnits.add(attrs(m[1]).id);
  }
  for(const m of html.matchAll(/<ix:(nonNumeric|nonFraction)\b([^>]*\bname\s*=\s*["']dei:(?:TradingSymbol|Security12bTitle|EntityCommonStockSharesOutstanding)["'][^>]*)>([\s\S]*?)<\/ix:\1>/gi)){
    const a=attrs(m[2]),ctx=contexts.get(a.contextref);
    if(a.name==='dei:TradingSymbol')addToSet(symbolsByRef,a.contextref,listedTicker(m[3]));
    else if(a.name==='dei:Security12bTitle')addToSet(titlesByRef,a.contextref,plain(m[3]).replace(/\s+/g,' '));
    else {
      if(ctx?.relatedEntity)continue;
      if(!ctx||ctx.member)classSharesPresent=true;
      if(!ctx||ctx.exchange||!shareUnits.has(a.unitref)||!goodDate(asOf,ctx.date,150)||ctx.date>filed)continue;
      const val=classShares(a,m[3]);if(!val)continue;
      if(!observed.has(ctx.member))observed.set(ctx.member,[]);
      observed.get(ctx.member).push({val,end:ctx.date,filed});
    }
  }
  const items={},titles={},symbolRefs=new Map(),memberSymbols=new Map();
  for(const [ref,symbols] of symbolsByRef)for(const symbol of symbols)addToSet(symbolRefs,symbol,ref);
  for(const [ref,symbols] of symbolsByRef){
    const member=contexts.get(ref)?.member;
    if(member)for(const symbol of symbols)addToSet(memberSymbols,member,symbol);
  }
  const capitalClass=t=>/^class\s+[a-z0-9]+\s+capital\s+stock(?:\s*,.*)?$/i.test(t);
  const commonRefs=[...titlesByRef].filter(([,ts])=>[...ts].some(t=>commonTitle(t)||capitalClass(t)));
  for(const [symbol,allRefs] of symbolRefs){
    if(!/^[A-Z0-9.]{1,12}$/.test(symbol))continue;
    const refs=new Set([...allRefs].filter(ref=>{
      const titles=titlesByRef.get(ref);
      return titles?.size!==1||!explicitlyNonCommon([...titles][0]);
    }));
    if(!refs.size)continue;
    const ref=[...refs][0],ctx=contexts.get(ref),symbolTitles=titlesByRef.get(ref);
    if(!ctx||ctx.relatedEntity||symbolsByRef.get(ref).size!==1||symbolTitles?.size!==1)continue;
    // Dual exchange listings can repeat the same stock title and ticker under
    // separate contexts. Debentures and other stock classes cannot join them.
    if(refs.size>1&&[...refs].some(r=>!contexts.get(r)?.exchange||contexts.get(r)?.member!==ctx.member||
      symbolsByRef.get(r)?.size!==1||titlesByRef.get(r)?.size!==1||[...titlesByRef.get(r)][0]!==[...symbolTitles][0]))continue;
    const title=[...symbolTitles][0],explicitCommon=commonTitle(title);
    if(!explicitCommon&&!(ctx.member&&capitalClass(title)))continue;
    if(explicitCommon)titles[symbol]=title;
    // Some filings use an undimensioned ticker + title "Class A common stock"
    // and the standard US-GAAP CommonClassAMember on the separately dated count.
    const labels=[...title.matchAll(/\bclass\s+([A-Z0-9]+)\b/gi)].map(m=>m[1].toUpperCase());
    const member=ctx.member||(labels.length===1?'us-gaap:CommonClass'+labels[0]+'Member':'');
    if(member&&(!memberSymbols.has(member)||memberSymbols.get(member).size===1&&memberSymbols.get(member).has(symbol))){
      const count=lastUnique(observed.get(member)??[]);
      // "Class C Capital Stock" can be a common class. Accept it only when the
      // exact listing member has its own explicitly common outstanding fact.
      if(count){titles[symbol]=title;items[symbol]={...count,capBasis:'listedClassLowerBound'};continue;}
    }
    if(commonRefs.some(([other])=>!refs.has(other))||labels.length||classSharesPresent||/\b(?:series|non.?voting|subordinate|subordinated|multiple.?voting)\b/i.test(title))continue;
    const total=lastUnique(observed.get('')??[]);
    if(total)items[symbol]={...total,capBasis:'issuer'};
  }
  return {items,titles};
}

export function selectPeriodic(sub,cik,asOf) {
  if(cikKey(sub.cik)!==cik)throw Error('SEC submission issuer mismatch');
  const recent=sub.filings?.recent;
  if(!Array.isArray(recent?.accessionNumber))throw Error('SEC filing list unavailable');
  const rows=recent.accessionNumber.flatMap((accn,i)=>{
    const form=recent.form[i],filed=recent.filingDate[i],filename=recent.primaryDocument[i];
    if(!['10-K','10-Q'].includes(form)||filed>=asOf||!goodDate(asOf,filed,150)||!accessionPattern.test(accn))return [];
    return [{form,filed,accn,filename}];
  }).sort((a,b)=>b.filed.localeCompare(a.filed)||b.accn.localeCompare(a.accn));
  const row=rows[0];if(!row)return null;
  if(!/^[\w.-]+\.html?$/i.test(row.filename))throw Error('Invalid SEC filing document');
  return {...row,url:'https://www.sec.gov/Archives/edgar/data/'+Number(cik)+'/'+row.accn.replaceAll('-','')+'/'+row.filename};
}
async function latestPeriodic(cik,asOf,cacheDir,userAgent) {
  return cached(path.join(cacheDir,'periodic-'+asOf+'-'+cik+'.json'),async()=>selectPeriodic(
    await get('https://data.sec.gov/submissions/CIK'+cik+'.json',userAgent),cik,asOf));
}
async function filingClasses(cik,form,cacheDir,userAgent,tickers) {
  const fetchEvidence=async()=>({revision:6,url:form.url,...extractSecurityEvidence(await get(form.url,userAgent,true),cik,form.filed,form.filed)});
  const cachedClass=await cached(path.join(cacheDir,'classes-5-'+form.accn+'.json'),fetchEvidence);
  if(cachedClass.revision===6||tickers.every(s=>cachedClass.items[canon(s)]))return cachedClass;
  return cached(path.join(cacheDir,'classes-6-'+form.accn+'.json'),fetchEvidence);
}

export function previousCover(row,cik,symbol,form,asOf,cover){
  if(!row||row.symbol!==symbol||cikKey(row.cik)!==cik||row.verifiedCommon!==true||
    !commonTitle(row.securityTitle??'')||!Number.isSafeInteger(row.shares)||row.shares<1||
    !['listedClassLowerBound','issuer'].includes(row.capBasis)||row.sharesFiled!==form.filed||
    !goodDate(asOf,row.sharesAsOf,150)||row.sharesAsOf>form.filed||row.securityTitleSource!==row.filingUrl)return null;
  const prefix='https://www.sec.gov/Archives/edgar/data/'+Number(cik)+'/'+form.accn.replaceAll('-','')+'/';
  if(!row.filingUrl?.startsWith(prefix)||!/^[-\w.]+\.html?$/.test(row.filingUrl.slice(prefix.length)))return null;
  if(form.url&&form.url!==row.filingUrl)return null;
  if(row.capBasis==='issuer'&&cover&&(cover.val!==row.shares||cover.end!==row.sharesAsOf))return null;
  return {title:row.securityTitle,url:row.filingUrl,share:{val:row.shares,end:row.sharesAsOf,filed:form.filed,capBasis:row.capBasis}};
}
export async function loadSecMetrics({asOf,symbols,cacheDir,priorRows=[],userAgent='Semiscope public market research (https://semiscope.deed.page/)',archivePath=process.env.SEC_COMPANYFACTS_ZIP}) {
  if(!dayPattern.test(asOf)||!cacheDir||!Array.isArray(symbols))throw Error('Missing SEC metric inputs');
  await mkdir(cacheDir,{recursive:true});
  const directory=await cached(path.join(cacheDir,'ticker-exchanges-'+asOf+'.json'),
    ()=>get('https://www.sec.gov/files/company_tickers_exchange.json',userAgent));
  if(!Array.isArray(directory.data)||directory.data.length<3000)throw Error('Incomplete SEC ticker directory');
  const fields=directory.fields??[],idx=fields.indexOf('ticker'),ci=fields.indexOf('cik');
  if(idx<0||ci<0)throw Error('SEC ticker directory changed');
  const previous=new Map(Object.values(priorRows??{}).map(r=>[r.symbol,r]));
  const issuers=new Map(),output={};
  for(const record of directory.data){
    const key=canon(record[idx]),cik=cikKey(record[ci]);if(!cik)continue;
    if(!issuers.has(key))issuers.set(key,new Set());issuers.get(key).add(cik);
  }
  const inputs=symbols.map(row=>typeof row==='string'?{symbol:row}:row),byCik=new Map();
  for(const row of inputs){
    const matches=issuers.get(canon(row.symbol)),cik=matches?.size===1?[...matches][0]:null;
    if(!cik||(row.cik&&cikKey(row.cik)!==cik)){output[row.symbol]={reason:'sec_identity_unverified'};continue;}
    if(!byCik.has(cik))byCik.set(cik,[]);
    byCik.get(cik).push(row.symbol);
  }
  const {records}=await warmSecFacts({ciks:[...byCik.keys()],asOf,cacheDir,userAgent,archivePath});
  const groups=[...byCik];let index=0;
  async function worker(){while(index<groups.length){
    const [cik,tickers]=groups[index++],data=records[cik],annual=data?.annual;
    let f=null;
    try{f=await latestPeriodic(cik,asOf,cacheDir,userAgent);}catch{/* A missing filing list cannot confirm the latest known filing. */}
    const cover=f&&data?.lastForm?.accn===f.accn?data.cover:null;
    const common={cik,netIncomeAnnualUsd:annual?.val??null,netIncomeAsOf:annual?.end??null,netIncomeFiled:annual?.filed??null,
      incomeFilingUrl:annual?accessionPage(cik,annual.accn):null};
    let classes=null;const proven=new Map();
    if(f&&goodDate(asOf,f.filed,150)){
      for(const symbol of tickers){
        const old=previousCover(previous.get(symbol),cik,symbol,f,asOf,cover);
        if(old)proven.set(symbol,old);
      }
      if(proven.size!==tickers.length){
        try{classes=await filingClasses(cik,f,cacheDir,userAgent,tickers);}catch{/* Leave missing primary evidence unpriced. */}
      }
    }
    for(const symbol of tickers){
      const key=canon(symbol),prior=proven.get(symbol),share=prior?.share??classes?.items?.[key],title=prior?.title??classes?.titles?.[key];
      const url=prior?.url??classes?.url,evidence=title?{verifiedCommon:commonTitle(title),securityTitle:title,securityTitleSource:url}:{};
      if(!share||!goodDate(asOf,share.end,150)||share.capBasis==='issuer'&&cover&&(share.val!==cover.val||share.end!==cover.end)){
        output[symbol]={...common,...evidence,reason:data?'shares_unverified':'sec_facts_unavailable'};continue;
      }
      output[symbol]={...common,...evidence,shares:share.val,sharesAsOf:share.end,sharesFiled:share.filed,accession:f.accn,
        filingUrl:url,capBasis:share.capBasis};
    }
  }}
  await Promise.all(Array.from({length:3},worker));
  return output;
}
