// The same forward-independent rubric is used for all securities. Recovery to a
// trailing high and scaled upside variation measure room, not an expected return.
const unit = value => Math.max(0, Math.min(1, value));
const logDouble = Math.log(2);

export function reboundSetup(day, horizon) {
  const year = horizon === 252;
  const range = day.windows[year ? 4 : 3], local = day.windows[year ? 1 : 0];
  const drawdown = range.hi - day.log, distance = day.log - local.lo;
  const drawdownVol = drawdown / (day.noise * Math.sqrt(year ? 42 : 21));
  const meaningful = unit(drawdown / Math.max(year ? .055 : .035, 2.5 * day.noise));
  const priceRoom = unit(drawdown / logDouble);
  const swingRoom = unit(1.5 * day.upsideDaily * Math.sqrt(horizon) / logDouble);
  const nearLow = Math.exp(-distance / ((year ? 7 : 5) * day.noise));
  const depth = meaningful * (.58 * priceRoom + .22 * (1 - range.position) + .20 * -Math.expm1(-drawdownVol));
  const potential = meaningful * nearLow * (.40 + .60 * swingRoom);
  const context = meaningful * unit(.30 + .85 * Math.sqrt((1-range.position) * nearLow));
  const response = context * (.12 + .58 * day.support + .30 * Number(day.confirmed));
  const stability = context * (.65 * day.slow + .35 * unit(.5 + day.meanTurnZ / 2));

  const nearHigh = drawdown < Math.max(year ? .04 : .025, 1.25 * day.noise);
  const extended = distance > (year ? 8 : 6) * day.noise && local.position > .56;
  let phase = 'search', ceiling = year ? 66 : 64;
  if (nearHigh) {
    phase = 'extended';
    ceiling = Math.round(12 + 20 * unit(drawdown / Math.max(.055, 3 * day.noise)));
  } else if (day.falling) {
    phase = 'decline';
    // Depth earns some credit; continuing new lows and falling short averages
    // take it back. A one-day bounce does not remove this ceiling.
    ceiling = Math.round(42 + (year ? 16 : 14) * depth - 8 * day.pressure);
  } else if (extended) {
    phase = 'extended';
    ceiling = Math.round((year ? 48 : 40) + 16 * depth);
  } else if (day.confirmed && meaningful >= .55 && nearLow >= .28) {
    phase = 'response';
    ceiling = 100;
  }
  return {phase, ceiling, factors:[depth, potential, response, stability],
    drawdown, drawdownVol, distance, range, local, swingRoom};
}
