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

const {values} = parseArgs({options:{'verify-current':{type:'boolean',default:false}}});
const verifyCurrent = values['verify-current'];
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
  for (const row of snapshot.rows) {
    assert(typeof row.symbol === 'string' && row.symbol.trim() && !symbols.has(row.symbol.toUpperCase()),'Invalid or repeated symbol');
    symbols.add(row.symbol.toUpperCase());
    assert.equal(row.asOf,snapshot.asOf,'Stale symbol date');
    assert(Number.isSafeInteger(row.nBars) && row.nBars>=snapshot.minimumSessions && row.nBars<=snapshot.maximumSessions,'Invalid observation count');
    assert(Array.isArray(row.factors) && row.factors.length === 4 && row.factors.every(n=>Number.isFinite(n)&&n>=0&&n<=100),'Invalid scoring factors');
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
}

function compareCandidate(next, previous, date) {
  checkSnapshot(next);
  assert.equal(next.asOf,date,'Latest directory and price dates differ');
  assert(next.asOf >= previous.asOf,'Ranking date regression');
  for (const name of ['schemaVersion','modelVersion','buildVersion']) assert.equal(next[name],previous[name]);
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
  const dataDir = path.join(stage,'data');
  await execute(process.execPath,[path.join(root,'scripts','prepare-rank-catalog.mjs'),dataDir]);
  const catalog = JSON.parse(await readFile(path.join(dataDir,'us-listings.json'),'utf8'));
  const date = day(catalog.asOf);
  assert(date>=previous.asOf,'Directory feed predates current public ranking');
  if (date===previous.asOf && !verifyCurrent) {
    await report('current',current,previous);
  } else {
    // Each computation starts with fresh partitions. The immutable Dolt chunks may be reused.
    await execute(process.execPath,[path.join(root,'scripts','rank-market.mjs'),
      '--dolt',process.env.DOLT_EXECUTABLE || 'dolt','--db',path.join(cache,'stockdb'),
      '--cache',path.join(stage,'jobs'),'--data-dir',dataDir,'--update']);
    const bytes = await readFile(path.join(stage,rankPath)), candidate = JSON.parse(bytes);
    compareCandidate(candidate,previous,date);
    const published = await publish(stage,current,sha256(bytes));
    await report(date===previous.asOf?'reproduced-and-published':'published',published,candidate);
  }
} finally {
  // The run-specific staging directory is created above; retain the shared Dolt database.
  await rm(stage,{recursive:true,force:true});
}
