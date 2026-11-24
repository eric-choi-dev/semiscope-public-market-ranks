// Fixed explanatory features. This layer neither reads outcomes nor estimates a probability.
export const BOTTOM_MIN_BARS=252;
export const BOTTOM_PARTS=[
  ['location','다중 기간 저점 위치',35], ['oversold','과매도 압력',25],
  ['turn','장중 반격·저점 회복',25], ['stabilization','매도 둔화·RSI 다이버전스',15]
];
export const BOTTOM_INPUTS=[
  ['drawdown252Pct',100,-100,0],['location252Pct',100,0,100],['location63Pct',100,0,100],['location20Pct',100,0,100],
  ['atr14Pct',10000,0,Infinity],['low20DistanceAtr',10000,0,Infinity],['peak63DistanceAtr',10000,-Infinity,Infinity],
  ['rsi14',100,0,100],['return5Pct',100,-100,Infinity],['closeLocationPct',100,0,100],['lowReclaimAtr',1000,-Infinity,Infinity],
  ['rsiDivergence',100,-100,100],['returnAccelerationZ',1000,-Infinity,Infinity],['downside63Pct',100,0,Infinity]
];
const clamp=x=>Math.min(1,Math.max(0,x));
const round=(x,p)=>Number(x.toFixed(p))+0;
const signed=x=>(x>0?'+':'')+x.toFixed(1);
const percent=x=>100*Math.expm1(x);
const dayMillis=86400000;

function validBar(bar) {
  if(!Array.isArray(bar)||typeof bar[0]!=='string'||!/^\d{4}-\d\d-\d\d$/.test(bar[0]))return false;
  const [,o,h,l,c,v]=bar;
  return [o,h,l,c].every(n=>Number.isFinite(n)&&n>0)&&
    (v==null||(Number.isFinite(v)&&v>=0))&&h*(1+1e-7)>=Math.max(o,l,c)&&l<=Math.min(o,c)+h*1e-7;
}
function state() {
  return {bars:[],logs:[],rsi:[],gain:[0],loss:[0],squares:[0],downside:[0],moves:[0],tr:[0],
    ranges:[252,63,20].map(n=>({n,hi:[],lo:[],h:0,l:0}))};
}
function updateRange(w,bars,i,c) {
  while(w.h<w.hi.length&&w.hi[w.h]<=i-w.n)w.h++;
  while(w.l<w.lo.length&&w.lo[w.l]<=i-w.n)w.l++;
  while(w.hi.length>w.h&&bars[w.hi.at(-1)][4]<=c)w.hi.pop();
  while(w.lo.length>w.l&&bars[w.lo.at(-1)][4]>=c)w.lo.pop();
  w.hi.push(i);w.lo.push(i);
  const hi=bars[w.hi[w.h]][4],lo=bars[w.lo[w.l]][4];
  return {hi,lo,position:hi>lo?clamp(Math.log(c/lo)/Math.log(hi/lo)):.5};
}
const trailing=(a,i,n)=>a[i+1]-a[i+1-n];

export function bottomComponents(values,points,inputs) {
  const x=inputs;
  const reasons=[
    '252·63·20거래일 종가 범위에서 각각 하단 '+x.location252Pct.toFixed(1)+'%, '+x.location63Pct.toFixed(1)+'%, '+x.location20Pct.toFixed(1)+'%에 있습니다. 252일 최고 종가 대비 '+signed(x.drawdown252Pct)+'%입니다.',
    '14거래일 단순평균 RSI는 '+x.rsi14.toFixed(1)+', 최근 5거래일 수익률은 '+signed(x.return5Pct)+'%입니다. 최근 저점의 과매도도 함께 봅니다.',
    '당일 저가와 고가 사이에서 종가가 '+x.closeLocationPct.toFixed(1)+'% 위치입니다. 직전 5거래일 장중 저점과의 거리는 '+signed(x.lowReclaimAtr)+' ATR입니다.',
    '직전 비교 저점과의 RSI 차이는 '+signed(x.rsiDivergence)+'포인트, 연속된 두 3거래일 수익률의 변화는 평소 변동폭의 '+signed(x.returnAccelerationZ)+'배입니다.'
  ];
  return BOTTOM_PARTS.map(([key,label,weight],j)=>({key,label,weight,score:values[j],points:points[j],reason:reasons[j]}));
}

