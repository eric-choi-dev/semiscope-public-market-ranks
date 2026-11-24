// A causal, price-only entry index. No outcome labels or return probabilities are inputs.
export const ENTRY_VERSION = 'long-entry-index-3.0';
export const ENTRY_MIN_BARS = 504;
export const ENTRY_HORIZONS = [126,252];
export const ENTRY_PHASES = ['search','decline','response','extended'];
const phaseLabels = {search:'바닥 탐색',decline:'하락 진행',response:'저점 반응',extended:'회복 이격'};
export const ENTRY_PARTS = [
  ['depth','조정 깊이와 가격 위치',35], ['proximity','최근 저점과의 거리',20],
  ['response','저점 회복과 지지',30], ['stabilization','매도세 둔화',15]
];
export const COMMON_FIELDS = ['drawdown252Pct','downside63Pct','atr14Pct','rsi14','return5Pct','return21Pct','newLowDays20','closeLocationPct','rsiDivergence','accelerationZ'];
export const HORIZON_FIELDS = ['drawdownPct','rangePositionPct','localPositionPct','lowDistanceAtr','drawdownVol','responseEvidencePct'];
const clamp = value => Math.max(0,Math.min(1,value));
const q = (value,scale=100) => Math.round(value*scale)/scale || 0;
const pct = logReturn => 100*Math.expm1(logReturn);
const signed = n => (n>0?'+':'')+n.toFixed(1);
const DAY = 86400000;

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
      percentile=q(100*(lower+atOrBelow)/(2*252));
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
    return {hi,lo,position:hi>lo?clamp((today-lo)/(hi-lo)):.5};
  }
}
function newState() {
  return {bars:[],logs:[],rsi:[],squared:[0],down:[0],gains:[0],losses:[0],tr:[0],moves:[0],fresh:[0],
    ranges:[20,42,63,126,252].map(n=>new PriceRange(n)),ranks:[new PriorSetups(),new PriorSetups()]};
}
const sum = (a,i,n) => a[i+1]-a[i+1-n];

function observeBar(s,bar) {
  const i=s.bars.length,c=bar[4],log=Math.log(c),prev=s.bars[i-1]?.[4]??c,ret=log-(s.logs[i-1]??log);
  const oldWindow=s.ranges[0],prior20=s.logs[oldWindow.lo[oldWindow.lowHead]];
  s.bars.push(bar);s.logs.push(log);
  s.squared.push(s.squared[i]+ret*ret);s.down.push(s.down[i]+Math.min(0,ret)**2);
  s.gains.push(s.gains[i]+Math.max(0,c-prev));s.losses.push(s.losses[i]+Math.max(0,prev-c));
  s.tr.push(s.tr[i]+Math.max(bar[2]-bar[3],Math.abs(bar[2]-prev),Math.abs(bar[3]-prev)));
  s.moves.push(s.moves[i]+Number(c!==prev));s.fresh.push(s.fresh[i]+Number(Number.isFinite(prior20)&&log<prior20-1e-10));
  const gains=i>=14?sum(s.gains,i,14):0,losses=i>=14?sum(s.losses,i,14):0;
  const rsi=gains+losses>0?100*clamp(gains/(gains+losses)):50;
  s.rsi.push(rsi);
  const windows=s.ranges.map(range=>range.update(s.logs,i));
  if(i<251||sum(s.moves,i,63)<21)return null;
  const atr=sum(s.tr,i,14)/14;
  if(!(atr>0))return null;
  const variance=Math.max(0,(sum(s.squared,i-1,63)-(s.logs[i-1]-s.logs[i-64])**2/63)/62);
  const noise=Math.max(.004,Math.sqrt(variance),.55*Math.log1p(atr/c));
  const z=(n,end=i)=>(s.logs[end]-s.logs[end-n])/(noise*Math.sqrt(n));
  const z1=z(1),z3=z(3),z5=z(5),z21=z(21),accel=z3-z(3,i-3),atrLog=Math.log1p(atr/c);
  const newLows=sum(s.fresh,i,20),clv=bar[2]>bar[3]?clamp((c-bar[3])/(bar[2]-bar[3])):.5;
  const higher=Number(c>prev)+Number(prev>s.bars[i-2][4])+Number(s.bars[i-2][4]>s.bars[i-3][4]);
  let reference=i-4,oldFloor=Infinity;
  for(let j=i-21;j<=i-4;j++){
    if(s.logs[j]<s.logs[reference])reference=j;
    oldFloor=Math.min(oldFloor,s.bars[j][3]);
  }
  const recentFloor=Math.min(bar[3],s.bars[i-1][3],s.bars[i-2][3]);
  const floorMove=Math.log(recentFloor/oldFloor)/noise,nearReference=clamp(1-Math.abs(log-s.logs[reference])/(4*noise));
  const divergence=rsi-s.rsi[reference],div=nearReference*clamp(divergence/13);
  const higherLow=clamp((floorMove+.1)/1.15)*clamp(1-Math.max(0,floorMove-1.5)/4)*clamp(.45+.5*z3);
  const rejection=clamp((clv-.25)/.65)*clamp((c-bar[3])/atr)*clamp(.60+.45*z1);
  const rebound=clamp((z3+.08)/1.35);
  const support=clamp(.28*rejection+.32*higherLow+.27*rebound+.13*div);
  const slow=clamp(.32*clamp(.40+accel/1.8)+.24*clamp(1-newLows/9)+.22*div+.22*higher/3);
  const todayBreak=log<Math.min(...s.logs.slice(i-4,i))-1e-10;
  const weakening=z5<-.55&&z21<-.75;
  const fall=(newLows>=6&&z5<-.32)||(weakening&&(todayBreak||z1<-.55))||(z3<-1.3&&z1<-.45);
  const defended=(higherLow>=.38&&higher>=2)||(rebound>=.45&&higher>=2)||(rejection>=.54&&z1>=.12)||
    (div>=.55&&accel>.05&&higher>=1);
  const common={drawdown252Pct:q(pct(log-windows[4].hi)),downside63Pct:q(100*Math.sqrt(Math.max(0,sum(s.down,i,63))*4)),
    atr14Pct:q(100*atr/c),rsi14:q(rsi),return5Pct:q(pct(log-s.logs[i-5])),return21Pct:q(pct(log-s.logs[i-21])),
    newLowDays20:newLows,closeLocationPct:q(100*clv),rsiDivergence:q(divergence),accelerationZ:q(accel)};
  return {log,noise,atrLog,windows,newLows,z1,z3,z5,z21,fall,defended,support,slow,common};
}

