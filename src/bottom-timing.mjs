// Fixed, ex-ante entry rule. Its score measures price conditions at a close.
// A next-open purchase, forward lows and holding returns belong to evaluation.
export const BOTTOM_TIMING_VERSION='bottom-timing-1.0';
export const BOTTOM_TIMING_WEIGHTS=Object.freeze([55,30,15]);
export const BOTTOM_TIMING_LABELS=Object.freeze(['가격 조정 깊이','단기 매도 압력 완화','시장·위험 여건']);
const clamp01=x=>Math.max(0,Math.min(1,x));
const round=x=>Number(x.toFixed(3));
const sigmoidScore=z=>50+50*Math.tanh(z);
const positive=x=>Number.isFinite(x)&&x>0;

function validBar(bar,lastDate) {
  if(!Array.isArray(bar))return false;
  const [date,o,h,l,c]=bar;
  if(typeof date!=='string'||!/^\d{4}-\d\d-\d\d$/.test(date)||date<=lastDate||
    !positive(o)||!positive(h)||!positive(l)||!positive(c)||h<Math.max(o,c)||l>Math.min(o,c))return false;
  const t=Date.parse(date);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===date;
}

function observation(bars,i,factors,peak,range,location) {
  if(!Array.isArray(factors)||factors.length!==4||!factors.every(x=>Number.isFinite(x)&&x>=0&&x<=100))return null;
  const close=bars[i][4],c3=bars[i-3][4],c6=bars[i-6][4];
  const [dd,discount,resilience,risk]=factors;
  // Limit the opportunity score for a shallow dip, even when that dip is
  // uncommon in the stock's own history. The threshold is in log-price units.
  const depthScale=Math.max(.05,3*range);
  const activation=clamp01(Math.log(peak/close)/depthScale);
  const depth=(.60*dd+.40*discount)*activation;
  // Today's gap and range cannot inflate the volatility divisor used to
  // measure today's move. sqrt(6) scales the difference of two 3-day moves.
  const scale=Math.max(.005,range),recent=Math.log(close/c3),prior=Math.log(c3/c6);
  const moveZ=recent/(Math.sqrt(3)*scale);
  const accelerationZ=(recent-prior)/(Math.sqrt(6)*scale);
  const stabilization=.45*sigmoidScore(moveZ)+.35*sigmoidScore(accelerationZ)+20*location;
  const marketRisk=.55*resilience+.45*risk;
  const gate=.35+.65*depth/100;
  const points=[.55*depth,.30*gate*stabilization,.15*marketRisk];
  return {date:bars[i][0],score:Math.round(points[0]+points[1]+points[2]),
    depth:round(depth),stabilization:round(stabilization),marketRisk:round(marketRisk),
    gate:round(gate),points:points.map(round),inputs:{
      drawdownPct:round(100*(1-close/peak)),depthActivation:round(activation),
      rangeLogPct:round(100*range),scalePct:round(100*scale),depthThresholdLogPct:round(100*depthScale),
      recent3Pct:round(100*Math.expm1(recent)),prior3Pct:round(100*Math.expm1(prior)),
      moveZ:round(moveZ),accelerationZ:round(accelerationZ),closeLocationPct:round(100*location)
    }};
}

// A monotone deque tracks the trailing 252-session maximum close. Fixed
// rings hold the preceding 20 true log ranges and last three close locations.
// Broken input restarts the window. Outputs stay aligned with source dates.
function scan(tape,latestOnly) {
  const bars=tape?.candles,factors=tape?.factors;
  if(!Array.isArray(bars)||!Array.isArray(factors)||bars.length!==factors.length)return null;
  const start=latestOnly?Math.max(0,bars.length-253):0;
  const rows=latestOnly?null:Array(bars.length).fill(null);
  const highs=[],ranges=new Float64Array(20),locations=new Float64Array(3);
  let segment=0,head=0,rangeSum=0,lastDate='',latest=null;
  for(let i=start;i<bars.length;i++) {
    const bar=bars[i];
    if(!validBar(bar,lastDate)) {
      segment=0;head=0;highs.length=0;rangeSum=0;latest=null;
      continue;
    }
    const [date,,high,low,close]=bar;
    lastDate=date;
    const prev=segment?bars[i-1][4]:close;
    const trueRange=Math.max(Math.log(high/low),Math.abs(Math.log(high/prev)),Math.abs(Math.log(low/prev)));
    const slot=segment%20;
    const priorMean=segment>=20?rangeSum/20:null;
    if(segment>=20)rangeSum-=ranges[slot];
    ranges[slot]=trueRange;
    rangeSum+=trueRange;
    locations[segment%3]=high>low?clamp01((close-low)/(high-low)):.5;
    while(head<highs.length&&highs[head]<=i-252)head++;
    while(highs.length>head&&bars[highs.at(-1)][4]<=close)highs.pop();
    highs.push(i);
    segment++;
    if(segment<252||(latestOnly&&i!==bars.length-1))continue;
    const location=(locations[0]+locations[1]+locations[2])/3;
    latest=observation(bars,i,factors[i],bars[highs[head]][4],Math.max(0,priorMean),location);
    if(rows)rows[i]=latest;
  }
  return latestOnly?latest:{version:BOTTOM_TIMING_VERSION,weights:BOTTOM_TIMING_WEIGHTS,rows,latest};
}

/** Aligned with buildFactorTape's completed split-adjusted bars and four historical factors. */
export function buildBottomTimingTape(factorTape) {return scan(factorTape,false);}

/** Identical final score using at most 253 bars. Use this for cross-sectional rankings. */
export function latestBottomTiming(factorTape) {return scan(factorTape,true);}
