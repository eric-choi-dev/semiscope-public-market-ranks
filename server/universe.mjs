// Public exchange-listed U.S. security directory. No credentials or visitor
// values are forwarded to the source. A listing is independent of quote coverage.
const usDirectoryRoot='https://www.nasdaqtrader.com/dynamic/SymDir/';
const usDirectoryFiles=['nasdaqlisted.txt','otherlisted.txt'];
const usListingExchanges={A:'NYSE American',B:'Nasdaq Texas',C:'NYSE National',F:'Texas Stock Exchange',G:'24X',H:'MIAX Pearl',I:'Nasdaq ISE',J:'Cboe EDGA',K:'Cboe EDGX',L:'LTSE',M:'NYSE Texas',N:'NYSE',P:'NYSE Arca',Q:'Nasdaq',U:'MEMX',V:'IEX',W:'Cboe',X:'Nasdaq PHLX',Y:'Cboe BYX',Z:'Cboe BZX'};
let usListingCache=null;
const usListingIndexes=new WeakMap();

export function usSecurityType(name,symbol,etf) {
  if (/\bETNs?\b|exchange[ -]traded notes?\b/i.test(name)) return 'etn';
  if (etf==='Y') return 'etf';
  if (/\$/.test(symbol) || /\b(preferred|preference)\b/i.test(name)) return 'preferred';
  if (/\.U$/.test(symbol) || /\bunits?\b(?:\s*,|\s+each\b|\s+consisting\b|\s*$)/i.test(name)) return 'unit';
  if (/\.W$/.test(symbol) || /\bwarrants?\b/i.test(name)) return 'warrant';
  if (/\.R$/.test(symbol) || /\brights?\b(?:\s*,|\s+each\b|\s+to\b|\s*$)/i.test(name)) return 'right';
  if (/\bAmerican Deposi(?:ta|to)ry (shares?|receipts?)\b|\bADRs?\b|\bADS\b/i.test(name)) return 'depositary';
  if (/\b(notes?|debentures?|bonds?)\b.*\b(due|matur)|\b(senior|subordinated) notes?\b/i.test(name)) return 'debt';
  if (/\b(common (stock|shares?)|ordinary shares?|class [a-z] (capital stock|shares?))\b/i.test(name)) return 'stock';
  return 'other';
}

function usProviderSymbol(symbol) {
  if (symbol.includes('$')) return symbol.replace('$','-P');
  if (symbol.endsWith('.W')) return symbol.slice(0,-2)+'-WT';
  if (symbol.endsWith('.U')) return symbol.slice(0,-2)+'-UN';
  if (symbol.endsWith('.R')) return symbol.slice(0,-2)+'-RI';
  return symbol.replaceAll('.','-');
}

function usDirectoryTable(body,isNasdaq) {
  const lines=body.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  const header=lines.shift()?.split('|')??[],footer=lines.pop()??'';
  const match=/^File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})\|/.exec(footer);
  const fields=['Security Name','Test Issue','ETF',...(isNasdaq?['Symbol']:['ACT Symbol','Exchange','CQS Symbol','NASDAQ Symbol'])];
  if (!match || !fields.every(key=>header.includes(key)) || lines.length<500) throw new Error('Incomplete symbol directory');
  const [,mo,day,year,hh,mm]=match;
  const createdAtET=`${year}-${mo}-${day}T${hh}:${mm}`;
  const indexes=Object.fromEntries(header.map((key,index)=>[key,index]));
  const items=[];
  let testIssuesExcluded=0;
  for (const line of lines) {
    const columns=line.split('|');
    if (columns.length!==header.length) throw new Error('Invalid directory record');
    const value=key=>columns[indexes[key]]?.trim()??'';
    if (value('Test Issue')==='Y') { testIssuesExcluded++; continue; }
    if (value('Test Issue')!=='N') throw new Error('Unknown listing test flag');
    const symbol=value(isNasdaq?'Symbol':'ACT Symbol');
    const name=value('Security Name').replace(/\s+/g,' ');
    if (!symbol || !name || symbol.length>20) throw new Error('Invalid listing identifier');
    const providerSymbol=usProviderSymbol(symbol);
    const exchange=isNasdaq?'Nasdaq':(usListingExchanges[value('Exchange')]??`US (${value('Exchange')})`);
    const type=usSecurityType(name,symbol,value('ETF'));
    const item={symbol,providerSymbol,name,exchange,type};
    const otherAliases=isNasdaq?[]:[value('CQS Symbol'),value('NASDAQ Symbol')];
    if (symbol.includes('.')) otherAliases.push(symbol.replace('.','/'));
    const aliases=[...new Set(otherAliases.filter(s=>s && s!==symbol && s!==providerSymbol))];
    if (aliases.length) item.aliases=aliases;
    items.push(item);
  }
  return {createdAtET,items,testIssuesExcluded};
}

