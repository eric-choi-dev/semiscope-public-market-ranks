import {buildAccumulation} from './accumulation.mjs';

const references={SOXL:'SOXX',MU:'SOXX',SOXX:'SOXX',QQQ:'QQQ',IXIC:'IXIC',GSPC:'SPY',SPY:'SPY'};
// Index-tracking objectives checked against the issuers. Listing as an ETF alone
// does not establish a fund's leverage, underlying, or daily reset objective.
const verifiedEtfs=new Set([
  'VOO','IVV','VTI','IWM','IWD','IWF','IWB','IWN','IWO','IWV','IWR','IWS','IWP','IJH','IJR',
  'XLC','XLY','XLP','XLE','XLF','XLV','XLI','XLB','XLRE','XLK','XLU',
  'DIA','RSP','QQQM','SCHD','SCHG','SCHB','SCHX','SCHA','SCHV','VUG','VTV','VO','VV','VB','VBR','VBK',
]);
const equityReceipt = /\b(?:ordinary|common)\s+(?:stock|shares?)\b/i;
const positive=value=>typeof value==='number' && Number.isFinite(value) && value>0;
const finite=Number.isFinite;
const ymd=/^\d{4}-\d{2}-\d{2}$/;
function validDate(value) {
  if(typeof value!=='string' || !ymd.test(value))return false;
  const d=new Date(value+'T00:00:00Z');
  return finite(d.getTime())&&d.toISOString().slice(0,10)===value;
}

export function canonSymbol(value) {
  return String(value??'').trim().toUpperCase().replace(/^\^(GSPC|IXIC)$/,'$1').replace(/[/.]/g,'-');
}
const symbolOf=l=>l?.symbol??l?.ticker??'';
export function matchesListing(value,listing) {
  const key=canonSymbol(value);
  return Boolean(key && (key===canonSymbol(symbolOf(listing)) || key===canonSymbol(listing?.providerSymbol)));
}
function assertInstrument(payload,listing) {
  if(!payload || !symbolOf(listing) || !matchesListing(payload.symbol??payload.ticker,listing))
    throw Error('요청한 종목과 받은 시세의 종목이 다릅니다.');
}
function stamp(value) {
  if(value==null || value==='') return null;
  const d=typeof value==='number' ? new Date(value<1e11?value*1000:value) : new Date(value);
  return finite(d.getTime())?d.toISOString():null;
}
function link(value) {
  try { const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : null; }
  catch{return null;}
}
function sessionTag(v) {
  const s=String(v??'').toLowerCase();
  if(['regular','regular-market','market','open'].includes(s))return 'regular';
  if(['pre','premarket','pre-market','premarket-trade'].includes(s))return 'pre';
  if(['post','postmarket','post-market','afterhours','after-hours','postpost'].includes(s))return 'post';
  if(['close','closed','offhours','overnight'].includes(s)) return 'closed';
  return 'unknown';
}

export function normalizeHistory(payload,listing) {
  assertInstrument(payload,listing);
  const rows=payload.history;
  if(!Array.isArray(rows)||!rows.length)throw Error('공급자가 확정 일봉을 제공하지 않았습니다.');
  let prev='';
  const candles=rows.map(r=>{
    const eps=Math.max(1e-9,r.high*1e-7);
    if(!validDate(r.date) || r.date<=prev || ![r.open,r.high,r.low,r.close].every(positive) ||
      r.high<Math.max(r.low,r.open,r.close)-eps || r.low>Math.min(r.open,r.close)+eps ||
      (r.volume!=null && (!finite(r.volume)||r.volume<0))) throw Error('확정 일봉의 날짜 또는 가격 범위를 검증할 수 없습니다.');
    prev=r.date;
    return [r.date,r.open,r.high,r.low,r.close,r.volume??null];
  });
  const sourceUrl=link(payload.historySourceUrl)??link(payload.historySource)??link(payload.sourceUrl)??link(payload.quote?.sourceUrl);
  return {ticker:symbolOf(listing),symbol:symbolOf(listing),label:listing.name??payload.name??symbolOf(listing),
    currency:payload.currency??null,type:listing.type??payload.assetType,exchange:listing.exchange??payload.exchange,
    asOf:prev,close:candles.at(-1)[4],candles,history:candles.map(c=>[c[0],c[4]]),
    source:sourceUrl,sourceUrl,provider:payload.source??payload.quote?.source??null,
    licenseUrl:link(payload.licenseUrl??payload.historyLicenseUrl), license:payload.license??payload.historyLicense??null,
    verifiedListing:payload.verifiedListing===true, verifiedName:payload.name??null, verifiedType:payload.assetType??null,
    historyComplete:payload.historyComplete??true, continuityCut:payload.continuityCut??null,
    capturedAt:stamp(payload.capturedAt),priceBasis:payload.historyBasis??payload.priceBasis??null,stale:payload.stale===true};
}

