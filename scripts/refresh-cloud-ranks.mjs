// Node 22+, tar and Dolt on PATH. The ranked market data has its own publishing key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {readFileSync} from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import {UNIFIED_MIN_BARS,UNIFIED_VERSION,decodeUnifiedResult,encodeUnifiedResult} from '../src/unified-index.mjs';
import {assessUnifiedListing} from '../src/unified-eligibility.mjs';

const {values} = parseArgs({options:{
  'verify-current':{type:'boolean',default:false},
  'migrate-unified':{type:'boolean',default:false},
  'review-unified-candidate':{type:'string'},
  'check-packets-file':{type:'string'},
  'expected-content-sha256':{type:'string'},
}});
const verifyCurrent = values['verify-current'];
const migrateUnified = values['migrate-unified'];
const reviewFile = values['review-unified-candidate'];
const packetFile=values['check-packets-file'];
assert([verifyCurrent,migrateUnified,Boolean(reviewFile),Boolean(packetFile)].filter(Boolean).length <= 1,'Choose one release mode');
if(migrateUnified)assert.match(values['expected-content-sha256']||'',/^[a-f0-9]{64}$/,'Pass the verified content SHA-256 from the independent candidate review');
const release={
  baselineSiteVersion:6,
  baselineSha256:'e127513f82f1a540a5a8d64dda9dfc6c28370adc70d7fa05d5104acaaeb0cf3c',
  directorySha256:'ed59ae0c13a1e81863ade4eab2a1b244722e762b303af5acfc8a3f6fc4f5eba2',
  asOf:'2026-11-23',sourceCommit:'njs8j85h7atjqje4ldfu4c4lillpka3t',
  previousBuild:'rank-market-4.0',previousModel:'bottom-probability-2.0',previousTarget:'capped-40-v1',nextBuild:'rank-market-5.0',
  nextModel:'long-entry-index-3.0',
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.resolve(process.env.RANK_CACHE_DIR || path.join(tmpdir(),'semiscope-rank-cache'));
const slug = 'semiscope-ranks';
const endpoint = 'https://deed.page/v1/sites/' + slug;
const origin = 'https://' + slug + '.deed.page';
const rankPath = 'data/long-ranks.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const userAgent = 'Semiscope rank publisher';
const directoryHistory=path.join(root,'pending-directories');
const archiveName=/^(\d{4}-\d{2}-\d{2})\.([a-f0-9]{64})\.json\.gz$/;
const directoryURLs=['nasdaqlisted.txt','otherlisted.txt'].map(file=>'https://www.nasdaqtrader.com/dynamic/SymDir/'+file);

function verifiedModelSourceHash() {
  const files=new Map(),queue=['src/unified-index.mjs','src/unified-eligibility.mjs'];
  while(queue.length) {
    const name=queue.pop();if(files.has(name))continue;
    assert(name.startsWith('src/')&&!path.isAbsolute(name),'Unexpected model source path');
    const code=readFileSync(path.join(root,name),'utf8').replaceAll('\r\n','\n');
    files.set(name,code);
    if(!name.endsWith('.json'))for(const match of code.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+\.(?:mjs|js|json))['"]/g))
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1])));
  }
  return sha256(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b,'en'))));
}
const expectedModelHash=verifiedModelSourceHash();

function day(value) {
  assert.equal(typeof value,'string','Date missing');
  assert.match(value,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(value + 'T00:00:00Z').toISOString().slice(0,10),value,'Invalid date');
  return value;
}

function checkDirectory(data,date) {
  assert.equal(data.source,'Nasdaq Trader');
  assert.equal(data.sourceMode,'directory','A provider fallback cannot become a historical roster');
  assert.equal(day(data.asOf),day(date));
  assert(Array.isArray(data.items) && data.items.length>=1000 && data.count===data.items.length);
  assert.equal(new Set(data.items.map(item=>item.symbol)).size,data.count,'Duplicate directory symbols');
  assert.equal(data.sources?.length,2);
  for(const url of directoryURLs){
    const s=data.sources.find(item=>item.url===url);
    assert(s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.createdAtET) && s.createdAtET.slice(0,10)===date,'Unverified source directory date');
  }
}

async function archivedDirectories(dir) {
  const names=await readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return names.filter(name=>archiveName.test(name)).sort();
}

