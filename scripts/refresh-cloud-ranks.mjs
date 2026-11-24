// Node 22+, tar and Dolt on PATH. The ranked market data has its own publishing key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import {UNIFIED_VERSION,UNIFIED_MIN_BARS,decodeUnifiedResult} from '../src/unified-index.mjs';

const {values} = parseArgs({options:{
  'verify-current':{type:'boolean',default:false},
  'migrate-unified':{type:'boolean',default:false},
  'review-unified-candidate':{type:'string'},
  'expected-content-sha256':{type:'string'},
}});
const verifyCurrent = values['verify-current'];
const migrateUnified = values['migrate-unified'];
const reviewFile = values['review-unified-candidate'];
assert([verifyCurrent,migrateUnified,Boolean(reviewFile)].filter(Boolean).length <= 1,'Choose one release mode');
if(migrateUnified)assert.match(values['expected-content-sha256']||'',/^[a-f0-9]{64}$/,'Pass the verified content SHA-256 from the independent candidate review');
const release={
  baselineSiteVersion:3,
  baselineSha256:'77e65485abf6c774a3688f261347aa5d8b684b9d61a03c1e612783fa52f8804c',
  directorySha256:'b4200a0d6ea669e3238735ee3f4a495d6d7da648ed25fb5768a4882da9ebc868',
  asOf:'2026-11-20',sourceCommit:'aef7n6a07m0r9tn7nrr0gfsjpstfdhr3',
  previousBuild:'rank-market-2.0',nextBuild:'rank-market-3.0',timingModel:'bottom-timing-1.0',
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.resolve(process.env.RANK_CACHE_DIR || path.join(tmpdir(),'semiscope-rank-cache'));
const slug = 'semiscope-ranks';
const endpoint = 'https://deed.page/v1/sites/' + slug;
const origin = 'https://' + slug + '.deed.page';
const rankPath = 'data/long-ranks.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const userAgent = 'Semiscope rank publisher';

function day(value) {
  assert.equal(typeof value,'string','Date missing');
  assert.match(value,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(value + 'T00:00:00Z').toISOString().slice(0,10),value,'Invalid date');
  return value;
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
  if(migrateUnified || verifyCurrent){
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

function checkSnapshot(snapshot) {
  day(snapshot.asOf);
  assert.equal(snapshot.source?.license,'CC BY-SA 4.0');
  assert.match(snapshot.source?.commit || '',/^[0-9a-v]{32}$/);
  assert.equal(snapshot.listingSource,'Nasdaq Trader');
  assert(snapshot.modelVersion && snapshot.buildVersion && Number.isSafeInteger(snapshot.schemaVersion));
  const {listed,eligible,scored,excluded} = snapshot.coverage;
  assert([listed,eligible,scored].every(n => Number.isSafeInteger(n) && n>0));
  assert(scored <= eligible && eligible <= listed);
  assert.equal(snapshot.rows.length,scored);
  assert(Object.values(excluded).every(n => Number.isSafeInteger(n) && n>=0));
  assert.equal(scored + Object.values(excluded).reduce((sum,n) => sum+n,0),listed);
  assert.equal(eligible+excluded.unsupported_structure,listed);
  const symbols = new Set();
  const hasTiming=snapshot.timingModelVersion!==undefined;
  if(hasTiming){
    assert.equal(snapshot.timingModelVersion,release.timingModel);
    assert.deepEqual(snapshot.timingWeights,[55,30,15]);
    assert.equal(snapshot.timingCoverage?.eligible,scored);
  }
  let validTiming=0;
  for (const row of snapshot.rows) {
    assert(typeof row.symbol === 'string' && row.symbol.trim() && !symbols.has(row.symbol.toUpperCase()),'Invalid or repeated symbol');
    symbols.add(row.symbol.toUpperCase());
    assert.equal(row.asOf,snapshot.asOf,'Stale symbol date');
    assert(Number.isSafeInteger(row.nBars) && row.nBars>=snapshot.minimumSessions && row.nBars<=snapshot.maximumSessions,'Invalid observation count');
    assert(Array.isArray(row.factors) && row.factors.length === 4 && row.factors.every(n=>Number.isFinite(n)&&n>=0&&n<=100),'Invalid scoring factors');
    if(hasTiming){
      assert(Object.hasOwn(row,'timing'),'Missing entry timing field');
      if(row.timing!==null){
        const t=row.timing, bounded=n=>Number.isFinite(n)&&n>=0&&n<=100;
        assert.equal(t.date,snapshot.asOf,'Timing uses a different instrument date');
        assert(Number.isSafeInteger(t.score)&&[t.score,t.depth,t.stabilization,t.marketRisk].every(bounded),'Invalid timing scores');
        assert(Number.isFinite(t.gate)&&t.gate>=.35&&t.gate<=1,'Invalid depth gate');
        assert(Array.isArray(t.points)&&t.points.length===3&&t.points.every((n,i)=>bounded(n)&&n<=snapshot.timingWeights[i]),'Invalid timing contributions');
        assert(Math.abs(t.points.reduce((total,n)=>total+n,0)-t.score)<=.502,'Timing contributions do not sum to its rounded score');
        assert(t.inputs && Object.values(t.inputs).every(Number.isFinite),'Invalid stock-specific entry inputs');
        validTiming++;
      }
    }
  }
  for (const horizon of [252,504]) {
    const key = 'score'+horizon, ranked = 'rank'+horizon;
    const sorted = [...snapshot.rows].sort((a,b) => b[key]-a[key]);
    let rank = 0;
    for (const [i,row] of sorted.entries()) {
      assert(Number.isSafeInteger(row[key]) && row[key]>=0 && row[key]<=100,'Invalid market score');
      if (i === 0 || sorted[i-1][key] !== row[key]) rank=i+1;
      assert.equal(row[ranked],rank,'Inconsistent score rank');
    }
  }
  if(hasTiming)assert.equal(validTiming,snapshot.timingCoverage.scored);
  if(snapshot.unifiedModelVersion!==undefined || snapshot.buildVersion===release.nextBuild)checkUnified(snapshot);
}

function checkUnified(snapshot) {
  assert.equal(snapshot.buildVersion,release.nextBuild);
  assert.equal(snapshot.unifiedModelVersion,UNIFIED_VERSION);
  assert.equal(snapshot.unifiedMinimumSessions,UNIFIED_MIN_BARS);
  const {listed,eligible,scored,excluded}=snapshot.unifiedCoverage;
  assert.equal(listed,snapshot.coverage.listed);
  assert(Number.isSafeInteger(eligible) && Number.isSafeInteger(scored) && 0<scored && scored<=eligible && eligible<=listed);
  assert(Object.values(excluded).every(value=>Number.isSafeInteger(value)&&value>=0));
  assert.equal(scored+Object.values(excluded).reduce((sum,x)=>sum+x,0),listed,'Unified coverage does not reconcile to the exchange directory');
  assert.equal(eligible+excluded.unsupported_structure,listed,'Unified eligibility does not reconcile to listing structure');
  const omittedByReason={};
  for(const reason of Object.values(snapshot.unifiedExcludedBySymbol)){
    assert(Object.hasOwn(excluded,reason) && reason!=='unsupported_structure','Unknown unified quality exclusion');
    omittedByReason[reason]=(omittedByReason[reason]??0)+1;
  }
  for(const [reason,count] of Object.entries(excluded)){
    assert.equal(typeof snapshot.unifiedReasonLabels[reason],'string');
    if(reason!=='unsupported_structure')assert.equal(count,omittedByReason[reason]??0,'Incorrect count for '+reason);
  }
  assert(Array.isArray(snapshot.unifiedOnlyRows));
  assert(snapshot.unifiedOnlyRows.every(row=>row.unified!=null),'Unscored symbol in unified-only ranking');
  const all=[...snapshot.rows,...snapshot.unifiedOnlyRows];
  assert.equal(new Set(all.map(row=>row.symbol)).size,all.length,'Repeated unified symbol');
  const ranked=[];
  for(const row of all){
    assert.equal(row.asOf,snapshot.asOf);
    if(row.unified===null){
      assert.equal(row.unifiedRank,null);
      continue;
    }
    // The canonical codec rejects unknown packet versions, out-of-range raw
    // inputs, inconsistent weights/points and incorrect rounded scores.
    const score=decodeUnifiedResult(row.unified,row.asOf);
    assert(score,'Invalid unified packet for '+row.symbol);
    assert.equal(score.version,snapshot.unifiedModelVersion);
    assert(Number.isSafeInteger(row.nBars) && row.nBars>=snapshot.unifiedMinimumSessions);
    assert(!Object.hasOwn(snapshot.unifiedExcludedBySymbol,row.symbol),'A scored symbol is listed as excluded');
    ranked.push({score:score.score,rank:row.unifiedRank});
  }
  assert.equal(ranked.length,scored);
  ranked.sort((a,b)=>b.score-a.score);
  let position=0;
  for(let i=0;i<ranked.length;i++){
    if(i===0 || ranked[i].score!==ranked[i-1].score)position=i+1;
    assert.equal(ranked[i].rank,position,'Inconsistent unified competition rank');
  }
}

function migrationBaseline(previous,current){
  assert.equal(current.version,release.baselineSiteVersion,'Migration baseline site version changed');
  assert.equal(rankDigest(current),release.baselineSha256,'Migration baseline bytes changed');
  assert.equal(previous.buildVersion,release.previousBuild);
  assert.equal(previous.asOf,release.asOf);
  assert.equal(previous.source.commit,release.sourceCommit);
}

function compareMigration(next,previous,current){
  migrationBaseline(previous,current);
  checkSnapshot(next);
  assert.equal(next.buildVersion,release.nextBuild);
  assert.equal(next.asOf,previous.asOf);
  assert.equal(next.source.commit,previous.source.commit);
  const {generatedAt,unifiedModelVersion,unifiedMinimumSessions,unifiedCoverage,unifiedOnlyRows,unifiedExcludedBySymbol,unifiedReasonLabels,rows,...shared}=next;
  const {generatedAt:priorTime,...old}=previous;
  const legacy=rows.map(({unified,unifiedRank,...row})=>row);
  assert(isDeepStrictEqual({...shared,buildVersion:previous.buildVersion,rows:legacy},old),
    'The additive migration changed an existing date, price revision, symbol, rank, input or legacy score');
}

function compareCandidate(next, previous, date) {
  checkSnapshot(next);
  assert.equal(next.asOf,date,'Latest directory and price dates differ');
  assert(next.asOf >= previous.asOf,'Ranking date regression');
  assert.equal(next.buildVersion,release.nextBuild,'Expected unified rank generation');
  for (const name of ['schemaVersion','modelVersion','buildVersion','timingModelVersion','unifiedModelVersion','unifiedMinimumSessions']) assert.equal(next[name],previous[name]);
  assert.deepEqual(next.timingWeights,previous.timingWeights);
  if(previous.timingCoverage)assert(next.timingCoverage.scored>=.85*previous.timingCoverage.scored,'Unexpected loss of verified timing coverage');
  if(previous.unifiedCoverage)assert(next.unifiedCoverage.scored>=.85*previous.unifiedCoverage.scored,'Unexpected loss of unified score coverage');
  assert(next.coverage.listed >= .90*previous.coverage.listed && next.coverage.scored >= .85*previous.coverage.scored,'Unexpected loss of listing or price coverage');
  if (next.asOf === previous.asOf) {
    assert(verifyCurrent,'Same-day publication requires --verify-current');
    const {generatedAt:now, ...a} = next, {generatedAt:before, ...b} = previous;
    // Compare complete rankings, factors, inputs, excluded symbols and attributed revision.
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

async function report(state, m, data, directoryFile) {
  const proof = {state,checkedAt:new Date().toISOString(),asOf:data.asOf,version:'v'+m.version,
    sha256:rankDigest(m),coverage:data.coverage,sourceCommit:data.source.commit};
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
  console.log(state,proof.asOf,proof.version,proof.coverage.scored+' scored',proof.sha256);
}

const contentDigest=data=>{
  const {generatedAt,...content}=data;
  return sha256(JSON.stringify(content));
};

async function run(stage) {
  const current = await manifest(), previous = await readPublished(current);
  checkSnapshot(previous);
  if(reviewFile){
    const candidate=JSON.parse(await readFile(path.resolve(reviewFile),'utf8'));
    compareMigration(candidate,previous,current);
    console.log('Read-only unified review:',current.version,candidate.asOf,candidate.unifiedCoverage.scored,contentDigest(candidate));
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
  const date=day(catalog.asOf);
  assert(date>=previous.asOf,'Directory feed predates current public ranking');
  if(held){await report('retained-directory-unavailable',current,previous);return;}
  const replay=migrateUnified || verifyCurrent;
  if(!replay && date===previous.asOf){await report('current',current,previous);return;}
  const code=await execute(process.execPath,[path.join(root,'scripts','rank-market.mjs'),
    '--dolt',process.env.DOLT_EXECUTABLE || 'dolt','--db',path.join(cache,'stockdb'),
    '--cache',path.join(stage,'jobs'),'--data-dir',dataDir,'--update',
    ...(replay?['--revision',previous.source.commit,'--as-of',previous.asOf]:[])],{allowPriceLag:!replay});
  if(code===75){
    await report('retained-price-source-behind',current,previous);
    return;
  }
  const bytes=await readFile(path.join(stage,rankPath)),candidate=JSON.parse(bytes);
  if(migrateUnified){
    compareMigration(candidate,previous,current);
    assert.equal(contentDigest(candidate),values['expected-content-sha256'],'Independent cloud rebuild differs from reviewed unified ranking');
  }else compareCandidate(candidate,previous,date);
  const published=await publish(stage,current,sha256(bytes));
  await report(migrateUnified?'unified-release-published':verifyCurrent?'reproduced-and-published':'published',published,candidate,path.join(dataDir,'us-listings.json'));
}

export {checkSnapshot,compareMigration,compareCandidate,contentDigest};
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await mkdir(cache,{recursive:true});
  const stage=await mkdtemp(path.join(cache,'run-'));
  try {await run(stage);}
  finally {
    await rm(stage,{recursive:true,force:true});
  }
}