export function parseUSListingDirectories(nasdaqText,otherText,capturedAt=new Date().toISOString()) {
  const tables=[usDirectoryTable(nasdaqText,true),usDirectoryTable(otherText,false)];
  const items=tables.flatMap(t=>t.items).sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0);
  if (items.some((a,i)=>i && a.symbol===items[i-1].symbol)) throw new Error('Conflicting primary listings');
  const sources=tables.map((table,i)=>({url:usDirectoryRoot+usDirectoryFiles[i],createdAtET:table.createdAtET,count:table.items.length,testIssuesExcluded:table.testIssuesExcluded}));
  return {schemaVersion:1,source:'Nasdaq Trader',asOf:sources.map(s=>s.createdAtET.slice(0,10)).sort()[0],capturedAt,exchangeTimezone:'America/New_York',sources,count:items.length,items};
}

async function fetchUSDirectory(file) {
  const options={headers:{Accept:'text/plain'},redirect:'error'};
  if (typeof globalThis.AbortSignal?.timeout==='function') options.signal=AbortSignal.timeout(6000);
  const response=await fetch(usDirectoryRoot+file,options);
  if (!response.ok) throw new Error('Directory unavailable');
  return response.text();
}

export async function getUSUniverse(loadSnapshot) {
  const now=Date.now();
  if (usListingCache?.expires>now) return usListingCache.value;
  try {
    const [nasdaq,other]=await Promise.all(usDirectoryFiles.map(fetchUSDirectory));
    const live=parseUSListingDirectories(nasdaq,other);
    if (usListingCache && live.asOf<usListingCache.value.asOf) throw new Error('Older source directory');
    const value={...live,sourceMode:'directory'};
    usListingCache={value,expires:now+3_600_000};
    return value;
  } catch {
    const previous=usListingCache?.value??(loadSnapshot?await loadSnapshot():null);
    if (!Array.isArray(previous?.items) || previous.items.length<1000 || previous.count!==previous.items.length) throw new Error('Verified listing directory unavailable');
    const value={...previous,sourceMode:'snapshot'};
    usListingCache={value,expires:now+300_000};
    return value;
  }
}

export async function findUSListing(input,loadSnapshot) {
  if (typeof input!=='string' || !input.trim() || input.length>24) return null;
  const catalog=await getUSUniverse(loadSnapshot);
  let index=usListingIndexes.get(catalog);
  if (!index) {
    // CQS uses lower-case preferred-share separators: e.g. TpC denotes the
    // preferred T issue, while upper-case TPC denotes a different listed stock.
    const canonical=new Map(),exactAliases=new Map();
    for (const item of catalog.items) canonical.set(item.symbol.toUpperCase(),item);
    for (const item of catalog.items) if (!canonical.has(item.providerSymbol.toUpperCase())) canonical.set(item.providerSymbol.toUpperCase(),item);
    for (const item of catalog.items) for (const alias of item.aliases??[]) {
      const key=alias.toUpperCase();
      if (alias!==key) exactAliases.set(alias,item);
      if (!canonical.has(key)) canonical.set(key,item);
    }
    index={canonical,exactAliases};
    usListingIndexes.set(catalog,index);
  }
  return index.exactAliases.get(input.trim())??index.canonical.get(input.trim().toUpperCase())??null;
}

export async function handleUniverse(request,loadSnapshot) {
  const url=new URL(request.url);
  if (url.pathname!=='/api/universe') return null;
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
  try {
    const catalog=await getUSUniverse(loadSnapshot);
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':`public, max-age=${catalog.sourceMode==='snapshot'?300:1800}`,'X-Content-Type-Options':'nosniff','X-Directory-As-Of':catalog.asOf,'X-Directory-Source':catalog.sourceMode};
    return new Response(request.method==='HEAD'?null:JSON.stringify(catalog),{headers});
  } catch {
    return new Response(request.method==='HEAD'?null:JSON.stringify({error:'미국 상장 종목 명부를 확인할 수 없습니다.',snapshot:'/data/us-listings.json'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
}
