// Fixed contribution plan, evaluated at completed session closes on split-adjusted OHLC.
// No realized future return, recovery date or subsequent low contributes to an entry score.
export const ACCUMULATION_VERSION = 'accumulation-1.0';
export const ACCUMULATION_WEIGHTS = {252:[35,25,25,15],504:[32,23,25,20]};
export const TRANCHE_OFFSETS = [0,21,42,63];

const referenceFor = {SOXL:'SOXX',MU:'SOXX',SOXX:'SOXX',QQQ:'QQQ',IXIC:'IXIC',GSPC:'SPY',SPY:'SPY'};
const names = ['자기 낙폭 순위','장기선 대비 가격','기초시장 회복력','변동·레버리지 부담'];
const keys = ['drawdown','discount','resilience','risk'];
const descriptions = ['적립 강한 경계','적립 신중','적립 관망','분할매수 우호','분할매수 강한 후보'];
const minHistory=252, maxHistory=756;
const round = (value, digits=2) => Number.isFinite(value)?Number(value.toFixed(digits)):null;
const clamp = (v, lo, hi) => Math.max(lo,Math.min(hi,v));
const scaled = (v, lo, hi) => 100*clamp((v-lo)/(hi-lo),0,1);
const bucket = score => Math.min(4,Math.floor(score/20));
const fmt = v => v.toFixed(1);
const signedPct = v => (v<0?'−':'+')+fmt(Math.abs(v))+'%';
const quantile = (sorted,q) => {
  if (!sorted.length) return null;
  const x=(sorted.length-1)*q, left=Math.floor(x), right=Math.ceil(x);
  return sorted[left]+(x-left)*(sorted[right]-sorted[left]);
};

function sortedPosition(values,x,afterTies) {
  let low=0,high=values.length;
  while(low<high) {
    const middle=Math.floor((low+high)/2);
    if(values[middle]<x || (afterTies && values[middle]===x)) low=middle+1;
    else high=middle;
  }
  return low;
}

// Rank and the 90th percentile both use only previous sessions. Limit the
// reference window to three trading years so young and mature assets are comparable.
function trailingReference() {
  const sorted=[],queue=[];
  return {
    read(value) {
      if (!Number.isFinite(value)) return null;
      let stats=null;
      if (sorted.length>=minHistory) {
        const lower=sortedPosition(sorted,value,false),upper=sortedPosition(sorted,value,true);
        stats={rank:50*(lower+upper)/sorted.length,p90:quantile(sorted,.9),n:sorted.length};
      }
      sorted.splice(sortedPosition(sorted,value,true),0,value);
      queue.push(value);
      if(queue.length>maxHistory) sorted.splice(sortedPosition(sorted,queue.shift(),false),1);
      return stats;
    }
  };
}

function candleFeatures(candles) {
  const result=[],highCloses=[],lowCloses=[],means=[],returns=[];
  let sum200=0;
  for(let i=0;i<candles.length;i++) {
    const close=candles[i][4];
    sum200+=close;
    if(i>=200) sum200-=candles[i-200][4];
    const ma=i>=199?sum200/200:null;
    means.push(ma);
    // Monotone queues retain the highest 252-session and lowest 63-session close.
    while(highCloses.length && candles[highCloses.at(-1)][4]<=close) highCloses.pop();
    while(lowCloses.length && candles[lowCloses.at(-1)][4]>=close) lowCloses.pop();
    highCloses.push(i); lowCloses.push(i);
    if(highCloses[0]<=i-252) highCloses.shift();
    if(lowCloses[0]<=i-63) lowCloses.shift();
    if(i) returns.push(Math.log(close/candles[i-1][4]));
    if(returns.length>63) returns.shift();
    let volatility=null;
    if(returns.length===63) {
      const mean=returns.reduce((s,r)=>s+r,0)/63;
      const variance=returns.reduce((s,r)=>s+(r-mean)**2,0)/62;
      volatility=100*Math.sqrt(variance*252);
    }
    result.push({
      drawdown:i>=251?100*(1-close/candles[highCloses[0]][4]):null,
      discount:ma?100*(1-close/ma):null,
      longSlope:i>=325?100*(ma/means[i-126]-1):null,
      rebound:i>=62?100*(close/candles[lowCloses[0]][4]-1):null,
      volatility
    });
  }
  return result;
}