async function readDirectoryArchive(dir,name) {
  const [,date,digest]=archiveName.exec(name);
  const bytes=gunzipSync(await readFile(path.join(dir,name)),{maxOutputLength:8*1024*1024});
  assert.equal(sha256(bytes),digest,'Archived listing bytes do not match their digest');
  const data=JSON.parse(bytes);
  checkDirectory(data,date);
  return {bytes,data};
}

async function rememberDirectory(bytes,dir=directoryHistory) {
  const data=JSON.parse(bytes),date=day(data.asOf);
  checkDirectory(data,date);
  await mkdir(dir,{recursive:true});
  const names=await archivedDirectories(dir);
  const sameDate=names.filter(name=>name.startsWith(date+'.'));
  assert(sameDate.length<=1,'Ambiguous archived listing directory for '+date);
  let selected=bytes;
  if(sameDate.length){
    const prior=await readDirectoryArchive(dir,sameDate[0]);
    const revisions=data.sources.map(s=>s.createdAtET.localeCompare(prior.data.sources.find(old=>old.url===s.url).createdAtET));
    // Ignore a later retrieval timestamp if the exchange has not issued new
    // files. Never replace a verified roster with an older source revision.
    if(revisions.some(value=>value<0) || revisions.every(value=>value===0))selected=prior.bytes;
  }
  const name=date+'.'+sha256(selected)+'.json.gz';
  if(!names.includes(name)){
    const dest=path.join(dir,name),staged=dest+'.tmp-'+process.pid;
    await writeFile(staged,gzipSync(selected,{level:9}));
    await rename(staged,dest);
  }
  const latest=[...new Set([...names.map(f=>f.slice(0,10)),date])].sort().slice(-8);
  for(const prior of new Set([...names,name])){
    if((prior.startsWith(date+'.') && prior!==name) || !latest.includes(prior.slice(0,10)))await rm(path.join(dir,prior));
  }
  return selected;
}

async function directoryForDate(date,dir=directoryHistory) {
  const found=(await archivedDirectories(dir)).filter(name=>name.startsWith(day(date)+'.'));
  assert(found.length<=1,'Ambiguous archived listing directory');
  return found.length?(await readDirectoryArchive(dir,found[0])).bytes:null;
}

