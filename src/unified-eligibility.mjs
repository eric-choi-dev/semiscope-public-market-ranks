import {isRegisteredBDC} from './bdc-registry.mjs';
import {isRegisteredClosedEndFund} from './cef-registry.mjs';

const references={SOXL:'SOXX',MU:'SOXX',SOXX:'SOXX',QQQ:'QQQ',IXIC:'IXIC',GSPC:'SPY',SPY:'SPY'};
// Index-tracking objectives checked against the issuers. Listing as an ETF alone
// does not establish a fund's leverage, underlying, or daily reset objective.
const verifiedEtfs=new Set([
  'VOO','IVV','VTI','IWM','IWD','IWF','IWB','IWN','IWO','IWV','IWR','IWS','IWP','IJH','IJR',
  'XLC','XLY','XLP','XLE','XLF','XLV','XLI','XLB','XLRE','XLK','XLU',
  'DIA','RSP','QQQM','SCHD','SCHG','SCHB','SCHX','SCHA','SCHV','VUG','VTV','VO','VV','VB','VBR','VBK',
]);
const equityReceipt = /\b(?:ordinary|common)\s+(?:stock|shares?)\b/i;
const complexFund = /\b(?:leveraged?|inverse|short|bear|bull|ultra(?:pro|short)?|daily|[1234](?:\.\d+)?\s*x|2cr|covered|calls?|puts?|option(?:s|al)?|buy.?write|put.?write|income advantage|hedg(?:ed|e)|buffer(?:ed)?|defined (?:outcome|return)|target outcome|accelerat(?:or|ed)|enhanced|premium|synthetic|swap|managed futures|futures|neutral|overlay|collar|tail risk|alternatives?|notes?|ETN|bitcoin|ether(?:eum)?|crypto(?:currency)?|blockchain|volatility index)\b/i;

// Issuer equity catalogues identify these traditional sector, broad-market
// and style portfolios. An ETF flag alone cannot identify a fund's objective.
// https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/
// https://www.ssga.com/us/en/institutional/capabilities/equities/sector-investing/sector-and-industry-etfs
// https://advisors.vanguard.com/investments/etfs?asset_class=Equity
// https://www.ishares.com/us/literature/brochure/ishares-product-list-en-us.pdf
// https://www.invesco.com/us/en/financial-products/etfs/invesco-sp-500-high-beta-etf.html
const additionalEquityEtfs=new Set(('SMH SPHB XBI XHB XRT KRE KBE XME XOP XES XPH XAR XSD '+
  'XSW XTL KCE KIE XHE XHS XITK XNTK XTH XTN XWEB MDY '+
  'VCR VDC VDE VFH VGT VHT VIS VAW VOX VPU VNQ VNQI VIG VIGI VYM VYMI '+
  'VEA VWO VXUS VT VEU VSS VPL VGK VONE VONG VONV VTWO VTWG VTWV '+
  'MGK MGC MGV VOE VOT VIOO VIOG VIOV VTHR VXF ESGV VSGX '+
  'ITOT IUSG IUSV IYY DIVB DGRO HDV OEF XOEF IVW IVE IMCB IMCG IMCV SMMD '+
  'IXUS IEFA IEMG IDEV IEUR IEV EUFN AIA DVYA IPAC AAXJ IJK IJJ IJS IJT').split(' '));
const equityIndexFamily=/^(?:iShares|Vanguard|State Street(?: SPDR)?|SPDR|Invesco|Schwab)\s+.*?\b(?:MSCI|FTSE|Russell|S&P(?:\s*(?:100|400|500|600|900|1000|1500|SmallCap|MidCap|Composite|Total|Biotech|Semiconductor)|\s+Global)|Dow Jones U\.S\.)\b/i;
const nonEquity=/\b(?:bond|treasur(?:y|ies)|municipal|corporate debt|preferred|fixed income|credit|cash|commodit(?:y|ies)|inflation|loans?)\b/i;

export function assessUnifiedListing(listing) {
  const symbol=String(listing?.symbol??listing?.ticker??'').trim().toUpperCase().replace(/^\^(GSPC|IXIC)$/,'$1');
  const type=String(listing?.type??'').toLowerCase(), name=String(listing?.name??'').trim();
  if(isRegisteredClosedEndFund(symbol,name))return {eligible:false,kind:'restricted',reason:'SEC에 등록된 폐쇄형 펀드는 이 주식형 지수의 평가 대상에서 제외합니다.'};
  if(isRegisteredBDC(name))return {eligible:false,kind:'restricted',reason:'SEC에 등록된 기업성장투자회사(BDC)는 이 주식형 지수의 평가 대상에서 제외합니다.'};
  if(/\b(?:SPAC|blank[ -]check|acquisition (?:co(?:rp(?:oration)?)?\b|ltd\b|limited\b|plc\b))\b/i.test(name))
    return {eligible:false,kind:'restricted',reason:'기업인수목적회사(SPAC)는 합병 전 가격 구조가 달라 평가 대상에서 제외합니다.'};
  if(symbol==='SOXL' && (type==='etf'||type==='leveraged-etf'||!type))
    return {eligible:true,kind:'leveraged-etf',reason:null};
  if(['GSPC','IXIC'].includes(symbol) && (type==='index'||!type))
    return {eligible:true,kind:'index',reason:null};
  if(['SPY','QQQ','SOXX'].includes(symbol) && (type==='etf'||!type))
    return {eligible:true,kind:'etf',reason:null};
  if(type==='etf') {
    const verified=verifiedEtfs.has(symbol)||additionalEquityEtfs.has(symbol)||equityIndexFamily.test(name);
    if(verified&&!complexFund.test(name)&&!nonEquity.test(name))return {eligible:true,kind:'etf',reason:null};
    return {eligible:false,kind:'restricted',reason:'기초자산과 운용 구조가 확인된 주식형 ETF에 점수를 제공합니다.'};
  }
  const base=assessListing(listing);
  // Nasdaq's directory classifies these known foreign ordinary share listings
  // as "other". Keep their existing positive issuer-and-ticker identification.
  if(type==='other'&&base.reference&&['TSM','ASML'].includes(symbol))
    return {eligible:true,kind:symbol==='TSM'?'depositary':'stock',reason:null};
  if(base.reference && (type==='stock'||type==='depositary'||(symbol==='MU'&&!type)))
    return {eligible:true,kind:type||'stock',reason:null};
  return {eligible:false,kind:'restricted',reason:base.reason??'보통주·주식형 ETF·지원 지수에 점수를 제공합니다.'};
}

export function assessListing(listing) {
  const symbol=String(listing?.symbol??listing?.ticker??'').trim().toUpperCase().replace(/^\^(GSPC|IXIC)$/,'$1'),type=String(listing?.type??'').toLowerCase(),name=listing?.name??'';
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
