const eastern = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23'
});
// NYSE's published US cash equity calendar. The provider's actual session
// window is checked separately before any observation is used in a model.
// https://www.nyse.com/trade/hours-calendars
const holidays = new Set((
  '2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 ' +
  '2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 ' +
  '2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25'
).split(' '));
const early = new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
export function easternDateTime(timestamp) {
  const parts=Object.fromEntries(eastern.formatToParts(timestamp).map(({type,value})=>[type,value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour==='24'?'00':parts.hour}:${parts.minute}`;
}
export const sessionCloseTime = date => early.has(date) ? '13:00' : '16:00';
export const publishedCalendar = date => date >= '2026-01-01' && date <= '2028-12-31';
export function isTradingDay(date) {
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  return weekday > 0 && weekday < 6 && !holidays.has(date);
}
export function previousTradingDay(date) {
  let noon = Date.parse(date + 'T12:00:00Z');
  do {
    noon -= 86400000;
    date = new Date(noon).toISOString().slice(0,10);
  } while (!isTradingDay(date));
  return date;
}
export function marketClock(now = Date.now()) {
  const [day, time] = easternDateTime(now).split(' ');
  const isSession = isTradingDay(day), previousSessionDay = previousTradingDay(day);
  const close = sessionCloseTime(day);
  let phase = 'closed';
  if (isSession) {
    if (time < '09:30') phase = 'pre';
    else if (time < close) phase = 'regular';
    else if (time < close.slice(0,2) + ':15') phase = 'settling';
  }
  const expectedCloseDay = isSession && time >= close ? day : previousSessionDay;
  return {day, phase, isSession, previousSessionDay, expectedCloseDay};
}

export function completedSessionDay(now=Date.now()) {
  const {phase,previousSessionDay,expectedCloseDay}=marketClock(now);
  return phase==='settling'?previousSessionDay:expectedCloseDay;
}
