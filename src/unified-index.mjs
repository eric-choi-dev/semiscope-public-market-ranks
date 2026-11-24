// A fixed price-based entry rubric for a single purchase evaluated over 126–252 sessions.
// Each value depends only on this instrument's split-adjusted regular-session OHLC.
// Cross-sectional ranks, ticker names and future returns never enter the calculation.
export const UNIFIED_VERSION = 'unified-entry-1.0';
export const UNIFIED_MIN_BARS = 252;
const specifications = [
  ['pullback', '가격 조정', 30],
  ['stabilization', '매도세 완화', 25],
  ['momentum', '중기 가격 추세', 25],
  ['downside', '하방 위험', 20]
];

const round = (value, digits = 2) => Number(value.toFixed(digits)) + 0;
const signed = value => (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(1);
const pctChange = logReturn => 100 * Math.expm1(logReturn);
const directional = standardized => 50 + 50 * Math.tanh(standardized);
const pct = value => value.toFixed(1) + '%';

function classify(score) {
  if (score >= 80) return '매수 여건 강함';
  if (score >= 65) return '매수 여건 우호';
  if (score >= 45) return '신호 혼재';
  if (score >= 30) return '진입 신중';
  return '매수 여건 취약';
}

function validBar(bar) {
  if (!Array.isArray(bar)) return false;
  const [date, open, high, low, close] = bar;
  if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) ||
      ![open, high, low, close].every(x => Number.isFinite(x) && x > 0)) return false;
  // Some issuers round individual OHLC fields to different decimal places.
  const epsilon = high * 1e-7;
  return high + epsilon >= Math.max(low, open, close) && low - epsilon <= Math.min(open, close);
}

// A finite geometric kernel keeps the ordinary EMA convention but discards a
// small, explicitly defined tail. Latest-only and historical replay then need
// exactly the same window, regardless of the provider's history start date.
function finiteEMA(span, periods) {
  const alpha = 2 / (span + 1), decay = 1 - alpha, tail = decay ** periods;
  const buffer = new Float64Array(periods);
  let index = 0, size = 0, total = 0;
  return value => {
    total = decay * total + alpha * (value - tail * buffer[index]);
    buffer[index] = value;
    index = (index + 1) % periods;
    size++;
    return size >= periods ? total / (1 - tail) : null;
  };
}

function newWindow() {
  return {
    candles: [], logs: [], peaks: [], head: 0,
    squared: [0], downside: [0], up: [0], down: [0], active: [0],
    fast: finiteEMA(12, 78), slow: finiteEMA(26, 78), signal: finiteEMA(9, 27)
  };
}

const trailing = (prefix, end, periods) => prefix[end + 1] - prefix[end + 1 - periods];

function cutlerRSI(state, i) {
  const up = trailing(state.up, i, 14), down = trailing(state.down, i, 14);
  return up + down > 0 ? 100 * up / (up + down) : 50;
}

