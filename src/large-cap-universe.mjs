export const QUALITY_SCHEMA=1;
export const QUALITY_ID='sp500-common-equity-cap10b-v1';
export const LARGE_CAP_USD=10_000_000_000;
export const SHARE_MAX_AGE_DAYS=150;
export const DIRECTORY_MAX_AGE_DAYS=10;
export const ROSTER_MAX_AGE_DAYS=45;
export const largeCapReasons={
  eligible:'선정 조건 충족',
  not_listed:'같은 날 미국 상장 명부에서 미확인',
  not_common:'보통주 증권 유형 미확인',
  missing_price:'같은 날 정규장 종가 미확인',
  missing_shares:'유효한 SEC 발행주식 수 미확인',
  ambiguous_class:'종목과 발행주식 종류 일치 미확인',
  stale_shares:'최근 발행주식 수 미확인',
  same_day_filing:'당일 공시의 장 마감 전 공개 시각 미확인',
  uncertain_split:'발행주식 수 이후 분할 기준 미확인',
  below_cap:'추정 시가총액 100억 달러 미만',
  class_floor_below:'확인된 주식 종류만으로 100억 달러 기준 미충족',
};
export function universeTicker(symbol){return String(symbol??'').trim().toUpperCase().replace(/[/-]/g,'.');}
export function universeMember(data,symbol){return data?.rows?.[universeTicker(symbol)]??null;}
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const within=(a,b,days)=>date(a)&&date(b)&&a<=b&&(Date.parse(b)-Date.parse(a))/86400000<=days;
export function qualitySnapshotIsFresh(snapshot,now=new Date()){
  return within(snapshot?.asOf,now.toISOString().slice(0,10),DIRECTORY_MAX_AGE_DAYS);
}
const trustedSource=url=>typeof url==='string'&&/^https:\/\/(?:en\.wikipedia\.org|(?:www\.|data\.)?sec\.gov|www\.dolthub\.com|www\.nasdaqtrader\.com|www\.ssga\.com|creativecommons\.org)\//.test(url);
export function issuerFilingUrl(url,cik){
  return typeof url==='string'&&/^\d{10}$/.test(cik)&&url.startsWith('https://www.sec.gov/Archives/edgar/data/'+Number(cik)+'/')&&
    !/[?#\\]|\.\./.test(url)&&/\/[0-9]{18}\/[A-Za-z0-9._-]+\.html?$/.test(url);
}
export function validQualityUniverse(data,requiredDate=null){
  if(data?.schemaVersion!==QUALITY_SCHEMA||data.id!==QUALITY_ID||data.thresholdUsd!==LARGE_CAP_USD||!date(data.asOf)||
    (requiredDate!=null&&data.asOf!==requiredDate)||!within(data.rosterAsOf,data.asOf,ROSTER_MAX_AGE_DAYS)||
    typeof data.selectionLabel!=='string'||!data.selectionLabel||!data.rows||typeof data.rows!=='object'||
    !/^[0-9a-v]{32}$/.test(data.priceRevision??'')||!Number.isInteger(data.rosterRevision)||
    !Array.isArray(data.sources)||data.sources.length<3||data.sources.some(s=>!trustedSource(s.url)||typeof s.label!=='string')||
    typeof data.generatedAt!=='string'||!Number.isFinite(Date.parse(data.generatedAt))||data.generatedAt.slice(0,10)<data.asOf)return false;
  const members=Object.entries(data.rows);
  if(!Number.isSafeInteger(data.coverage?.roster)||members.length!==data.coverage.roster||members.length<475||members.length>520)return false;
  let eligible=0,valued=0;
  for(const [symbol,r] of members){
    if(!r||r.symbol!==symbol||!/^[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)?$/.test(symbol)||!/^\d{10}$/.test(r.cik)||
      r.membership!=='S&P 500'||typeof r.eligible!=='boolean'||!Object.hasOwn(largeCapReasons,r.reason))return false;
    if(r.verifiedCommon!==undefined&&(r.verifiedCommon!==true||typeof r.securityTitle!=='string'||!r.securityTitle.trim()||
      !issuerFilingUrl(r.securityTitleSource,r.cik)))return false;
    if(r.listedCapitalClass!==undefined&&(r.listedCapitalClass!==true||r.capBasis!=='listedClassLowerBound'||
      !/^Class\s+[A-Z0-9]+\s+Capital Stock\b/i.test(r.securityTitle??'')||!issuerFilingUrl(r.securityTitleSource,r.cik)))return false;
    if(r.capUsd==null){
      if(r.eligible||['eligible','below_cap','class_floor_below'].includes(r.reason))return false;
      continue;
    }
    if((!r.verifiedCommon&&!r.listedCapitalClass)||r.capAsOf!==data.asOf||!Number.isSafeInteger(r.capUsd)||r.capUsd<=0||r.capUsd>1e15||
      !within(r.sharesAsOf,data.asOf,SHARE_MAX_AGE_DAYS)||!date(r.sharesFiled)||r.sharesFiled<r.sharesAsOf||r.sharesFiled>=data.asOf||
      !(Number.isSafeInteger(r.shares)&&r.shares>0)||!(Number.isFinite(r.splitFactor)&&r.splitFactor>0)||
      !(Number.isFinite(r.close)&&r.close>0)||Math.round(r.shares*r.splitFactor*r.close)!==r.capUsd||
      !['issuer','listedClassLowerBound'].includes(r.capBasis)||!issuerFilingUrl(r.filingUrl,r.cik))return false;
    const qualifies=r.capUsd>=LARGE_CAP_USD,reason=qualifies?'eligible':r.capBasis==='issuer'?'below_cap':'class_floor_below';
    if(r.eligible!==qualifies||r.reason!==reason)return false;
    valued++;eligible+=Number(qualifies);
  }
  return valued===data.coverage.valued&&eligible===data.coverage.eligible&&valued>0&&eligible>0;
}
