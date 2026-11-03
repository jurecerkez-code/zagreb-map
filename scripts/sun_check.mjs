// Holds web/sun.js to values that can be checked without it: the equinox noon elevation is 90 degrees minus the
// latitude, solar noon is due south, the azimuth runs east at morning and west at afternoon, and the sun is up between
// the published sunrise and sunset of Zagreb (Croatian almanac: 21 June about 05:02 and 20:52 CEST, 21 December about
// 07:33 and 16:07 CET).
import { solarPosition, sunFor, offsetMinutesFor, ZAGREB } from '../web/sun.js';

const near = (got, want, slack, what) => {
  const ok = Math.abs(got - want) <= slack;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got.toFixed(2)} (want ${want} +- ${slack})`);
  if (!ok) process.exitCode = 1;
};

// The equinox: declination is zero, so noon elevation is 90 - latitude = 44.18 degrees.
const eq = solarPosition({ year: 2026, month: 3, day: 20, hour: 12, minute: 7 }, ZAGREB.lat, ZAGREB.lon, 60);
near(eq.elevation, 90 - ZAGREB.lat, 0.6, 'equinox noon elevation');
near(eq.azimuth, 180, 1.5, 'equinox noon azimuth');
near(eq.declination, 0, 0.6, 'equinox declination');

// Morning: the sun is in the east half, afternoon: the west half.
const morning = solarPosition({ year: 2026, month: 6, day: 21, hour: 7, minute: 0 }, ZAGREB.lat, ZAGREB.lon, 120);
const afternoon = solarPosition({ year: 2026, month: 6, day: 21, hour: 18, minute: 0 }, ZAGREB.lat, ZAGREB.lon, 120);
near(morning.azimuth < 180 ? 1 : 0, 1, 0, 'morning sun in the east');
near(afternoon.azimuth > 180 ? 1 : 0, 1, 0, 'afternoon sun in the west');

// Sunrise and sunset on the longest day: the sun should be just below the horizon before 05:02 and just after 20:52.
const beforeSunrise = solarPosition({ year: 2026, month: 6, day: 21, hour: 4, minute: 50 }, ZAGREB.lat, ZAGREB.lon, 120);
const afterSunset = solarPosition({ year: 2026, month: 6, day: 21, hour: 21, minute: 5 }, ZAGREB.lat, ZAGREB.lon, 120);
// The almanac gives the moment the upper limb clears the horizon (refraction and the sun's own half a degree), which
// this calculation does not model: it returns the centre of the sun. So the almanac's minute is checked as a window,
// the sun below the horizon at it and up within ten minutes, not as an exact crossing.
const atSunrise = solarPosition({ year: 2026, month: 6, day: 21, hour: 5, minute: 2 }, ZAGREB.lat, ZAGREB.lon, 120);
const tenLater = solarPosition({ year: 2026, month: 6, day: 21, hour: 5, minute: 12 }, ZAGREB.lat, ZAGREB.lon, 120);
near(beforeSunrise.elevation < 0 ? 1 : 0, 1, 0, 'before sunrise the sun is below the horizon');
near(afterSunset.elevation < 0 ? 1 : 0, 1, 0, 'after sunset the sun is below the horizon');
near(atSunrise.elevation < 0.3 && tenLater.elevation > 0 ? 1 : 0, 1, 0, 'sunrise falls in the almanac window');

// The shortest day: the noon sun is low (90 - latitude + declination, about -21.5 degrees in December).
const winterNoon = solarPosition({ year: 2026, month: 12, day: 21, hour: 11, minute: 55 }, ZAGREB.lat, ZAGREB.lon, 60);
near(winterNoon.elevation, 90 - ZAGREB.lat - 23.44, 1.6, 'December noon elevation');

// The clock rule: summer and winter offsets.
near(offsetMinutesFor(new Date('2026-07-01T10:00:00Z')), 120, 0, 'July is UTC+2');
near(offsetMinutesFor(new Date('2026-01-15T10:00:00Z')), 60, 0, 'January is UTC+1');

// The vector points up and, at noon, has no northward component.
const noon = sunFor({ date: '2026-10-29', clock: '11:50' });
console.log('Zagreb, 29 Oct 2026 11:50:', `elevation ${noon.elevation.toFixed(1)}`, `azimuth ${noon.azimuth.toFixed(1)}`,
  'vector', noon.vector.map(v => v.toFixed(3)).join(', '));
near(noon.vector[1] > 0 ? 1 : 0, 1, 0, 'the sun vector points upwards');
near(Math.abs(noon.vector[0]) < 0.06 && noon.vector[2] > 0.8 ? 1 : 0, 1, 0,
  'at noon the vector points south (x ~ 0, z > 0)');