function percentileAndDepth(value,ref,floor) {
  // Rank measures rarity; depth relative to the instrument's own historical
  // 90th-percentile discount prevents a shallow move in a quiet market scoring 100.
  const intensity=scaled(Math.max(0,value),0,Math.max(floor,ref.p90));
  return .65*ref.rank+.35*intensity;
}
function factorScores(row,refs,sector,broad,leveraged) {
  if (!refs.dd || !refs.gap || !refs.vol || !Number.isFinite(sector?.longSlope) || !Number.isFinite(broad?.longSlope)) return null;
  const drawdown=percentileAndDepth(row.drawdown,refs.dd,5);
  const discount=percentileAndDepth(row.discount,refs.gap,5);
  const resilience=.45*scaled(sector.longSlope,-15,15)+.30*scaled(broad.longSlope,-15,15)+.25*scaled(sector.rebound,0,25);
  const risk=.35*(100-refs.vol.rank)+.35*(100-scaled(row.volatility,12,120))+.30*(leveraged?0:100);
  return [drawdown,discount,resilience,risk].map(v=>round(v,2));
}
function contribution(scores,weights) {
  const points=scores.map((v,i)=>round(v*weights[i]/100,2));
  return {score:Math.round(points.reduce((a,b)=>a+b,0)),points};
}

/**
 * A starting account of 1.0 is held in cash until each fill. Holdings added
 * at the regular open participate in that day's low. MAE is relative to
 * initial capital, not a peak-to-trough loss or a loss on deployed shares alone.
 */
export function trancheOutcome(candles,signalIndex,horizon) {
  if(!Number.isInteger(signalIndex)||signalIndex<0||!Number.isInteger(horizon)||
      horizon<64||signalIndex+horizon>=candles.length) return null;
  let cash=1,shares=0,minimum=1,k=0;
  for(let j=1;j<=horizon;j++) {
    const bar=candles[signalIndex+j];
    if(k<TRANCHE_OFFSETS.length && j===1+TRANCHE_OFFSETS[k]) {
      shares+=.25/bar[1]; cash-=.25; k++;
    }
    minimum=Math.min(minimum,cash+shares*bar[3]);
  }
  const end=candles[signalIndex+horizon];
  return {returnPct:100*(cash+shares*end[4]-1),maePct:100*(minimum-1),
    firstFill:candles[signalIndex+1][0],lastFill:candles[signalIndex+64][0],exitDate:end[0]};
}
function sampleStats(sample,min,max) {
  const n=sample.length,wins=sample.filter(r=>r.returnPct>0).length;
  const endings=sample.map(r=>r.returnPct).sort((a,b)=>a-b),lows=sample.map(r=>r.maePct).sort((a,b)=>a-b);
  return {min,max,n,wins,winRate:n?round(100*wins/n):null,medianPct:round(quantile(endings,.5),3),
    p10Pct:round(quantile(endings,.1),3),medianMaePct:round(quantile(lows,.5),3),
    loss20Rate:n?round(100*lows.filter(r=>r<=-20).length/n):null};
}
function audit(candles,rows,h,scoreNow) {
  // Same predeclared grid, including the same phase, for all score bins and baseline.
  const start=rows.findIndex((r,i)=>r!==null && candles[i][0]>='2016-01-01'),sample=[];
  if(start>=0) for(let i=start;i+h<candles.length;i+=h) {
    if(rows[i]===null) continue;
    const outcome=trancheOutcome(candles,i,h);
    sample.push({...outcome,date:candles[i][0],score:rows[i]});
  }
  const bins=descriptions.map((_,idx)=>sampleStats(sample.filter(s=>bucket(s.score)===idx),idx*20,idx===4?100:idx*20+19));
  return {horizon:h,stride:h,first:sample[0]?.date??null,last:sample.at(-1)?.date??null,
    matched:bins[bucket(scoreNow)],baseline:sampleStats(sample,0,100),bins};
}