function appendBar(s, bar, details) {
  const i = s.logs.length, price = bar[4], logPrice = Math.log(price);
  const previous = i ? s.candles[i - 1][4] : price;
  const move = i ? logPrice - s.logs[i - 1] : 0, difference = price - previous;
  s.candles.push(bar);
  s.logs.push(logPrice);
  s.squared.push(s.squared[i] + move * move);
  s.downside.push(s.downside[i] + Math.min(0, move) ** 2);
  s.up.push(s.up[i] + Math.max(0, difference));
  s.down.push(s.down[i] + Math.max(0, -difference));
  s.active.push(s.active[i] + Number(price !== previous));
  while (s.head < s.peaks.length && s.peaks[s.head] <= i - 252) s.head++;
  while (s.peaks.length > s.head && s.logs[s.peaks.at(-1)] <= logPrice) s.peaks.pop();
  s.peaks.push(i);
  const fast = s.fast(logPrice), slow = s.slow(logPrice);
  const macd = fast === null ? null : fast - slow;
  const signal = macd === null ? null : s.signal(macd);
  if (i + 1 < UNIFIED_MIN_BARS || trailing(s.active, i, 63) < 21) return null;

  // Today's return stays out of the volatility unit used to judge today's surprise.
  const net63 = s.logs[i - 1] - s.logs[i - 64];
  const variance = Math.max(0, (trailing(s.squared, i - 1, 63) - net63 ** 2 / 63) / 62);
  const sigma = Math.max(0.006, Math.sqrt(variance));
  const peakGap = Math.max(0, s.logs[s.peaks[s.head]] - logPrice);
  const depth = 100 * Math.tanh(peakGap / Math.max(.04, Math.sqrt(21) * sigma));

  const weekly = logPrice - s.logs[i - 5], histogram = macd - signal;
  const rsi = cutlerRSI(s, i), rsiChange = rsi - cutlerRSI(s, i - 5);
  const stabilization = .35 * directional(weekly / (Math.sqrt(5) * sigma)) +
    .35 * directional(histogram / (.45 * sigma)) +
    .15 * directional((rsi - 45) / 20) + .15 * directional(rsiChange / 15);

  // Skip the recent month in medium-term momentum to avoid counting the
  // same 5-day reversal twice. The two lookbacks capture half- and full-year paths.
  const halfYear = s.logs[i - 21] - s.logs[i - 126];
  const fullYear = s.logs[i - 21] - s.logs[i - 251];
  const momentum = .60 * directional(halfYear / (Math.sqrt(105) * sigma)) +
    .40 * directional(fullYear / (Math.sqrt(230) * sigma));
  // A large drawdown contributes less while both stabilization and the older
  // price trend are weak. It cannot turn persistent distress into a top score by itself.
  const pullback = depth * (.40 + .60 * Math.max(stabilization, momentum) / 100);

  // Annualized lower partial deviation uses all sessions, also on upside-only paths.
  // Compare 21 recent sessions against the preceding, disjoint 63-session window.
  const downside = Math.sqrt(Math.max(0, trailing(s.downside, i, 63)) * 252 / 63);
  const recentRisk = Math.sqrt(Math.max(0, trailing(s.downside, i, 21)) / 21);
  const earlierRisk = Math.sqrt(Math.max(0, trailing(s.downside, i - 21, 63)) / 63);
  const riskRatio = recentRisk / Math.max(.004, earlierRisk);
  const risk = 65 / (1 + (downside / .30) ** 2) + 35 / (1 + (riskRatio / 1.5) ** 2);

  // Round contributions at the same precision for every consumer, including replays.
  const values = [pullback, stabilization, momentum, risk];
  const points = values.map((value, j) => round(value * specifications[j][2] / 100, 3));
  const score = Math.round(points.reduce((sum, value) => sum + value, 0));
  if (!details) return score;
  const inputs = {
    drawdown252Pct: round(pctChange(-peakGap)), priorVolatility63Pct: round(Math.sqrt(252 * variance) * 100),
    return5Pct: round(pctChange(weekly)), rsi14: round(rsi), rsiChange5: round(rsiChange),
    macdHistogramLogPct: round(100 * histogram, 4),
    momentum126Skip21Pct: round(pctChange(halfYear)), momentum251Skip21Pct: round(pctChange(fullYear)),
    downside63Pct: round(100 * downside), downsideRatio: round(riskRatio, 3)
  };
  return formatResult(bar[0], score, values.map(value => round(value, 3)), points, inputs);
}

function formatResult(date, score, values, points, inputs) {
  const reasons = [
    '252거래일 최고 종가 대비 ' + signed(inputs.drawdown252Pct) + '%. 평소 변동폭과 반등·추세 강도를 함께 반영했습니다.',
    '5거래일 수익률 ' + signed(inputs.return5Pct) + '%, 단순평균 RSI(14)는 ' + inputs.rsi14.toFixed(1) +
      ' (' + signed(inputs.rsiChange5) + 'p), 로그 가격 MACD 히스토그램은 ' + signed(inputs.macdHistogramLogPct) + '%입니다.',
    '최근 21거래일을 제외한 반년 구간 수익률은 ' + signed(inputs.momentum126Skip21Pct) +
      '%, 1년 구간은 ' + signed(inputs.momentum251Skip21Pct) + '%입니다.',
    '63거래일 연율 하방편차 ' + pct(inputs.downside63Pct) + '. 최근 21일의 하방 변동은 앞선 63일 대비 ' +
      inputs.downsideRatio.toFixed(2) + '배입니다.'
  ];
  return {
    version: UNIFIED_VERSION, date, score, label: classify(score), inputs,
    components: specifications.map(([key, label, weight], j) =>
      ({key, label, score: values[j], weight, points: points[j], reason: reasons[j]}))
  };
}