function execute(program, args, {allowPriceLag=false}={}) {
  const env = {...process.env};
  delete env.RANK_PUBLISH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return new Promise((resolve,reject) => {
    const child = spawn(program,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
    child.once('error',reject);
    child.once('exit',(code,signal) => {
      if (code === 0 || (allowPriceLag && code === 75)) resolve(code);
      else reject(new Error(path.basename(program) + ' stopped (' + (signal || code) + ')'));
    });
  });
}

async function get(url) {
  const response = await fetch(url,{
    headers:{'User-Agent':userAgent, 'Cache-Control':'no-cache'},
    redirect:'error',signal:AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error('Public rank read failed, HTTP ' + response.status);
  return response;
}

async function manifest(version) {
  const address = version ? endpoint + '/versions/' + version + '/manifest' : endpoint + '/manifest';
  const reply = await (await get(address + '?verify=' + Date.now())).json();
  const m = reply.manifest;
  assert(reply.ok && m?.slug === slug && Number.isSafeInteger(m.version) && m.version > 0,'Unexpected site manifest');
  assert(Array.isArray(m.files) && m.files.some(f => f.path === 'index.html'),'Public site index missing');
  assert.equal(m.files.filter(f => f.path === rankPath).length,1,'Public ranking file missing or duplicated');
  return m;
}

function rankDigest(m) {
  const digest = m.files.find(f => f.path === rankPath).sha256;
  assert.match(digest,/^[a-f0-9]{64}$/);
  return digest;
}

async function readPublished(m) {
  const expected = rankDigest(m);
  for (let attempt=0; attempt<5; attempt++) {
    const response = await get(origin + '/' + rankPath + '?v=' + m.version + '&verify=' + Date.now());
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) === expected) return JSON.parse(bytes.toString('utf8'));
    if (attempt<4) await pause(1000*(attempt+1));
  }
  throw new Error('CDN rank bytes do not match the published manifest');
}

async function stageDirectory(dataDir,previous,current) {
  await mkdir(dataDir,{recursive:true});
  const destination=path.join(dataDir,'us-listings.json');
  if(migrateUnified || verifyCurrent || reviewFile){
    // Reproduction requires the exact listing cohort and Dolt revision, even
    // when Nasdaq has advanced to another trading day or changed a security.
    let bytes,digest;
    if(previous.asOf===release.asOf && previous.source.commit===release.sourceCommit){
      digest=release.directorySha256;
      const archived=await readFile(path.join(root,'last-directory.json.gz')).catch(error=>{
        if(error.code==='ENOENT')return null;
        throw error;
      });
      if(archived)bytes=gunzipSync(archived);
      else {
        const response=await get('https://semiscope.deed.page/data/us-listings.json?verify='+Date.now());
        bytes=Buffer.from(await response.arrayBuffer());
      }
    }else {
      const receipt=JSON.parse(await readFile(path.join(root,'last-run.json'),'utf8'));
      assert.equal(receipt.asOf,previous.asOf,'Recorded directory belongs to another date');
      assert.equal(receipt.sourceCommit,previous.source.commit,'Recorded directory belongs to another price revision');
      assert.equal(receipt.sha256,rankDigest(current),'Recorded directory belongs to another publication');
      digest=receipt.directorySha256;
      assert.match(digest,/^[a-f0-9]{64}$/,'No archived directory digest');
      bytes=gunzipSync(await readFile(path.join(root,'last-directory.json.gz')));
    }
    assert.equal(sha256(bytes),digest,'Archived Nasdaq directory digest mismatch');
    const data=JSON.parse(bytes);
    assert.equal(data.asOf,previous.asOf);
    assert.equal(data.count,previous.coverage.listed);
    await writeFile(destination,bytes);
    return {data,held:false};
  }
  try {
    const pull=()=>execute(process.execPath,[path.join(root,'scripts','prepare-rank-catalog.mjs'),dataDir]);
    try { await pull(); }
    catch { await pause(1200); await pull(); }
    return {data:JSON.parse(await readFile(destination,'utf8')),held:false};
  } catch {
    // The deployed Nasdaq reader uses a second network location; it states
    // whether it fetched the exchange directories or returned a stored snapshot.
    const response=await get('https://semiscope-market-observatory.jennylink63.chatgpt.site/api/universe?verify='+Date.now());
    const data=await response.json();
    assert.equal(data.source,'Nasdaq Trader');
    assert(data.sourceMode==='directory' || data.sourceMode==='snapshot');
    day(data.asOf);
    assert(Array.isArray(data.items)&&Number.isSafeInteger(data.count)&&data.count===data.items.length);
    assert(Array.isArray(data.sources)&&data.sources.length===2&&data.sources.every(s=>s.createdAtET?.slice(0,10)===data.asOf));
    if(data.sourceMode==='snapshot'){
      // A stale directory must not trigger a new publication or a "current" claim.
      return {data:previous,held:true};
    }
    await writeFile(destination,JSON.stringify(data));
    return {data,held:false};
  }
}

const horizons=[126,252];
const horizonKeys=horizons.map(String);
const integerCount=n=>Number.isSafeInteger(n)&&n>=0;
const symbolOrder=(a,b)=>a.localeCompare(b,'en');
const summaryCounts=data=>data.horizons?.map(h=>h+'d '+data.coverage.byHorizon[h].scored).join(', ')??String(data.unifiedCoverage?.scored??data.coverage.scored);
const dualKeys=value=>assert.deepEqual(Object.keys(value??{}).sort(),horizonKeys);

function scoreFromPacket(packet,row,horizon) {
  assert(Array.isArray(packet),'Missing complete entry-index packet for '+row.symbol);
  const index=decodeUnifiedResult(packet,row.asOf,horizon);
  assert(index,'Invalid horizon-specific entry index for '+row.symbol);
  assert.equal(index.version,release.nextModel);
  assert.equal(index.horizon,horizon);
  assert.equal(index.date,row.asOf);
  assert.equal(index.entryQualified,index.phase==='response'&&index.score>=80,'Index signal disagrees with its published phase');
  assert.deepEqual(encodeUnifiedResult(index,horizon),packet,'Noncanonical index packet for '+row.symbol);
  return index.score;
}

function checkSnapshot(snapshot) {
  day(snapshot.asOf);
  assert.equal(snapshot.schemaVersion,2,'Expected the standalone two-horizon release');
  assert.equal(snapshot.buildVersion,release.nextBuild,'Unreviewed ranking generation');
  assert.equal(snapshot.modelVersion,release.nextModel,'Wrong entry-index model version');
  assert.equal(UNIFIED_VERSION,release.nextModel,'The validator and calculation code use different models');
  assert.equal(snapshot.minimumSessions,UNIFIED_MIN_BARS,'Unexpected model warmup');
  assert.equal(snapshot.modelSourceSha256,expectedModelHash,'Index or eligible-cohort calculation code differs from the fixture');
  for(const retired of ['unifiedModelVersion','unifiedOnlyRows','unifiedCalibration','timingModelVersion'])
    assert(!Object.hasOwn(snapshot,retired),'Obsolete generation metadata in the dual-index schema');
  assert.deepEqual(snapshot.horizons,horizons);
  assert.equal(snapshot.source?.license,'CC BY-SA 4.0');
  assert.match(snapshot.source?.commit || '',/^[0-9a-v]{32}$/);
  assert.equal(snapshot.listingSource,'Nasdaq Trader');
  const {listed,eligible,byHorizon}=snapshot.coverage;
  assert(integerCount(listed)&&integerCount(eligible)&&eligible>0&&eligible<=listed);
  dualKeys(byHorizon);
  assert(Array.isArray(snapshot.rows)&&snapshot.rows.length<=eligible);
  const scored=new Map();
  for(const row of snapshot.rows) {
    assert(typeof row.symbol==='string'&&row.symbol.trim()&&!scored.has(row.symbol),'Duplicate listing');
    assert.equal(row.asOf,snapshot.asOf,'An index has the wrong trading date');
    for(const retired of ['unified','timing','score252','score504'])assert(!Object.hasOwn(row,retired),'Obsolete rank field in '+row.symbol);
    assert(Number.isSafeInteger(row.nBars)&&row.nBars>=UNIFIED_MIN_BARS&&row.nBars<=UNIFIED_MIN_BARS+1,'Unexpected input observation count');
    dualKeys(row.indices);dualKeys(row.ranks);
    assert(horizons.every(h=>Array.isArray(row.indices[h])),'Both complete indices are required for '+row.symbol);
    assert(decodeUnifiedResult(row.indices,row.asOf),'The two horizons use inconsistent common inputs for '+row.symbol);
    scored.set(row.symbol,row);
  }
  const symbols=[...scored.keys()];
  assert.deepEqual(symbols,[...symbols].sort(symbolOrder),'Rows are not sorted by symbol');
  const exclusions=Object.entries(snapshot.excludedBySymbol);
  for(const [symbol,reasons] of exclusions) {
    const keys=Object.keys(reasons);
    assert(symbol&&keys.length&&keys.every(k=>horizonKeys.includes(k)),'Invalid symbol exclusion');
    for(const h of keys) {
      const reason=reasons[h];
      assert(reason!=='unsupported_structure'&&Object.hasOwn(byHorizon[h].excluded,reason),'Unknown per-symbol exclusion');
      assert(scored.get(symbol)?.indices[h]==null,'An evaluated index is also excluded');
    }
  }
  const represented=new Set([...symbols,...exclusions.map(([s])=>s)]);
  assert.equal(represented.size,eligible,'Eligible listing count differs from the rows and exclusions');
  for(const h of horizons) {
    const summary=byHorizon[h],ranked=[],omitted={};
    assert(integerCount(summary.scored)&&summary.scored>0&&summary.scored<=eligible);
    assert(integerCount(summary.atLeast80)&&summary.atLeast80<=summary.scored);
    assert.equal(summary.excluded.unsupported_structure,listed-eligible);
    for(const symbol of represented) {
      const row=scored.get(symbol),reason=snapshot.excludedBySymbol[symbol]?.[h];
      if(row?.indices[h]==null) {
        assert(typeof reason==='string'&&reason,'Missing reason for '+symbol+' at '+h);
        if(row)assert.equal(row.ranks[h],null);
        omitted[reason]=(omitted[reason]??0)+1;
        continue;
      }
      assert.equal(reason,undefined);
      const score=scoreFromPacket(row.indices[h],row,h);
      assert(Number.isInteger(score)&&score>=0&&score<=100,'Invalid long-term index');
      ranked.push({score,rank:row.ranks[h]});
    }
    assert.equal(ranked.length,summary.scored);
    assert.equal(ranked.filter(r=>r.score>=80).length,summary.atLeast80,'Incorrect inclusive 80-point count');
    for(const [reason,count] of Object.entries(summary.excluded)) {
      assert(integerCount(count)&&typeof snapshot.reasonLabels[reason]==='string','Invalid exclusion summary');
      if(reason!=='unsupported_structure')assert.equal(count,omitted[reason]??0,'Incorrect count for '+reason);
    }
    assert.equal(summary.scored+Object.values(summary.excluded).reduce((a,b)=>a+b,0),listed);
    ranked.sort((a,b)=>b.score-a.score);
    let rank=0;
    for(const [i,r] of ranked.entries()) {
      if(i===0||ranked[i-1].score!==r.score)rank=i+1;
      assert.equal(r.rank,rank,'Incorrect '+h+'-session competition rank');
    }
  }
}

function checkCohort(snapshot,directory) {
  checkDirectory(directory,snapshot.asOf);
  assert.equal(directory.count,snapshot.coverage.listed);
  const eligible=new Map(directory.items.filter(item=>assessUnifiedListing(item).eligible).map(item=>[item.symbol,item]));
  assert.equal(eligible.size,snapshot.coverage.eligible);
  for(const row of snapshot.rows) {
    const identified=eligible.get(row.symbol);
    assert(identified,'Ranked issue missing from the eligible official listing cohort');
    for(const key of ['name','type','exchange'])assert.equal(row[key],identified[key],'Nasdaq identity mismatch for '+row.symbol);
    assert.equal(row.providerSymbol,identified.providerSymbol??identified.symbol,'Provider symbol mismatch for '+row.symbol);
  }
  for(const symbol of Object.keys(snapshot.excludedBySymbol))assert(eligible.has(symbol),'Invalid eligible exclusion '+symbol);
}

function migrationBaseline(previous,current) {
  assert.equal(current.version,release.baselineSiteVersion,'Migration baseline site version changed');
  assert.equal(rankDigest(current),release.baselineSha256,'Migration baseline bytes changed');
  assert.equal(previous.buildVersion,release.previousBuild);
  assert.equal(previous.unifiedModelVersion,release.previousModel);
  assert.equal(previous.unifiedTargetId,release.previousTarget);
  assert.equal(previous.asOf,release.asOf);
  assert.equal(previous.source.commit,release.sourceCommit);
}

function compareMigration(next,previous,current) {
  migrationBaseline(previous,current);
  checkSnapshot(next);
  assert.equal(next.asOf,previous.asOf);
  assert.equal(next.listingSource,previous.listingSource);
  assert.equal(next.coverage.listed,previous.unifiedCoverage.listed);
  const priorIssues=new Set([...previous.rows,...previous.unifiedOnlyRows].filter(r=>r.unified!=null)
    .map(r=>r.symbol).concat(Object.keys(previous.unifiedExcludedBySymbol)));
  assert.equal(priorIssues.size,previous.unifiedCoverage.eligible);
  const nextIssues=new Set(next.rows.map(r=>r.symbol).concat(Object.keys(next.excludedBySymbol)));
  assert.deepEqual(nextIssues,priorIssues,'The model migration changed the eligible issue cohort');
  for(const key of ['name','url','license','licenseUrl','commit','actionThrough'])assert.equal(next.source[key],previous.source[key]);
}

function compareCandidate(next,previous,date) {
  checkSnapshot(next);
  assert.equal(next.asOf,date,'Latest directory and price dates differ');
  assert(next.asOf>=previous.asOf,'Ranking date regression');
  for(const key of ['schemaVersion','modelVersion','buildVersion','minimumSessions','modelSourceSha256'])assert.equal(next[key],previous[key]);
  assert.deepEqual(next.horizons,previous.horizons);
  assert(next.coverage.listed>=.90*previous.coverage.listed,'Unexpected loss of exchange coverage');
  for(const h of horizons)assert(next.coverage.byHorizon[h].scored>=.85*previous.coverage.byHorizon[h].scored,'Unexpected loss of verified '+h+'-session histories');
  if(next.asOf===previous.asOf) {
    assert(verifyCurrent,'Same-day publication requires --verify-current');
    const {generatedAt:now,...a}=next,{generatedAt:before,...b}=previous;
    assert(isDeepStrictEqual(a,b),'Same-date cloud recalculation differs from the public baseline');
  }
}

function unchangedAssets(m) {
  return m.files.filter(f => f.path!==rankPath).map(f => [f.path,f.sha256]).sort(([a],[b])=>a.localeCompare(b));
}

async function publish(stage, previous, digest) {
  const token = process.env.RANK_PUBLISH_TOKEN;
  if (!token) throw new Error('RANK_PUBLISH_TOKEN is required for a rank-only publication');
  const archive = path.join(stage,'rank.tar.gz');
  await execute('tar',['-czf',archive,'-C',stage,rankPath]);
  const response = await fetch(endpoint,{
    method:'PUT',redirect:'error',signal:AbortSignal.timeout(120000),
    headers:{Authorization:'Bearer '+token,'X-Client':'Semiscope','Content-Type':'application/gzip',
      'X-Merge':'1','If-Match':'"v'+previous.version+'"'},
    body:await readFile(archive),
  });
  if (!response.ok) throw new Error('Conditional rank-only publication failed, HTTP '+response.status);
  const result = await response.json();
  assert(result.ok && result.url?.replace(/\/$/,'')===origin && /^v\d+$/.test(result.version),'Unexpected publication acknowledgment');
  const saved = await manifest(result.version);
  assert.equal(result.version,'v'+saved.version);
  assert(saved.version > previous.version && rankDigest(saved)===digest,'Published rank version failed verification');
  assert.deepEqual(unchangedAssets(saved),unchangedAssets(previous),'A non-ranking file changed');
  const latest = await manifest();
  assert.equal(latest.version,saved.version,'Another release superseded this run before confirmation');
  assert.equal(rankDigest(latest),digest);
  await readPublished(latest);
  return latest;
}

async function report(state, m, data, directoryFile, observation={}) {
  const proof = {state,checkedAt:new Date().toISOString(),asOf:data.asOf,version:'v'+m.version,
    sha256:rankDigest(m),buildVersion:data.buildVersion,modelVersion:data.modelVersion,coverage:data.coverage,sourceCommit:data.source.commit,...observation};
  if(data.horizons){proof.horizons=data.horizons;proof.modelSourceSha256=data.modelSourceSha256;proof.minimumSessions=data.minimumSessions;}
  if(data.unifiedCoverage)proof.unifiedCoverage=data.unifiedCoverage;
  if(data.unifiedModelVersion)proof.unifiedModelVersion=data.unifiedModelVersion;
  if(data.unifiedTargetId)proof.unifiedTargetId=data.unifiedTargetId;
  if(data.unifiedCalibration)proof.unifiedCalibration=data.unifiedCalibration;
  const target = path.join(root,'last-run.json'), temporary = target+'.tmp-'+process.pid;
  if(directoryFile){
    const bytes=await readFile(directoryFile);
    proof.directorySha256=sha256(bytes);
    const compressed=path.join(root,'last-directory.json.gz'),staged=compressed+'.tmp-'+process.pid;
    await writeFile(staged,gzipSync(bytes,{level:9}));
    await rename(staged,compressed);
  }else {
    const prior=await readFile(target,'utf8').then(JSON.parse).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(prior?.sha256===proof.sha256 && prior.sourceCommit===proof.sourceCommit && prior.directorySha256)
      proof.directorySha256=prior.directorySha256;
  }
  await writeFile(temporary,JSON.stringify(proof,null,2)+'\n');
  await rename(temporary,target);
  console.log(state,proof.asOf,proof.version,summaryCounts(data)+' scored',proof.sha256);
}

const contentDigest=data=>{
  const {generatedAt,...content}=data;
  return sha256(JSON.stringify(content));
};

async function run(stage) {
  const current = await manifest(), previous = await readPublished(current);
  // The old model uses a different packet codec. Its exact published bytes,
  // cohort and source revision are pinned rather than decoded as new scores.
  if(previous.buildVersion===release.previousBuild)migrationBaseline(previous,current);
  else checkSnapshot(previous);
  if(reviewFile){
    const candidate=JSON.parse(await readFile(path.resolve(reviewFile),'utf8'));
    compareMigration(candidate,previous,current);
    const {data:directory}=await stageDirectory(path.join(stage,'data'),previous,current);
    checkCohort(candidate,directory);
    console.log('Reviewed long-term entry indices',current.version,candidate.asOf,summaryCounts(candidate),contentDigest(candidate));
    return;
  }
  if(migrateUnified)migrationBaseline(previous,current);
  if(!migrateUnified && previous.buildVersion===release.previousBuild){
    assert(!verifyCurrent,'Reproduce the old ranking with its archived pre-migration generator');
    await report('retained-before-unified-release',current,previous);
    return;
  }
  const dataDir=path.join(stage,'data');
  const {data:catalog,held}=await stageDirectory(dataDir,previous,current);
  let date=day(catalog.asOf);
  assert(date>=previous.asOf,'Directory feed predates current public ranking');
  if(held){await report('retained-directory-unavailable',current,previous);return;}
  const replay=migrateUnified || verifyCurrent;
  const directoryFile=path.join(dataDir,'us-listings.json');
  if(!replay){
    const observed=await readFile(directoryFile),selected=await rememberDirectory(observed);
    if(!selected.equals(observed))await writeFile(directoryFile,selected);
  }
  if(!replay && date===previous.asOf){await report('current',current,previous);return;}
  const scorer=[path.join(root,'scripts','rank-market.mjs'),
    '--dolt',process.env.DOLT_EXECUTABLE || 'dolt','--db',path.join(cache,'stockdb'),
    '--cache',path.join(stage,'jobs'),'--data-dir',dataDir];
  const lagFile=path.join(stage,'lag.json');
  const code=await execute(process.execPath,[...scorer,'--update',...(replay?
    ['--revision',previous.source.commit,'--as-of',previous.asOf]:['--lag-report',lagFile])],{allowPriceLag:!replay});
  let observedSource;
  if(code===75){
    const lag=JSON.parse(await readFile(lagFile,'utf8'));
    assert.equal(lag.directoryDate,date,'Price-lag report belongs to a different roster');
    assert.match(lag.sourceCommit,/^[0-9a-v]{32}$/);
    const available=day(lag.priceDate);
    assert(available<date,'Price-lag report does not describe an earlier close');
    const observation={observedDirectoryDate:date,availablePriceDate:available,availablePriceCommit:lag.sourceCommit};
    if(available<=previous.asOf){
      await report(available===previous.asOf?'retained-price-source-behind':'retained-price-source-regressed',current,previous,null,observation);
      return;
    }
    const historical=await directoryForDate(available);
    if(!historical){
      await report('retained-matching-directory-unavailable',current,previous,null,observation);
      return;
    }
    await writeFile(directoryFile,historical);
    date=available;
    observedSource=lag.sourceCommit;
    // Re-use the already-fetched origin/master. Let the scorer independently
    // require its latest price date to equal the archived directory date.
    await execute(process.execPath,scorer);
  }
  const bytes=await readFile(path.join(stage,rankPath)),candidate=JSON.parse(bytes);
  checkCohort(candidate,JSON.parse(await readFile(directoryFile,'utf8')));
  if(observedSource)assert.equal(candidate.source?.commit,observedSource,'Price revision changed during the lagged-date calculation');
  if(migrateUnified){
    compareMigration(candidate,previous,current);
    assert.equal(contentDigest(candidate),values['expected-content-sha256'],'Independent cloud rebuild differs from reviewed unified ranking');
  }else compareCandidate(candidate,previous,date);
  const published=await publish(stage,current,sha256(bytes));
  await report(migrateUnified?'unified-release-published':verifyCurrent?'reproduced-and-published':'published',published,candidate,directoryFile);
}

export {checkSnapshot,compareMigration,compareCandidate,contentDigest,rememberDirectory,directoryForDate};
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(packetFile){
    const candidate=JSON.parse(await readFile(path.resolve(packetFile),'utf8'));
    checkSnapshot(candidate);
    console.log('Verified long-term index packets',candidate.asOf,summaryCounts(candidate),contentDigest(candidate));
  }else{
    await mkdir(cache,{recursive:true});
    const stage=await mkdtemp(path.join(cache,'run-'));
    try {await run(stage);}
    finally {await rm(stage,{recursive:true,force:true});}
  }
}
