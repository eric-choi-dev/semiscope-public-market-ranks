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

const {values} = parseArgs({options:{
  'verify-current':{type:'boolean',default:false},
  'migrate-timing-v2':{type:'boolean',default:false},
  'review-timing-candidate':{type:'string'},
}});
const verifyCurrent = values['verify-current'];
const migrateTiming = values['migrate-timing-v2'];
assert(!(verifyCurrent && migrateTiming),'Choose either reproduction or the approved timing migration');
assert(!values['review-timing-candidate'] || (!verifyCurrent && !migrateTiming),'Read-only review cannot be combined with a publication mode');
const timingRelease={
  baselineSiteVersion:2,
  baselineSha256:'d85be32539af5342f11c4d682f2ab54aec767582995711fbd67a62d7d484e6f5',
  asOf:'2026-11-20',sourceCommit:'aef7n6a07m0r9tn7nrr0gfsjpstfdhr3',
  previousBuild:'rank-market-1.2',nextBuild:'rank-market-2.0',timingModel:'bottom-timing-1.0',
  // SHA256 of the reviewed full snapshot with only its generatedAt omitted.
  approvedContentSha256:'16cc820785ee38148f0247318c86d4d87e17bb9c162f927349bf7069734f8e20',
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

function execute(program, args) {
  const env = {...process.env};
  delete env.RANK_PUBLISH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return new Promise((resolve,reject) => {
    const child = spawn(program,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
    child.once('error',reject);
    child.once('exit',(code,signal) => {
      if (code === 0) resolve();
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
    assert.equal(snapshot.timingModelVersion,timingRelease.timingModel);
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
}

function compareMigration(next,previous,date,manifestNow){
  assert.equal(manifestNow.version,timingRelease.baselineSiteVersion,'Migration baseline site version changed');
  assert.equal(rankDigest(manifestNow),timingRelease.baselineSha256,'Migration baseline bytes changed');
  assert.equal(previous.buildVersion,timingRelease.previousBuild);
  assert.equal(next.buildVersion,timingRelease.nextBuild);
  assert.equal(next.timingModelVersion,timingRelease.timingModel);
  assert.equal(next.asOf,date);
  assert.equal(date,timingRelease.asOf);
  assert.equal(next.source.commit,timingRelease.sourceCommit);
  assert.equal(previous.source.commit,timingRelease.sourceCommit);
  assert.match(timingRelease.approvedContentSha256,/^[a-f0-9]{64}$/,'Release has not passed private verification');
  const {generatedAt,...content}=next;
  assert.equal(sha256(JSON.stringify(content)),timingRelease.approvedContentSha256,'Full candidate differs from the independently checked release');
  // Every legacy factor, score, input, rank, exclusion and symbol stays identical.
  const {timingModelVersion,timingWeights,timingCoverage,rows,...same}=content;
  const {generatedAt:oldGeneratedAt, ...prior}=previous;
  assert(isDeepStrictEqual({...same,buildVersion:previous.buildVersion,rows:rows.map(({timing,...row})=>row)},prior),
    'Timing migration changed an existing market ranking or legacy field');
  assert.equal(timingCoverage.scored,rows.length,'The approved baseline requires a computed timing score on every ranked instrument');
}

function compareCandidate(next, previous, date) {
  checkSnapshot(next);
  assert.equal(next.asOf,date,'Latest directory and price dates differ');
  assert(next.asOf >= previous.asOf,'Ranking date regression');
  for (const name of ['schemaVersion','modelVersion','buildVersion','timingModelVersion']) assert.equal(next[name],previous[name]);
  assert.deepEqual(next.timingWeights,previous.timingWeights);
  if(previous.timingCoverage)assert(next.timingCoverage.scored>=.85*previous.timingCoverage.scored,'Unexpected loss of verified timing coverage');
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

async function report(state, m, data) {
  const proof = {state,checkedAt:new Date().toISOString(),asOf:data.asOf,version:'v'+m.version,
    sha256:rankDigest(m),coverage:data.coverage,sourceCommit:data.source.commit};
  const target = path.join(root,'last-run.json'), temporary = target+'.tmp-'+process.pid;
  await writeFile(temporary,JSON.stringify(proof,null,2)+'\n');
  await rename(temporary,target);
  console.log(state,proof.asOf,proof.version,proof.coverage.scored+' scored',proof.sha256);
}

await mkdir(cache,{recursive:true});
const stage = await mkdtemp(path.join(cache,'run-'));
try {
  const current = await manifest(), previous = await readPublished(current);
  checkSnapshot(previous);
  if(values['review-timing-candidate']){
    const candidate=JSON.parse(await readFile(path.resolve(values['review-timing-candidate']),'utf8'));
    checkSnapshot(candidate);
    compareMigration(candidate,previous,timingRelease.asOf,current);
    console.log('Read-only migration verified:',current.version,candidate.asOf,candidate.coverage.scored,timingRelease.approvedContentSha256);
  }else{
    if(migrateTiming) {
      assert.equal(current.version,timingRelease.baselineSiteVersion);
      assert.equal(rankDigest(current),timingRelease.baselineSha256);
    }
    const dataDir = path.join(stage,'data');
    await execute(process.execPath,[path.join(root,'scripts','prepare-rank-catalog.mjs'),dataDir]);
    const catalog = JSON.parse(await readFile(path.join(dataDir,'us-listings.json'),'utf8'));
    const date = day(catalog.asOf);
    assert(date>=previous.asOf,'Directory feed predates current public ranking');
    if (date===previous.asOf && !verifyCurrent && !migrateTiming) {
      await report('current',current,previous);
    } else {
      // Each computation starts with fresh partitions. The immutable Dolt chunks may be reused.
      await execute(process.execPath,[path.join(root,'scripts','rank-market.mjs'),
        '--dolt',process.env.DOLT_EXECUTABLE || 'dolt','--db',path.join(cache,'stockdb'),
        '--cache',path.join(stage,'jobs'),'--data-dir',dataDir,'--update',
        ...(migrateTiming?['--revision',timingRelease.sourceCommit,'--as-of',timingRelease.asOf]:[])]);
      const bytes = await readFile(path.join(stage,rankPath)), candidate = JSON.parse(bytes);
      if(migrateTiming){
        checkSnapshot(candidate);
        compareMigration(candidate,previous,date,current);
      }else compareCandidate(candidate,previous,date);
      const published = await publish(stage,current,sha256(bytes));
      await report(migrateTiming?'timing-release-published':date===previous.asOf?'reproduced-and-published':'published',published,candidate);
    }
  }
} finally {
  // The run-specific staging directory is created above; retain the shared Dolt database.
  await rm(stage,{recursive:true,force:true});
}
