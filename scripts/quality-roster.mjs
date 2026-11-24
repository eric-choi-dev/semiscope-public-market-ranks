import assert from 'node:assert/strict';
import {ROSTER_MAX_AGE_DAYS} from '../src/large-cap-universe.mjs';
const api='https://en.wikipedia.org/w/api.php';
const title='List of S&P 500 companies';
const text=cell=>cell.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi,'').replace(/<[^>]+>/g,'')
  .replaceAll('&amp;','&').replaceAll('&#160;',' ').replaceAll('&nbsp;',' ').replaceAll('&#39;',"'").trim();
export const symbolKey=value=>String(value??'').trim().toUpperCase().replace(/[/-]/g,'.');

export function parseMembers(html,asOf){
  const table=html.match(/<table\b[^>]*\bid=["']constituents["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  assert(table,'The constituent table is missing');
  const rows=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);
  const headers=[...rows.shift().matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m=>text(m[1]));
  const fields=['Symbol','Security','CIK','Date added'].map(label=>headers.indexOf(label));
  assert(fields.every(i=>i>=0),'Unexpected constituent table schema');
  const entries=[];
  for(const row of rows){
    const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>text(m[1]));
    assert.equal(cells.length,headers.length,'Incomplete constituent row');
    const [ticker,name,cik,added]=fields.map(i=>cells[i]);
    const symbol=symbolKey(ticker);
    assert(/^[A-Z][A-Z0-9]{0,6}(?:\.[A-Z0-9])?$/.test(symbol)&&/^\d{1,10}$/.test(cik)&&name.length>0);
    // The current table can already mention an announced addition. Only include an effective member.
    if(/^\d{4}-\d\d-\d\d$/.test(added)&&added>asOf)continue;
    entries.push({symbol,cik:cik.padStart(10,'0'),name});
  }
  assert(entries.length>=475&&entries.length<=520&&new Set(entries.map(x=>x.symbol)).size===entries.length,'Incomplete or duplicate roster');
  return entries.sort((a,b)=>a.symbol.localeCompare(b.symbol,'en'));
}
export async function getQualityRoster(asOf){
  const get=async params=>{
    const link=api+'?'+new URLSearchParams({...params,format:'json',formatversion:'2'});
    const res=await fetch(link,{headers:{'User-Agent':'Semiscope Financial Research/1.0 (https://github.com/eric-choi-dev/semiscope-public-market-ranks)'},signal:AbortSignal.timeout(30000)});
    assert(res.ok,'Wikimedia HTTP '+res.status);
    return res.json();
  };
  const query=await get({action:'query',titles:title,prop:'revisions',rvlimit:'1',rvprop:'ids|timestamp',rvstart:asOf+'T23:59:59Z'});
  const rev=query.query?.pages?.[0]?.revisions?.[0],rosterAsOf=rev?.timestamp?.slice(0,10);
  assert(Number.isSafeInteger(rev?.revid)&&rosterAsOf<=asOf&&Date.parse(asOf)-Date.parse(rosterAsOf)<=ROSTER_MAX_AGE_DAYS*86400000,'No recent revision for the selected close');
  const article=(await get({action:'parse',oldid:String(rev.revid),prop:'text'})).parse;
  assert.equal(article.revid,rev.revid);
  return {asOf:rosterAsOf,revision:rev.revid,url:'https://en.wikipedia.org/w/index.php?oldid='+rev.revid,
    members:parseMembers(article.text,asOf)};
}