export function normalizeLive(payload,listing) {
  assertInstrument(payload,listing);
  const q=payload.quote, time=stamp(q?.time??q?.quoteTime),price=q?.price;
  const capturedAt=stamp(payload.capturedAt), latestAllowed=(capturedAt?Date.parse(capturedAt):Date.now())+60_000;
  if(!positive(price)||!time)throw Error('가격과 거래 시각이 함께 확인된 호가를 받지 못했습니다.');
  if(Date.parse(time)>latestAllowed)throw Error('거래 시각이 시세 수집 시각보다 앞서 있어 확인을 보류합니다.');
  const previousClose=positive(q.previousClose)?q.previousClose:null;
  const rawDelay=q.delayMinutes;
  const quote={...q,price,previousClose,change:finite(q.change)?q.change:previousClose!=null?price-previousClose:null,
    changePct:finite(q.changePct)?q.changePct:previousClose!=null?100*(price/previousClose-1):null,
    quoteTime:time,marketTime:time,currency:payload.currency??q.currency??null,
    sourceUrl:link(q.sourceUrl??payload.sourceUrl),source:q.source??payload.source??null,
    session:sessionTag(q.session),marketState:sessionTag(q.marketState),delayMinutes:finite(rawDelay)&&rawDelay>=0?rawDelay:null,
    stale:payload.stale===true||q.stale===true,capturedAt};
  const points=[];
  for(const row of payload.intraday??[]) {
    const t=stamp(row.time),p=row.close??row.price;
    if(!t || Date.parse(t)>latestAllowed || !positive(p) || (points.length && t<=points.at(-1).time))continue;
    points.push({time:t,price:p,volume:finite(row.volume)&&row.volume>=0?row.volume:null});
  }
  return {quote,intraday:points};
}

function result(kind,reason,reference=null,asOf=null,accumulation=null) {
  return {accumulation,eligibility:{eligible:kind==='supported',kind,reason,reference,asOf}};
}

export function assessListing(listing) {
  const symbol=canonSymbol(symbolOf(listing)),type=String(listing?.type??'').toLowerCase(),name=listing?.name??'';
  if(Object.hasOwn(references,symbol))return {reference:references[symbol],known:true};
  if ((symbol==='TSM' && /Taiwan Semiconductor Manufacturing/i.test(name)) ||
      (symbol==='ASML' && /ASML Holding/i.test(name))) return {reference:'SPY',known:false};
  if(type==='depositary' && equityReceipt.test(name) && !/\b(?:preferred|preference|warrants?|units?)\b/i.test(name))
    return {reference:'SPY',known:false};
  if(type==='etf' && verifiedEtfs.has(symbol))return {reference:'SPY',known:false};
  if(type==='etf'||type==='etn'||/\b(?:leveraged|inverse|ultrapro|ultrashort|[23]x)\b/i.test(name))
    return {reason:'레버리지·인버스·파생전략 여부와 기초자산을 검증한 상품에만 장기 점수를 제공합니다.'};
  if(type!=='stock'||/\b(?:depositary|depository|preferred|warrants?|rights?|units?|notes?|fund|closed.end|SPAC)\b/i.test(name))
    return {reason:'이 장기 점수는 보통주와 구조가 확인된 일부 ETF에 적용합니다. 이 종목의 증권 유형은 현재 평가 범위 밖입니다.'};
  if(!/\b(?:common\s+(?:stock|shares?)|ordinary\s+shares?|capital\s+stock|shares?\s+of\s+common\s+stock)\b/i.test(name))
    return {reason:'상장 자료에서 보통주 발행 형태를 확인할 수 없어 장기 점수를 보류합니다.'};
  return {reference:'SPY',known:false};
}

export function buildExplorerScore(asset,listing,dashboard) {
  const rule=assessListing(listing);
  if(!rule.reference)return result('restricted',rule.reason);
  const ref=rule.reference;
  if(!asset?.candles?.length)return result('loading','종목의 확정 일봉을 기다리고 있습니다.',ref);
  if(asset.historyComplete===false && asset.candles.length<1008)
    return result('insufficient','제공처가 일부 기간의 일봉만 반환했습니다. 전체 이력을 확인한 뒤 점수를 계산합니다.',ref);
  if(!matchesListing(asset.ticker??asset.symbol,listing))
    return result('error','선택한 종목과 확정 일봉의 종목이 일치하지 않습니다.',ref);
  if(asset.candles.length<504)
    return result('insufficient','상대적인 낙폭을 비교하려면 확정 일봉 504개가 필요합니다. 확인된 일봉은 '+asset.candles.length+'개입니다.',ref);
  const ticker=canonSymbol(asset.ticker??asset.symbol);
  const assets=Object.assign(Object.create(null),dashboard?.assets);
  assets[ticker]=asset;
  const spy=assets.SPY?.candles,reference=assets[ref]?.candles;
  if(!spy?.length||!reference?.length)return result('insufficient','같은 시점의 '+ref+(ref==='SPY'?'':'·SPY')+' 기준시장 일봉이 필요합니다.',ref);
  const spyDates=new Set(spy.map(c=>c[0])),refDates=reference===spy?spyDates:new Set(reference.map(c=>c[0]));
  const last=asset.candles.findLastIndex(c=>spyDates.has(c[0])&&refDates.has(c[0]));
  if(last<503)return result('insufficient','종목과 기준시장에 공통으로 확정된 가격 이력이 부족합니다.',ref);
  const asOf=asset.candles[last][0];
  if(last!==asset.candles.length-1)assets[ticker]={...asset,candles:asset.candles.slice(0,last+1)};
  const model=buildAccumulation(assets,ticker,{referenceTicker:ref});
  if(!model)return result('insufficient','해당 날짜의 기준시장 이동평균을 계산할 이력이 부족합니다.',ref);
  let reason=rule.known ? '기존 모델의 기준시장 '+ref+'를 사용합니다.' : '비교 기준은 미국 대형주 시장을 추적하는 SPY입니다.';
  if(asOf!==asset.asOf)reason+=' 두 시장의 공통 확정일은 '+asOf+'입니다.';
  return result('supported',reason,ref,asOf,model);
}
