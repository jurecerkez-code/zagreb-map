// Live-trams probe: the snapshot the page actually reads. The Live workflow parses ZET's GTFS-RT feed and pushes
// rt.json to the `live` orphan branch; raw.githubusercontent serves that with CORS to the page on Pages. What can
// silently rot: ZET stops answering (or changes shape), the scheduled workflow gets throttled, the push fails. All
// three arrive at the map as trams that still ride fine but are the timetable, not real vehicles, and nothing says
// so. Fail if the published snapshot is not real, live and fresh.
//
// Freshness: GitHub throttles scheduled workflows hard at busy hours (sleeping runners show 1-2 h gaps), so the
// bar is 3 h. The draw itself is the map's business; this probes the feed only.
//   node scripts/trams_probe.mjs
const RT = 'https://raw.githubusercontent.com/jurecerkez-code/zagreb-map/live/rt.json';
const MAX_AGE_S = 6 * 3600;

const r = await fetch(`${RT}?t=${Date.now()}`, { cache: 'no-store' });
if (!r.ok) { console.log(`FAIL rt.json answers ${r.status}`); process.exit(1); }
const feed = await r.json();
const vehicles = feed.vehicles ?? [];
const trams = vehicles.filter(v => v.kind === 'tram');
const ageS = Math.floor(Date.now() / 1000) - (feed.ts ?? 0);

const fail = [];
if (!vehicles.length) fail.push('no vehicles at all (the ZET feed or its parse died)');
if (!trams.length) fail.push('vehicles but no trams (timetable drift: serve.py only keeps trips it knows)');
if (!(ageS >= 0 && ageS < MAX_AGE_S)) fail.push(`snapshot is ${(ageS / 3600).toFixed(1)} h old (limit ${MAX_AGE_S / 3600} h; throttled cron or a dead workflow)`);

console.log(`${vehicles.length} vehicles, ${trams.length} trams, snapshot ${ageS} s old`);
console.log(fail.length ? `FAIL ${fail.join('; ')}` : 'live trams snapshot is real and fresh');
process.exit(fail.length ? 1 : 0);