// Each horizon uses its own slow price range and an independently ranked setup
// history. All dimensionless distances scale with that security's own volatility.
function setup(day,h) {
  const longer=h===252,range=day.windows[longer?4:3],mid=day.windows[longer?3:2],local=day.windows[longer?1:0];
  const drawdown=range.hi-day.log,lowDistance=day.log-local.lo;
  const drawdownVol=drawdown/(day.noise*Math.sqrt(longer?42:21));
  const meaningful=clamp(drawdown/Math.max(longer?.055:.035,2.5*day.noise));
  const depth=meaningful*(.46*(1-range.position)+.23*(1-mid.position)+.31*(-Math.expm1(-drawdownVol)));
  const proximity=meaningful*Math.exp(-lowDistance/((longer?6:4)*day.noise))*(.65+.35*(1-local.position));
  const context=meaningful*clamp(.3+.9*Math.sqrt(depth*proximity));
  const values=[depth,proximity,context*(.18+.82*day.support),context*(.18+.82*day.slow)].map(x=>q(100*x,10));
  const rawStrength=q(values.reduce((total,x,j)=>total+x*ENTRY_PARTS[j][2]/100,0),10);
  const nearHigh=drawdown<Math.max(longer?.04:.025,1.25*day.noise);
  const extended=lowDistance>(longer?7.5:5)*day.noise&&local.position>.53;
  const falling=(day.fall&&(!day.defended||day.z3<-.60))||(day.z3<-1.65&&day.z5<-1.1)||
    (day.newLows>=12&&day.z5<-.25);
  let phase='search',ceiling=79;
  if(nearHigh||extended){
    phase='extended';
    ceiling=nearHigh?Math.round(12+20*clamp(drawdown/Math.max(.055,3*day.noise))):
      Math.round((longer?48:40)+16*depth);
  }else if(falling){
    phase='decline';
    // An inexpensive position can still have value for a patient holder. The
    // 1-year ceiling gives depth more room, without declaring an active reversal.
    ceiling=Math.round((longer?54:48)+14*depth);
  }else if(meaningful>=.55&&day.defended&&(day.support>=.33||day.slow>=.64)&&proximity>=.28){
    phase='response';ceiling=100;
  }
  const inputs={...day.common,drawdownPct:q(pct(-drawdown)),rangePositionPct:q(100*range.position),
    localPositionPct:q(100*local.position),lowDistanceAtr:q(lowDistance/day.atrLog),drawdownVol:q(drawdownVol),
    responseEvidencePct:q(100*day.support)};
  return {rawStrength,phase,ceiling,values,inputs};
}

