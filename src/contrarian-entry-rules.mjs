// Fixed before the v5 cross-security outcome study. Only completed or explicitly
// provisional current-session prices and their past are inputs.
export const ENTRY_PARTS = [
  ['depth','252거래일 고점 대비 낙폭',80],
  ['oversold','현재 RSI 과매도',8],
  ['oversoldMemory','최근 5거래일의 과매도',7],
  ['proximity','20거래일 저점과의 거리',5]
];
export const ENTRY_THRESHOLD = 80;
export const round = (value,scale=100) => Math.round(value*scale)/scale || 0;
const clamp = n => Math.max(0,Math.min(1,n));
export const pressure = rsi => 100*clamp((50-rsi)/30);
export const nearLow = distancePct => 100/(1+distancePct/12);
export const inEntryZone = score => Number.isInteger(score)&&score>=ENTRY_THRESHOLD&&score<=100;

// Wilder RSI(14) using the same finite 126-return history for charts, live
// quotes and batch replays. Seeding from the oldest 14 returns leaves 112
// Wilder updates. A fully flat window is neutral.
export function wilderRsi(changes,i) {
  const begin=i-125;
  let gain=0,loss=0;
  for(let j=begin;j<begin+14;j++){
    gain+=Math.max(0,changes[j]);loss+=Math.max(0,-changes[j]);
  }
  gain/=14;loss/=14;
  for(let j=begin+14;j<=i;j++){
    gain=(13*gain+Math.max(0,changes[j]))/14;
    loss=(13*loss+Math.max(0,-changes[j]))/14;
  }
  return gain+loss>0?100*gain/(gain+loss):50;
}
export function factorValues(inputs){
  return [-inputs.drawdown252Pct,inputs.rsiPressurePct,inputs.rsiMemoryPct,nearLow(inputs.lowDistancePct)]
    .map(value=>round(value,10));
}
export function weightedScore(values){
  return round(values.reduce((sum,value,i)=>sum+value*ENTRY_PARTS[i][2]/100,0),10);
}
