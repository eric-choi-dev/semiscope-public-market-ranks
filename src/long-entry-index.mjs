// A single causal contrarian setup score. Holding horizon selects outcomes only.
import {ENTRY_PARTS,factorValues,weightedScore,round,pressure,wilderRsi,inEntryZone} from './contrarian-entry-rules.mjs';
export {ENTRY_PARTS};
export const ENTRY_VERSION='long-entry-index-5.0';
export const ENTRY_MIN_BARS=504;
export const ENTRY_HORIZONS=[126,252];
export const ENTRY_PHASES=['search','decline','response','extended'];
export const COMMON_FIELDS=['drawdown252Pct','rsi14','rsiPressurePct','rsiMemoryPct','lowDistancePct','floorAge20',
  'upDays5','newLowDays20','return5Pct','return21Pct','closeLocationPct'];
export const HORIZON_FIELDS=[];
const DAY=86400000;
const phaseLabels={search:'바닥 탐색',decline:'하락 진행',response:'저점 반응',extended:'회복 이격'};
const memoryWeights=Array.from({length:5},(_,age)=>2**(-age/3));
const pct=(value,reference)=>round(100*(value/reference-1));

function dateNumber(bar) {
  if(!Array.isArray(bar)||typeof bar[0]!=='string'||!/^\d{4}-\d\d-\d\d$/.test(bar[0]))return NaN;
  const [date,o,h,l,c,v]=bar;
  if(![o,h,l,c].every(x=>Number.isFinite(x)&&x>0)||h*(1+1e-7)<Math.max(o,c,l)||l>Math.min(o,c)+h*1e-7||
    (v!=null&&!(Number.isFinite(v)&&v>=0)))return NaN;
  const t=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===date?t:NaN;
}

// Store the last 252 setups at tenth-point precision. A small Fenwick tree
// gives an exact midrank, including ties, without sorting a window per candle.
class PriorSetups {
  constructor() {
    this.tree=new Int16Array(1002);this.window=new Array(252).fill(null);
    this.next=0;this.valid=0;
  }
  change(key,by) {
    for(let j=key+1;j<this.tree.length;j+=j&-j)this.tree[j]+=by;
  }
  countThrough(key) {
    let n=0;
    for(let j=key+1;j>0;j-=j&-j)n+=this.tree[j];
    return n;
  }
  observe(key) {
    let percentile=null;
    if(key!==null&&this.valid===252){
      const lower=this.countThrough(key-1),atOrBelow=this.countThrough(key);
      percentile=round(100*(lower+atOrBelow)/(2*252));
    }
    const old=this.window[this.next];
    if(old!==null){this.change(old,-1);this.valid--;}
    this.window[this.next]=key;this.next=(this.next+1)%252;
    if(key!==null){this.change(key,1);this.valid++;}
    return percentile;
  }
}

class PriceRange {
  constructor(length){this.length=length;this.hi=[];this.lo=[];this.highHead=0;this.lowHead=0;}
  update(logs,i) {
    const today=logs[i];
    while(this.highHead<this.hi.length&&this.hi[this.highHead]<=i-this.length)this.highHead++;
    while(this.lowHead<this.lo.length&&this.lo[this.lowHead]<=i-this.length)this.lowHead++;
    while(this.hi.length>this.highHead&&logs[this.hi.at(-1)]<=today)this.hi.pop();
    while(this.lo.length>this.lowHead&&logs[this.lo.at(-1)]>=today)this.lo.pop();
    this.hi.push(i);this.lo.push(i);
    const hi=logs[this.hi[this.highHead]],lo=logs[this.lo[this.lowHead]];
    return {hi,lo};
  }
}

function newState(){
  return {close:[],changes:[],moved:[0],rising:[0],fresh:[0],pressures:[],short:new PriceRange(20),year:new PriceRange(252),rank:new PriorSetups()};
}

