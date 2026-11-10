// The sun over Zagreb, from the clock: NOAA's solar position algorithm (the one behind the solar calculators), so the
// light on the map is the light the city actually has at that date and hour, not a fixed afternoon from the south-west.
//
// Pure arithmetic, no data and no network: an approximation good to about a tenth of a degree, well inside what a
// shading term needs. Tested by scripts/sun_check.mjs against values worked out by hand (noon elevation at Zagreb is
// 90 - 45.82 - declination).
//
// Coordinates: the map's local frame has x to the east, y up and z to the south (city.py's origin, local
// x = e - Ox, z = -(n - Oy)). Hence the sun vector is (east, up, -north).
const RAD = Math.PI / 180;

// The Julian century and the sun's apparent place, after Meeus chapter 25 as NOAA's spreadsheet uses it.
function apparentSun(ms) {
  const jd = ms / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + t * 0.0000001267 * t);
  const c = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTime = 4 * (y * Math.sin(2 * l0 * RAD) - 2 * e * Math.sin(m * RAD)
    + 4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD)
    - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m * RAD)) / RAD;   // minutes
  return { declination, eqTime };
}

// elevation and azimuth in degrees, azimuth counted clockwise from north. `offsetMinutes` is the clock's offset from
// UTC (60 for Croatian winter time, 120 for summer), the same for every hour of the day: the equation of time covers
// the rest.
export function solarPosition({ year, month, day, hour, minute = 0 }, lat, lon, offsetMinutes = 60) {
  const ms = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60000;
  const { declination, eqTime } = apparentSun(ms);
  const minutesUtc = hour * 60 + minute - offsetMinutes;
  const trueSolarTime = ((minutesUtc + eqTime + 4 * lon) % 1440 + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 - 180;
  const latR = lat * RAD;
  const decR = declination * RAD;
  const haR = hourAngle * RAD;
  const cosZenith = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = 90 - zenith / RAD;
  const cosAz = ((Math.sin(latR) * cosZenith) - Math.sin(decR)) / (Math.cos(latR) * Math.sin(zenith));
  let azimuth = Math.acos(Math.min(1, Math.max(-1, cosAz))) / RAD;
  azimuth = hourAngle > 0 ? (azimuth + 180) % 360 : (540 - azimuth) % 360;
  return { elevation, azimuth, declination };
}

// The direction towards the sun in the map's local frame: x east, y up, z south.
export function sunVector({ elevation, azimuth }) {
  const el = elevation * RAD;
  const az = azimuth * RAD;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

// Explicit Night, or Live after its sun has dropped below the city-lighting limit. Other modes keep their own light.
export const sunIsNight = (mode, elevation) => mode === 'night' || (mode === 'live' && elevation < 6);

// Zagreb, and the clock Croatia keeps: UTC+2 between the last Sunday of March and the last Sunday of October, UTC+1
// otherwise. (CET/CEST, the rule the country still follows.)
export const ZAGREB = { lat: 45.8150, lon: 15.9819 };

function lastSunday(year, month) {              // month 1-based; UTC day of the month
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - last.getUTCDay();
}

export function offsetMinutesFor(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 3), 1);          // 01:00 UTC, last Sunday of March
  const end = Date.UTC(y, 9, lastSunday(y, 10), 1);           // 01:00 UTC, last Sunday of October
  return date.getTime() >= start && date.getTime() < end ? 120 : 60;
}

// The sun now, or at a given Croatian wall clock time ("14:30") on a given date ("2026-10-29"), both optional.
export function sunFor({ date = null, clock = null, now = new Date() } = {}) {
  const stamp = date ? new Date(`${date}T12:00:00Z`) : now;
  const offset = offsetMinutesFor(date ? new Date(`${date}T00:00:00Z`) : now);
  const local = new Date(stamp.getTime() + offset * 60000);
  const [h, m] = clock ? clock.split(':').map(Number) : [local.getUTCHours(), local.getUTCMinutes()];
  const when = { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(), hour: h, minute: m };
  const pos = solarPosition(when, ZAGREB.lat, ZAGREB.lon, offset);
  return { ...pos, vector: sunVector(pos), when, offset };
}
