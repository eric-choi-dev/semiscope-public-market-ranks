import {BOTTOM_MIN_BARS, BOTTOM_INPUTS, BOTTOM_PARTS, bottomComponents, buildBottomStrengthTape, latestBottomStrength} from './bottom-strength.mjs';
import {BOTTOM_MODEL_VERSION, calibrateBottomStrength} from './bottom-calibration.mjs';

export const UNIFIED_VERSION = BOTTOM_MODEL_VERSION;
export const UNIFIED_MIN_BARS = BOTTOM_MIN_BARS;

const structural = Object.freeze({
  probability: 0, rate: null, n: 0, wins: 0, ci95: null, group: 'structural',
  vintage: null, through: null, baselinePct: null, blockCount: 0, tickerCount: 0,
  low: null, high: null, greenEligible: false
});

// Zone membership is itself part of the named future event. Outside the zone
// the event is impossible by definition; inside it, only prior matured outcomes
// may supply a probability. The feature sum measures strength, not likelihood.
function resultFromRaw(raw) {
  if (!raw) return null;
  const calibration = raw.zone ? calibrateBottomStrength(raw.rawStrength, raw.date, 'pooled', raw.inputs.atr14Pct) : structural;
  const probability = calibration.probability;
  const label = !raw.zone ? '저점권 조건 밖' : probability === null ? '과거 표본 부족' : '저점권 반등 확률';
  return {version: UNIFIED_VERSION, ...raw, probability, score: probability, label,
    greenEligible: calibration.greenEligible, calibration};
}

export function latestUnifiedIndex(candles) {
  return resultFromRaw(latestBottomStrength(candles));
}

export function buildUnifiedTape(candles) {
  const {strengths, zones, atrPcts, latest} = buildBottomStrengthTape(candles);
  const scores = new Array(zones.length).fill(null);
  const green = new Array(zones.length).fill(null);
  for (let i = 0; i < zones.length; i++) {
    if (zones[i] === null) continue;
    const calibration = zones[i] ? calibrateBottomStrength(strengths[i], candles[i][0], 'pooled', atrPcts[i]) : structural;
    scores[i] = calibration.probability;
    green[i] = calibration.greenEligible;
  }
  return {version: UNIFIED_VERSION, scores, green, rawStrengths: strengths, zones, latest: resultFromRaw(latest)};
}

const packetType = 2;
const fieldCount = BOTTOM_PARTS.length;
const inputOffset = 4 + 2 * fieldCount;

export function encodeUnifiedResult(result) {
  if (result?.version !== UNIFIED_VERSION || !Number.isInteger(result.score) ||
      result.score !== result.probability || typeof result.zone !== 'boolean' ||
      result.components?.length !== fieldCount || !result.inputs) return null;
  const factors = [], points = [];
  for (const [j, [key, , weight]] of BOTTOM_PARTS.entries()) {
    const part = result.components[j];
    if (part?.key !== key || part.weight !== weight || !Number.isFinite(part.score) || !Number.isFinite(part.points)) return null;
    factors.push(Math.round(part.score * 1000));
    points.push(Math.round(part.points * 1000));
  }
  if (!BOTTOM_INPUTS.every(([key]) => Number.isFinite(result.inputs[key]))) return null;
  const inputs = BOTTOM_INPUTS.map(([key, scale]) => Math.round(result.inputs[key] * scale));
  const packet = [packetType, result.score, result.rawStrength, Number(result.zone), ...factors, ...points, ...inputs];
  return decodeUnifiedResult(packet, result.date) ? packet : null;
}

export function decodeUnifiedResult(packet, date) {
  if (!Array.isArray(packet) || packet.length !== inputOffset + BOTTOM_INPUTS.length || packet[0] !== packetType ||
      packet[1] < 0 || packet[1] > 100 || packet[2] < 0 || packet[2] > 100 ||
      (packet[3] !== 0 && packet[3] !== 1) || typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date)) return null;
  for (const value of packet) if (!Number.isSafeInteger(value)) return null;
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  const values = [], points = [];
  for (const [j, [, , weight]] of BOTTOM_PARTS.entries()) {
    const raw = packet[4+j], weighted = packet[4+fieldCount+j];
    if (raw < 0 || raw > 100000 || weighted < 0 || weighted > weight * 1000 ||
        Math.abs(weighted * 100 - raw * weight) > 50 + weight / 2) return null;
    values.push(raw / 1000);
    points.push(weighted / 1000);
  }
  if (packet[2] !== Math.round(points.reduce((sum, p) => sum + p, 0))) return null;
  const inputs = {};
  for (const [j, [key, scale, min, max]] of BOTTOM_INPUTS.entries()) {
    const value = packet[inputOffset+j] / scale;
    if (value < min || value > max) return null;
    inputs[key] = value;
  }
  const zone = Boolean(packet[3]);
  // Published distances are rounded to four decimals. Values precisely on the
  // displayed threshold can lie on either side at calculation precision.
  const distanceLimit = Math.min(1,8 / inputs.atr14Pct);
  if (zone && (inputs.low20DistanceAtr > distanceLimit + .0001 || inputs.peak63DistanceAtr < 2)) return null;
  if (!zone && inputs.low20DistanceAtr < distanceLimit - .0001 && inputs.peak63DistanceAtr > 2) return null;
  const model = resultFromRaw({date, rawStrength: packet[2], zone, components: bottomComponents(values, points, inputs), inputs});
  return model.score === packet[1] ? model : null;
}
