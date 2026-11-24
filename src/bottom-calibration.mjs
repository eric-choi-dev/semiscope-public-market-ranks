import data from './bottom-calibration-data.json' with {type:'json'};
export const CALIBRATION_VERSION = 'bottom-calibration-1.0';
export const BOTTOM_MODEL_VERSION = 'bottom-probability-2.0';
export const BOTTOM_TARGET_ID = 'capped-40-v1';
export const CALIBRATION = data;

export function probabilityFromVintage(raw, asOf, vintages = data.vintages, atrPct=null) {
  if (!Number.isInteger(raw) || raw<0 || raw>100 || typeof asOf!=='string' || !/^\d{4}-\d\d-\d\d$/.test(asOf)) return null;
  const vintage = vintages.findLast(v => v.date <= asOf);
  if (!vintage?.bins?.length || vintage.through >= asOf) return null;
  const hurdle = Number.isFinite(atrPct) ? (atrPct < 2.5 ? 'floor5' : atrPct < 8 ? 'twoAtr' : 'highAtr') : null;
  const subset = hurdle && vintage.hurdles?.[hurdle];
  const bin=(subset?.bins??vintage.bins).find(b=>raw>=b.low && raw<=b.high);
  if (!bin) return null;
  return {probability:Math.round(bin.rate),rate:bin.rate,n:bin.n,wins:bin.wins,ci95:bin.ci95,group:'pooled',
    vintage:vintage.date,through:vintage.through,baselinePct:vintage.base.rate,blockCount:bin.blockCount,
    tickerCount:bin.tickerCount,low:bin.low,high:bin.high,hurdle:subset?hurdle:'pooled',
    atr20Support:vintage.highVolSupport?.above20??null,
    greenEligible:raw>=70 && bin.n>=120 && bin.blockCount>=8 && bin.rate>=vintage.base.rate+5};
}
export function calibrateBottomStrength(rawStrength,asOf,assetClass='stock',atrPct=null) {
  // A single leveraged ticker cannot establish a transferable leveraged-specific model.
  return (data.targetId===BOTTOM_TARGET_ID?probabilityFromVintage(rawStrength,asOf,data.vintages,atrPct):null) ?? {probability:null,rate:null,n:0,wins:0,ci95:null,group:'pooled',
    vintage:null,through:null,baselinePct:null,blockCount:0,tickerCount:0,low:null,high:null,hurdle:null,greenEligible:null};
}