function append(s,bar,details,includeFeatures=false) {
  const i=s.bars.length, c=bar[4], log=Math.log(c), prev=s.bars[i-1]?.[4]??c, move=log-(s.logs[i-1]??log);
  const priorWindow=s.ranges[1],priorHigh=s.bars[priorWindow.hi[priorWindow.h]]?.[4];
  s.bars.push(bar);s.logs.push(log);
  s.gain.push(s.gain[i]+Math.max(0,c-prev));s.loss.push(s.loss[i]+Math.max(0,prev-c));
  s.squares.push(s.squares[i]+move**2);s.downside.push(s.downside[i]+Math.min(0,move)**2);
  s.moves.push(s.moves[i]+Number(c!==prev));
  s.tr.push(s.tr[i]+Math.max(bar[2]-bar[3],Math.abs(bar[2]-prev),Math.abs(bar[3]-prev)));
  const up=i>=14?trailing(s.gain,i,14):0,down=i>=14?trailing(s.loss,i,14):0;
  const rsi=up+down>0?Math.min(100,Math.max(0,100*up/(up+down))):50;
  s.rsi.push(rsi);
  const windows=s.ranges.map(w=>updateRange(w,s.bars,i,c));
  if(i+1<BOTTOM_MIN_BARS||trailing(s.moves,i,63)<21)return null;
  const atr=trailing(s.tr,i,14)/14;
  if(!(atr>0))return null;
  const [year,quarter,month]=windows;
  const low20=(c-month.lo)/atr, priorPeak=(priorHigh-c)/atr;
  const zone=low20<=Math.min(1,.08*c/atr)+1e-10&&priorPeak>=2-1e-10;
  const variance=Math.max(0,(trailing(s.squares,i-1,63)-(s.logs[i-1]-s.logs[i-64])**2/63)/62);
  const sigma=Math.max(.004,Math.sqrt(variance));
  const drop=Math.max(0,Math.log(year.hi/c)),depth=1-Math.exp(-drop/Math.max(.05,Math.sqrt(21)*sigma));
  const location=clamp(.40*(1-year.position)+.35*(1-quarter.position)+.25*(1-month.position));
  // A high-close breakout cannot inherit a bottom signal from a past oversold reading.
  const context=clamp((1-month.position)/.6)*(.25+.75*depth);
  const weekly=log-s.logs[i-5], earlierWeekly=s.logs[i-1]-s.logs[i-6];
  let lowestRsi=rsi,referenceLow=i-5,priorFloor=Infinity;
  for(let j=i-4;j<=i;j++)lowestRsi=Math.min(lowestRsi,s.rsi[j]);
  for(let j=i-5;j<i;j++)priorFloor=Math.min(priorFloor,s.bars[j][3]);
  for(let j=i-16;j<=i-5;j++)if(s.bars[j][4]<s.bars[referenceLow][4])referenceLow=j;
  const oversoldRsi=clamp((55-(.55*lowestRsi+.45*rsi))/35);
  const drop5=clamp(-Math.min(weekly,earlierWeekly)/(2.1*Math.sqrt(5)*sigma));
  const drop10=clamp(-(log-s.logs[i-10])/(2.1*Math.sqrt(10)*sigma));
  const range=bar[2]-bar[3],closeLocation=range>0?clamp((c-bar[3])/range):.5;
  const rejection=clamp((c-bar[3])/atr)*clamp((closeLocation-.30)/.55);
  const reclaimAtr=(c-priorFloor)/atr, test=clamp(1-Math.max(0,bar[3]-priorFloor)/(1.5*atr));
  const reclaim=test*clamp((reclaimAtr+.05)/.85);
  const change=clamp(.3+(c-prev)/atr);
  const divergence=rsi-s.rsi[referenceLow];
  const retest=clamp(1-Math.abs(c-s.bars[referenceLow][4])/(3*atr));
  const acceleration=((log-s.logs[i-3])-(s.logs[i-3]-s.logs[i-6]))/(Math.sqrt(3)*sigma);
  const higher=Number(c>prev)+Number(prev>s.bars[i-2][4])+Number(s.bars[i-2][4]>s.bars[i-3][4]);
  const values=[
    100*location*(.25+.75*depth),
    100*context*(.45*oversoldRsi+.35*drop5+.20*drop10),
    100*context*(.40*rejection+.35*reclaim+.25*change),
    100*context*(.40*retest*clamp((divergence+1)/12)+.40*clamp(.40+acceleration/2)+.20*higher/3)
  ];
  const points=values.map((v,j)=>round(v*BOTTOM_PARTS[j][2]/100,3));
  const rawStrength=Math.round(points.reduce((sum,v)=>sum+v,0));
  const atrPct=round(100*atr/c,4);
  if(!details) {
    const observation={rawStrength,zone,atrPct};
    if(includeFeatures)observation.features=values.map(v=>round(v,3));
    return observation;
  }
  const inputs={
    drawdown252Pct:round(percent(-drop),2), location252Pct:round(100*year.position,2),location63Pct:round(100*quarter.position,2),
    location20Pct:round(100*month.position,2),atr14Pct:atrPct,low20DistanceAtr:round(low20,4),
    peak63DistanceAtr:round(priorPeak,4),rsi14:round(rsi,2),return5Pct:round(percent(weekly),2),closeLocationPct:round(100*closeLocation,2),
    lowReclaimAtr:round(reclaimAtr,3),rsiDivergence:round(divergence,2),returnAccelerationZ:round(acceleration,3),
    downside63Pct:round(100*Math.sqrt(Math.max(0,trailing(s.downside,i,63))*252/63),2)
  };
  return {date:bar[0],rawStrength,zone,components:bottomComponents(values.map(v=>round(v,3)),points,inputs),inputs};
}