// Phases are descriptive tags; none of these conditions enters the score.
function describePhase(inputs){
  if(inputs.drawdown252Pct> -4 || (inputs.lowDistancePct>20 && inputs.return5Pct>0))return 'extended';
  if(inputs.return5Pct<0 && (inputs.return21Pct<0 || inputs.floorAge20===0))return 'decline';
  if(inputs.floorAge20>=2 && inputs.upDays5>=2 && inputs.return5Pct>0)return 'response';
  return 'search';
}
function observeBar(s,bar){
  const c=bar[4],i=s.close.length,prev=s.close.at(-1)??c,move=c-prev;
  const priorFloor=s.close[s.short.lo[s.short.lowHead]];
  s.close.push(c);s.changes.push(move);
  s.moved.push(s.moved[i]+Number(move!==0));
  s.rising.push(s.rising[i]+Number(move>0));
  s.fresh.push(s.fresh[i]+Number(Number.isFinite(priorFloor)&&c<priorFloor));
  const local=s.short.update(s.close,i),annual=s.year.update(s.close,i);
  const rsi=i>=126?round(wilderRsi(s.changes,i)):null;
  s.pressures.push(rsi===null?null:round(pressure(rsi)));
  if(i<251||s.moved[i+1]-s.moved[i-62]<21)return null;
  const current=s.pressures[i],memory=Math.max(...memoryWeights.map((w,age)=>w*s.pressures[i-age]));
  const inputs={drawdown252Pct:pct(c,annual.hi),rsi14:rsi,rsiPressurePct:current,rsiMemoryPct:round(memory),
    lowDistancePct:pct(c,local.lo),floorAge20:i-s.short.lo[s.short.lowHead],upDays5:s.rising[i+1]-s.rising[i-4],
    newLowDays20:s.fresh[i+1]-s.fresh[i-19],return5Pct:pct(c,s.close[i-5]),return21Pct:pct(c,s.close[i-21]),
    closeLocationPct:bar[2]>bar[3]?round(100*(c-bar[3])/(bar[2]-bar[3])):50};
  const values=factorValues(inputs);
  return {rawStrength:weightedScore(values),phase:describePhase(inputs),values,inputs};
}
function phaseReason(phase,inputs){
  switch(phase){
    case 'extended': return '최근 고점과 가깝거나 최근 저점에서 이미 회복한 가격입니다.';
    case 'decline': return '최근 5거래일 수익률은 '+inputs.return5Pct.toFixed(1)+'%, 21거래일 수익률은 '+inputs.return21Pct.toFixed(1)+'%입니다. 하락 중에도 점수에는 현재 할인 폭과 과매도가 그대로 반영됩니다.';
    case 'response': return '최근 20일 최저 종가 이후 '+inputs.floorAge20+'거래일이 지났고, 최근 5거래일 중 '+inputs.upDays5+'일은 종가가 올랐습니다.';
    default: return '최근 5거래일 중 상승일은 '+inputs.upDays5+'일입니다. 최근 20일 최저 종가보다 '+inputs.lowDistancePct.toFixed(1)+'% 높은 위치입니다.';
  }
}
export function makeEntryLeaf(date,horizon,phase,ceiling,values,percentile,inputs){
  const reasons=[
    '분할 조정 기준 252거래일 최고 종가보다 '+Math.abs(inputs.drawdown252Pct).toFixed(2)+'% 낮습니다. 낙폭 10%p마다 8점을 반영합니다.',
    '현재 Wilder RSI(14)는 '+inputs.rsi14.toFixed(2)+'입니다. RSI 50에서 20으로 내려가면서 기여도가 0점에서 8점으로 높아집니다.',
    '최근 5거래일의 RSI 과매도 강도에 3거래일 반감기를 적용한 값은 '+inputs.rsiMemoryPct.toFixed(1)+'%입니다.',
    '현재가는 20거래일 최저 종가보다 '+inputs.lowDistancePct.toFixed(2)+'% 높습니다. 저점에서 5점이며 12% 위에서는 2.5점입니다.'
  ];
  const components=ENTRY_PARTS.map(([key,label,weight],i)=>({key,label,weight,score:values[i],points:round(values[i]*weight/100,1000),reason:reasons[i]}));
  const rawStrength=weightedScore(values),score=Math.round(rawStrength);
  return {version:ENTRY_VERSION,date,horizon,score,phase,phaseLabel:phaseLabels[phase],phaseReason:phaseReason(phase,inputs),
    label:phaseLabels[phase],entryQualified:inEntryZone(score),rawStrength,percentile,ceiling,uncappedScore:score,components,inputs};
}
function horizonSeries(n) {
  return Object.fromEntries(['scores','phases','entryQualified','rawStrengths','percentiles'].map(k=>[k,Array(n).fill(null)]));
}


function scan(candles,latestOnly){
  const n=Array.isArray(candles)?candles.length:0, tape=latestOnly?null:horizonSeries(n);
  const start=latestOnly?Math.max(0,n-ENTRY_MIN_BARS):0;
  let state=newState(),lastDate=NaN,latest=null;
  for(let i=start;i<n;i++){
    const bar=candles[i],date=dateNumber(bar);
    if(!Number.isFinite(date)||date<=lastDate){state=newState();lastDate=date;continue;}
    if(date-lastDate>21*DAY)state=newState();
    lastDate=date;
    const raw=observeBar(state,bar),percentile=state.rank.observe(raw?Math.round(10*raw.rawStrength):null);
    if(percentile===null)continue;
    const score=Math.round(raw.rawStrength);
    if(tape){
      tape.scores[i]=score;tape.phases[i]=raw.phase;tape.entryQualified[i]=inEntryZone(score);
      tape.rawStrengths[i]=raw.rawStrength;tape.percentiles[i]=percentile;
    }
    if(i===n-1){
      const half=makeEntryLeaf(bar[0],126,raw.phase,100,raw.values,percentile,raw.inputs);
      latest={...half,horizons:{126:half,252:{...half,horizon:252}}};
    }
  }
  return latestOnly?latest:{version:ENTRY_VERSION,horizons:{126:tape,252:tape},latest};
}
export function buildLongEntryTape(candles){return scan(candles,false);}
export function latestLongEntry(candles){return scan(candles,true);}