function phaseReason(phase,inputs) {
  switch(phase){
    case 'extended': return '최근 고점과 가깝거나 최근 저점에서 이미 반등해 신규 진입 가격의 여유가 줄었습니다.';
    case 'decline': return '단기 하락 속도와 새 저점을 점검했습니다. 최근 20거래일 중 '+inputs.newLowDays20+'일에 직전 20일 최저 종가를 갱신했습니다.';
    case 'response': return '조정 구간에서 저점 회복, 높아진 저점 또는 가격과 RSI의 반전 신호가 나타났습니다.';
    default: return '가격의 조정 정도를 반영했습니다. 저점 지지와 매도세 둔화가 함께 나타나는지 확인하는 구간입니다.';
  }
}

export function makeEntryLeaf(date,horizon,phase,ceiling,values,percentile,inputs) {
  const reasons=[
    horizon+'일 최고 종가에서 '+signed(inputs.drawdownPct)+'%, 해당 기간 로그 가격 범위의 하단 '+inputs.rangePositionPct.toFixed(1)+'%에 있습니다.',
    '최근 '+(horizon===126?20:42)+'일 최저 종가와의 거리는 로그 가격 기준 '+inputs.lowDistanceAtr.toFixed(2)+' ATR입니다.',
    '당일 종가의 고저 범위 내 위치는 '+inputs.closeLocationPct.toFixed(1)+'%, 종가 회복·저점 재시험을 합친 반응 강도는 '+inputs.responseEvidencePct.toFixed(1)+'점입니다.',
    '직전 비교 저점 대비 RSI 변화는 '+signed(inputs.rsiDivergence)+'포인트입니다. 최근 20일 중 20일 최저 종가를 새로 기록한 날은 '+inputs.newLowDays20+'일입니다.'
  ];
  const components=ENTRY_PARTS.map(([key,label,weight],j)=>({key,label,weight,score:values[j],points:q(values[j]*weight/100,1000),reason:reasons[j]}));
  const rawStrength=q(values.reduce((sum,value,j)=>sum+value*ENTRY_PARTS[j][2]/100,0),10);
  const uncappedScore=Math.round(.8*rawStrength+.2*percentile),score=Math.min(ceiling,uncappedScore);
  return {version:ENTRY_VERSION,date,horizon,score,phase,phaseLabel:phaseLabels[phase],phaseReason:phaseReason(phase,inputs),
    label:phaseLabels[phase],entryQualified:phase==='response'&&score>=80,rawStrength,percentile,ceiling,uncappedScore,components,inputs};
}

function horizonSeries(n) {
  return Object.fromEntries(['scores','phases','entryQualified','rawStrengths','percentiles'].map(k=>[k,Array(n).fill(null)]));
}

function scan(candles,latestOnly) {
  const n=Array.isArray(candles)?candles.length:0;
  const horizons=latestOnly?null:{126:horizonSeries(n),252:horizonSeries(n)};
  const start=latestOnly?Math.max(0,n-ENTRY_MIN_BARS-1):0;
  let state=newState(),lastDate=NaN,latest=null;
  for(let i=start;i<n;i++){
    const bar=candles[i],date=dateNumber(bar);
    if(!Number.isFinite(date)||date<=lastDate){
      state=newState();lastDate=date;continue;
    }
    if(date-lastDate>21*DAY)state=newState();
    lastDate=date;
    const day=observeBar(state,bar),final=i===n-1,leaves={};
    for(const [j,h] of ENTRY_HORIZONS.entries()){
      const raw=day?setup(day,h):null;
      const percentile=state.ranks[j].observe(raw?Math.round(10*raw.rawStrength):null);
      if(percentile===null)continue;
      if(final)leaves[h]=makeEntryLeaf(bar[0],h,raw.phase,raw.ceiling,raw.values,percentile,raw.inputs);
      if(!latestOnly){
        const tape=horizons[h],score=Math.min(raw.ceiling,Math.round(.8*raw.rawStrength+.2*percentile));
        tape.scores[i]=score;tape.phases[i]=raw.phase;tape.entryQualified[i]=raw.phase==='response'&&score>=80;
        tape.rawStrengths[i]=raw.rawStrength;tape.percentiles[i]=percentile;
      }
    }
    if(final&&leaves[126]&&leaves[252])latest={...leaves[126],horizons:leaves};
  }
  return latestOnly?latest:{version:ENTRY_VERSION,horizons,latest};
}
export function buildLongEntryTape(candles){return scan(candles,false);}
export function latestLongEntry(candles){return scan(candles,true);}