function scan(candles,latestOnly,includeFeatures=false) {
  const count=Array.isArray(candles)?candles.length:0;
  const strengths=latestOnly?null:Array(count).fill(null),zones=latestOnly?null:Array(count).fill(null);
  const atrPcts=latestOnly?null:Array(count).fill(null);
  const features=includeFeatures?Array(count).fill(null):null;
  const start=latestOnly?Math.max(0,count-BOTTOM_MIN_BARS-1):0;
  let s=state(),previous=0,lastDate='',latest=null;
  for(let i=start;i<count;i++){
    const bar=candles[i],time=validBar(bar)?Date.parse(bar[0]+'T00:00:00Z'):NaN;
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==bar[0]){
      s=state();lastDate='';previous=0;continue;
    }
    if(bar[0]<=lastDate){
      s=state();lastDate=bar[0];previous=time;continue;
    }
    if(previous&&time-previous>21*dayMillis)s=state();
    lastDate=bar[0];previous=time;
    const final=i===count-1,output=append(s,bar,final,includeFeatures);
    if(final)latest=output;
    if(!latestOnly&&output){strengths[i]=output.rawStrength;zones[i]=output.zone;atrPcts[i]=final?output.inputs.atr14Pct:output.atrPct;}
    if(features&&output)features[i]=final?output.components.map(part=>part.score):output.features;
  }
  if(latestOnly)return latest;
  const tape={strengths,zones,atrPcts,latest};
  if(features)tape.features=features;
  return tape;
}
export function latestBottomStrength(candles){return scan(candles,true);}
export function buildBottomStrengthTape(candles,{features=false}={}){return scan(candles,false,features);}