function scan(candles, latestOnly) {
  const length = Array.isArray(candles) ? candles.length : 0;
  const scores = latestOnly ? null : Array(length).fill(null);
  // One extra observation establishes ordering at the left edge of the window.
  const start = latestOnly ? Math.max(0, length - UNIFIED_MIN_BARS - 1) : 0;
  let state = newWindow(), previousDate = '', previousTime = 0, latest = null;
  for (let i = start; i < length; i++) {
    const bar = candles[i];
    const time = validBar(bar) ? Date.parse(bar[0] + 'T00:00:00Z') : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== bar[0]) {
      previousDate = ''; previousTime = 0;
      state = newWindow();
      continue;
    }
    if (bar[0] <= previousDate) {
      previousDate = bar[0]; previousTime = time;
      state = newWindow();
      continue;
    }
    if (previousTime && time - previousTime > 21 * 86_400_000) state = newWindow();
    previousDate = bar[0]; previousTime = time;
    const final = i === length - 1;
    const output = appendBar(state, bar, final);
    if (final) latest = output;
    if (scores) scores[i] = final ? output?.score ?? null : output;
  }
  return latestOnly ? latest : {version: UNIFIED_VERSION, scores, latest};
}

/** Return null until 252 valid bars and at least 21 moving closes in the last 63. */
export function latestUnifiedIndex(candles) { return scan(candles, true); }

/** Integer scores align one-for-one with input dates, with nulls before eligibility. */
export function buildUnifiedTape(candles) { return scan(candles, false); }

// Packet format 1 carries integer-scaled inputs and factor scores. The
// public ranking's as-of date supplies the common date for every packet.
const packetInputs = [
  ['drawdown252Pct', 100, -100, 0], ['priorVolatility63Pct', 100, 0, Infinity],
  ['return5Pct', 100, -100, Infinity], ['rsi14', 100, 0, 100], ['rsiChange5', 100, -100, 100],
  ['macdHistogramLogPct', 10000, -Infinity, Infinity],
  ['momentum126Skip21Pct', 100, -100, Infinity], ['momentum251Skip21Pct', 100, -100, Infinity],
  ['downside63Pct', 100, 0, Infinity], ['downsideRatio', 1000, 0, Infinity]
];

/** Losslessly serialize the shared result at its published precision. */
export function encodeUnifiedResult(result) {
  if (result?.version !== UNIFIED_VERSION || result.components?.length !== 4 || !result.inputs) return null;
  const factors = [], points = [];
  for (const [j, [key, , weight]] of specifications.entries()) {
    const part = result.components[j];
    if (part?.key !== key || part.weight !== weight ||
        !Number.isFinite(part.score) || !Number.isFinite(part.points)) return null;
    factors.push(Math.round(part.score * 1000));
    points.push(Math.round(part.points * 1000));
  }
  // Rounded scores and rounded weighted points are kept independently:
  // a value at a rounding boundary may differ by a thousandth of a point.
  if (packetInputs.some(([key]) => !Number.isFinite(result.inputs[key]))) return null;
  const inputs = packetInputs.map(([key, scale]) => Math.round(result.inputs[key] * scale));
  const packet = [1, result.score, ...factors, ...points, ...inputs];
  return decodeUnifiedResult(packet, result.date) ? packet : null;
}

/** Decode a rank row's packet to the same UI object as a direct symbol lookup. */
export function decodeUnifiedResult(packet, date) {
  if (!Array.isArray(packet) || packet.length !== 20 || packet[0] !== 1 ||
      packet[1] < 0 || packet[1] > 100 ||
      typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date)) return null;
  for (const item of packet) if (!Number.isSafeInteger(item)) return null;
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  const values = [], points = [];
  for (let j = 0; j < 4; j++) {
    const raw = packet[2 + j], weighted = packet[6 + j], weight = specifications[j][2];
    // A raw component rounded to 0.001 can move its rounded contribution by
    // at most half a millipoint plus its own weighted rounding error.
    if (raw < 0 || raw > 100000 || weighted < 0 || weighted > weight * 1000 ||
        Math.abs(weighted * 100 - raw * weight) > 50 + weight / 2) return null;
    values.push(raw / 1000); points.push(weighted / 1000);
  }
  if (packet[1] !== Math.round(points.reduce((sum, x) => sum + x, 0))) return null;
  const inputs = {};
  for (const [j, [key, scale, min, max]] of packetInputs.entries()) {
    const value = packet[10 + j] / scale;
    if (value < min || value > max) return null;
    inputs[key] = value;
  }
  return formatResult(date, packet[1], values, points, inputs);
}
