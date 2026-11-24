import assert from 'node:assert/strict';
import test from 'node:test';
import {valueMember} from './refresh-large-cap-universe.mjs';
import {qualitySnapshotIsFresh,universeMember,LARGE_CAP_USD,validQualityUniverse} from '../src/large-cap-universe.mjs';
import {readFile} from 'node:fs/promises';

const day='2026-11-23',member={symbol:'EX',cik:'0000000001'};
const listing={symbol:'EX',type:'stock',name:'Example Corporation Common Stock'};
const fact={cik:member.cik,shares:50_000_000,sharesAsOf:'2026-10-15',sharesFiled:'2026-10-20',capBasis:'issuer',
  filingUrl:'https://www.sec.gov/Archives/edgar/data/1/000000000126000010/report.htm'};
test('reported shares and split-adjusted current units reproduce inclusive cap threshold',()=>{
  const splits=[{date:'2026-10-15',ratio:3},{date:'2026-11-02',ratio:2},{date:'2026-12-01',ratio:4}];
  const r=valueMember(member,listing,{close:100,splits},fact,day);
  assert.equal(r.capUsd,LARGE_CAP_USD);assert.equal(r.eligible,true);assert.equal(r.splitFactor,2);
  assert.equal(valueMember(member,listing,{close:99.99,splits},fact,day).reason,'below_cap');
  assert.equal(valueMember(member,listing,{close:99.99,splits},{...fact,capBasis:'listedClassLowerBound'},day).reason,'class_floor_below');
});
test('a future filing, unconfirmed share count or class, ETF, missing close or uncertain split cannot qualify',()=>{
  const p={close:999,splits:[]};
  for(const result of [
    valueMember(member,listing,p,{...fact,sharesFiled:'2026-11-24'},day),
    valueMember(member,listing,p,{...fact,sharesFiled:day},day),
    valueMember(member,listing,p,{...fact,sharesAsOf:'2025-01-15'},day),
    valueMember(member,listing,p,{...fact,cik:'2'},day),
    valueMember(member,listing,p,{...fact,capBasis:'total-from-one-class'},day),
    valueMember(member,{...listing,type:'etf'},p,fact,day),
    valueMember(member,listing,null,fact,day),
    valueMember(member,listing,{...p,splits:[{date:'2026-11-01',ratio:0}]},fact,day)])
    assert.equal(result.eligible,false);
});
test('a bare-name listing needs SEC title evidence for this issuer and an ETF remains outside the stock universe',()=>{
  const p={close:250,splits:[]},other={...listing,type:'other',name:'Example Inc.'};
  const verified={...fact,verifiedCommon:true,securityTitle:'Common Stock, par value $1.00',securityTitleSource:fact.filingUrl};
  assert.equal(valueMember(member,other,p,verified,day).eligible,true);
  assert.equal(valueMember(member,other,p,fact,day).eligible,false);
  assert.equal(valueMember(member,other,p,{...verified,securityTitleSource:fact.filingUrl.replace('/1/','/123/')},day).eligible,false);
  assert.equal(valueMember(member,{...other,type:'etf'},p,verified,day).eligible,false);
});
test('verified release matches values, date and roster; outside members cannot be promoted',async()=>{
  const local=new URL('../public/data/large-cap-universe.json',import.meta.url);
  const bytes=await readFile(local).catch(error=>{
    if(error.code!=='ENOENT')throw error;
    return readFile(new URL('../quality/latest.json',import.meta.url));
  });
  const data=JSON.parse(bytes);
  assert(validQualityUniverse(data,data.asOf));
  assert(!validQualityUniverse(data,'2000-01-03'));
  assert(qualitySnapshotIsFresh(data,new Date(data.asOf+'T21:00:00Z')));
  const delayed=new Date(Date.parse(data.asOf)+11*86400000);assert.equal(qualitySnapshotIsFresh(data,delayed),false);
  for(const ticker of ['SOXL','IPW']) assert(!universeMember(data,ticker)?.eligible);
  const r=Object.values(data.rows).find(v=>v.eligible);
  assert(r);
  const revised=structuredClone(data);revised.rows[r.symbol].capUsd++;
  assert(!validQualityUniverse(revised,data.asOf));
  assert(!validQualityUniverse({...data,coverage:{...data.coverage,eligible:0}},data.asOf));
  assert.deepEqual(universeMember(data,'brk-b'),universeMember(data,'BRK.B'));
});
