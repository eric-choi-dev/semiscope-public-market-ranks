import {ENTRY_VERSION,ENTRY_MIN_BARS,ENTRY_HORIZONS,ENTRY_PHASES,ENTRY_PARTS,COMMON_FIELDS,HORIZON_FIELDS,
  buildLongEntryTape,latestLongEntry,makeEntryLeaf} from './long-entry-index.mjs';
import {factorValues,round,pressure} from './contrarian-entry-rules.mjs';

export const UNIFIED_VERSION=ENTRY_VERSION;
export const UNIFIED_MIN_BARS=ENTRY_MIN_BARS;
export const UNIFIED_HORIZONS=Object.freeze([...ENTRY_HORIZONS]);
const fields=[...COMMON_FIELDS,...HORIZON_FIELDS];
const limits={
  drawdown252Pct:[-100,0],rsi14:[0,100],
  return5Pct:[-100,Infinity],return21Pct:[-100,Infinity],newLowDays20:[0,20],closeLocationPct:[0,100],
  floorAge20:[0,19],upDays5:[0,5],rsiPressurePct:[0,100],rsiMemoryPct:[0,100],lowDistancePct:[0,Infinity]
};
const isHorizon=value=>value===126||value===252;
const bounded=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
function validDate(date){
  if(typeof date!=='string'||!/^\d{4}-\d\d-\d\d$/.test(date))return false;
  const t=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===date;
}

// The selected view retains the measurement's price, time and source metadata.
export function selectUnifiedHorizon(model,horizon=126) {
  horizon=Number(horizon);
  if(model?.version!==ENTRY_VERSION||!isHorizon(horizon))return null;
  const leaf=model.horizons?.[horizon]??(model.horizon===horizon?model:null);
  if(leaf?.version!==ENTRY_VERSION||leaf.date!==model.date||leaf.horizon!==horizon)return null;
  return model.horizon===horizon?model:{...model,...leaf};
}
export function latestUnifiedIndex(candles,horizon=126) {
  return selectUnifiedHorizon(latestLongEntry(candles),horizon);
}
export function buildUnifiedTape(candles,horizon=126) {
  horizon=Number(horizon);
  if(!isHorizon(horizon))return null;
  const tape=buildLongEntryTape(candles);
  return {...tape,...tape.horizons[horizon],horizon,latest:selectUnifiedHorizon(tape.latest,horizon)};
}

function decodePacket(packet,date,h) {
  if(!Array.isArray(packet)||packet.length!==11+fields.length||packet[0]!==5||!validDate(date)||
      !isHorizon(packet[1])||(h!==undefined&&Number(h)!==packet[1]))return null;
  for(const x of packet)if(!Number.isSafeInteger(x))return null;
  const [,horizon,score,phaseCode,ceiling,raw,percent]=packet,phase=ENTRY_PHASES[phaseCode];
  if(!phase||!bounded(score,0,100)||!bounded(raw,0,1000)||!bounded(percent,0,10000)||ceiling!==100)return null;
  const values=packet.slice(7,11).map(x=>x/10);
  if(values.some(x=>!bounded(x,0,100)))return null;
  const inputs={};
  for(const [i,name] of fields.entries()){
    const value=packet[11+i]/100;
    if(!bounded(value,...limits[name])||(['newLowDays20','floorAge20','upDays5'].includes(name)&&!Number.isInteger(value)))return null;
    inputs[name]=value;
  }
  if(round(pressure(inputs.rsi14))!==inputs.rsiPressurePct || inputs.rsiMemoryPct<inputs.rsiPressurePct ||
      factorValues(inputs).some((value,i)=>value!==values[i]))return null;
  const leaf=makeEntryLeaf(date,horizon,phase,ceiling,values,percent/100,inputs);
  return leaf.score===score&&Math.round(leaf.rawStrength*10)===raw?leaf:null;
}
export function decodeUnifiedResult(input,date,horizon) {
  if(Array.isArray(input))return decodePacket(input,date,horizon);
  if(!input||typeof input!=='object')return null;
  const half=decodePacket(input[126],date,126),year=decodePacket(input[252],date,252);
  if(!half||!year||input[126].some((value,i)=>i!==1&&value!==input[252][i]))return null;
  return selectUnifiedHorizon({...half,horizons:{126:half,252:year}},horizon??126);
}

function pack(model,horizon){
  const m=selectUnifiedHorizon(model,horizon);
  if(!m||!Array.isArray(m.components)||m.components.length!==4||!m.inputs)return null;
  const values=[];
  for(const [i,[key,,weight]] of ENTRY_PARTS.entries()){
    const part=m.components[i];
    if(part?.key!==key||part.weight!==weight||!Number.isFinite(part.score))return null;
    values.push(Math.round(10*part.score));
  }
  if(!fields.every(key=>Number.isFinite(m.inputs[key])))return null;
  const packet=[5,m.horizon,m.score,ENTRY_PHASES.indexOf(m.phase),m.ceiling,Math.round(10*m.rawStrength),
    Math.round(100*m.percentile),...values,...fields.map(key=>Math.round(100*m.inputs[key]))];
  const recovered=decodePacket(packet,m.date,horizon);
  return recovered&&recovered.uncappedScore===m.uncappedScore&&recovered.entryQualified===m.entryQualified?packet:null;
}
export function encodeUnifiedResult(model,horizon) {
  if(horizon!==undefined)return pack(model,Number(horizon));
  const half=pack(model,126),year=pack(model,252);
  if(!half||!year||half.some((value,i)=>i!==1&&value!==year[i]))return null;
  return {126:half,252:year};
}