// The same close-by-close factor observations drive staged and single-entry
// strategies. None of the observations contains a subsequent price or return.
export function buildFactorTape(data,ticker,options={}) {
  const assets=data?.assets??data;
  const ref=Object.hasOwn(referenceFor,ticker) ? referenceFor[ticker] : options.referenceTicker;
  const candles=assets?.[ticker]?.candles,refCandles=assets?.[ref]?.candles,spyCandles=assets?.SPY?.candles;
  if(!ref || !candles?.length || !refCandles?.length || !spyCandles?.length) return null;
  const own=candleFeatures(candles);
  const underlying=refCandles===candles?own:candleFeatures(refCandles);
  const broad=spyCandles===refCandles?underlying:spyCandles===candles?own:candleFeatures(spyCandles);
  const refDates=new Map(refCandles.map((c,i)=>[c[0],underlying[i]]));
  const spyDates=spyCandles===refCandles?refDates:new Map(spyCandles.map((c,i)=>[c[0],broad[i]]));
  const previous={dd:trailingReference(),gap:trailingReference(),vol:trailingReference()};
  let latest=null;
  const factors=own.map((row,i)=>{
    const date=candles[i][0],sector=refDates.get(date),spy=spyDates.get(date);
    const refs={dd:previous.dd.read(row.drawdown),gap:previous.gap.read(row.discount),vol:previous.vol.read(row.volatility)};
    const scores=factorScores(row,refs,sector,spy,ticker==='SOXL');
    if(i===own.length-1 && scores) latest={row,sector,spy,refs,scores};
    return scores;
  });
  if(!latest) return null;
  const {row,sector,spy,refs}=latest;
  const inputs={drawdownPct:round(-row.drawdown),drawdownRank:round(refs.dd.rank),drawdownP90:round(refs.dd.p90),
    dist200Pct:round(-row.discount),discountRank:round(refs.gap.rank),discountP90:round(refs.gap.p90),
    referenceSlopePct:round(sector.longSlope),spySlopePct:round(spy.longSlope),referenceBouncePct:round(sector.rebound),
    volatility63Pct:round(row.volatility),volatilityRank:round(refs.vol.rank),leverage:ticker==='SOXL'?3:1};
  return {ticker,ref,candles,latest,factors,inputs,asOf:candles.at(-1)[0]};
}

export function buildAccumulation(data,ticker,options={}) {
  const tape=options.factorTape??buildFactorTape(data,ticker,options);
  if(!tape || tape.ticker!==ticker)return null;
  const {ref,candles,factors,latest,inputs}=tape;
  const {row,sector,spy,refs,scores}=latest;
  const reasons=[
    '252일 최고 종가 대비 −'+fmt(row.drawdown)+'%. 과거 '+refs.dd.n+'개 낙폭 중 '+fmt(refs.dd.rank)+'백분위이며 90백분위 낙폭은 '+fmt(refs.dd.p90)+'%입니다.',
    '200일선 대비 '+signedPct(-row.discount)+'. 이격도가 낮을수록 가격 할인 폭이 크며, 현재 할인 폭은 과거 '+refs.gap.n+'개 관측 중 '+fmt(refs.gap.rank)+'백분위입니다.',
    ref+' 200일선의 반년 변화 '+signedPct(sector.longSlope)+', SPY '+signedPct(spy.longSlope)+'. '+ref+'는 최근 63일 최저 종가 대비 '+signedPct(sector.rebound)+'입니다.',
    '63일 연율 변동성 '+fmt(row.volatility)+'%, 과거 '+refs.vol.n+'개 관측 중 '+fmt(refs.vol.rank)+'백분위. '+(ticker==='SOXL'?'일일 3배 재조정 위험을 구조 항목에 반영합니다.':'일일 3배 재조정에 따른 구조 감점이 없습니다.')
  ];
  const result={version:ACCUMULATION_VERSION,asOf:candles.at(-1)[0],reference:ref,inputs,horizons:{}};
  for(const [period,weights] of Object.entries(ACCUMULATION_WEIGHTS)) {
    const daily=factors.map(scoresAtClose=>scoresAtClose?contribution(scoresAtClose,weights).score:null);
    const now=contribution(scores,weights),prior=daily.at(-2),history=[];
    for(let i=0;i<daily.length;i++) if(daily[i]!==null) history.push({date:candles[i][0],score:daily[i]});
    result.horizons[period]={
      score:now.score,previous:prior??null,change:prior===null||prior===undefined?null:now.score-prior,
      label:descriptions[bucket(now.score)],components:keys.map((key,i)=>({key,label:names[i],score:scores[i],weight:weights[i],points:now.points[i],reason:reasons[i]})),
      history,validation:audit(candles,daily,Number(period),now.score)
    };
  }
  return result;
}
