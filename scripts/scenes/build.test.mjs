import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENES, buildScene, parseCsv } from './build.mjs';

// The City of Zagreb, generous.
const BOX = { latMin: 45.70, latMax: 45.95, lonMin: 15.80, lonMax: 16.25 };
const inZagreb = (lat, lon) => lat >= BOX.latMin && lat <= BOX.latMax && lon >= BOX.lonMin && lon <= BOX.lonMax;

test('csv parser handles quotes, commas and doubled quotes', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [{ a: 'x, y', b: 'say "hi"' }]);
});

test('all 5 scenes parse', () => {
  assert.equal(Object.keys(SCENES).length, 5);
  for (const id of Object.keys(SCENES)) assert.ok(buildScene(id).beats.length > 0, id);
});

for (const id of Object.keys(SCENES)) {
  test(`${id}: beats are complete and in Zagreb`, () => {
    const s = buildScene(id);
    assert.ok(s.title.en && s.title.sv && Number.isInteger(s.year) && typeof s.sensitive === 'boolean');
    for (const b of s.beats) {
      const w = `${id} beat ${b.n}`;
      assert.ok(b.caption.en && b.caption.sv, `${w}: caption in both languages`);
      assert.ok(b.duration_s > 0, `${w}: positive duration`);
      assert.ok(inZagreb(b.camera.lat, b.camera.lon), `${w}: camera inside Zagreb`);
      assert.ok(inZagreb(b.target.lat, b.target.lon), `${w}: target inside Zagreb`);
      assert.ok(b.camera.height_m > 0, `${w}: camera above ground`);
    }
    for (const o of s.overlays ?? []) {
      if (o.type === 'ghost' && o.ship) continue;   // the Vasa rides the route
      const pts = o.type === 'route' ? o.coords : o.type === 'ghost' ? o.rings.flat() : [o.at];
      assert.ok(o.type !== 'route' || pts.length >= 2, `${id}: route has 2+ points`);
      for (const [lat, lon] of pts) assert.ok(inZagreb(lat, lon), `${id} ${o.type}: [${lat}, ${lon}] inside Zagreb`);
    }
  });
}

test('the three route stories have their line; every story has its markers', () => {
  for (const id of ['two-hills', 'green-horseshoe', 'across-the-sava']) {
    assert.equal(buildScene(id).overlays.filter((o) => o.type === 'route').length, 1, id);
  }
  for (const id of Object.keys(SCENES)) assert.ok(buildScene(id).overlays.filter((o) => o.type === 'marker').length >= 3, id);
  const always = buildScene('two-hills').overlays.filter((o) => o.always).map((o) => o.label.en).sort();
  assert.deepEqual(always, ['Gradec', 'Kaptol']);
});

test('only the finished stories are ready, in the index too', async () => {
  const { buildAll } = await import('./build.mjs');
  const ready = Object.entries(SCENES).filter(([, m]) => m.ready).map(([id]) => id).sort();
  assert.deepEqual(ready, ['across-the-sava', 'earthquake-1880', 'green-horseshoe', 'interwar-estates', 'two-hills']);
  assert.ok(buildAll);
});

test('layers: no Zagreb story forces a layer; an unknown layer fails the build', async () => {
  for (const id of Object.keys(SCENES)) assert.equal(buildScene(id).layers, undefined, id);
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-'));
  fs.mkdirSync(path.join(root, 'scenes', 'two-hills'), { recursive: true });
  for (const f of ['beats.csv', 'narration.csv']) fs.copyFileSync(path.join('scenes', 'two-hills', f), path.join(root, 'scenes', 'two-hills', f));
  SCENES['two-hills'].layers = ['trams'];
  try { assert.throws(() => buildScene('two-hills', root), /unknown layer\(s\) trams/); }
  finally { delete SCENES['two-hills'].layers; }
});

test('timeline_year: every beat carries its own year, never going back within a story', () => {
  assert.deepEqual(buildScene('earthquake-1880').beats.map((b) => b.year), [1880, 1880, 1882, 1886, 1902, 1914, 2026]);
  for (const id of Object.keys(SCENES)) {
    const ys = buildScene(id).beats.map((b) => b.year);
    assert.ok(ys.every((y, i) => Number.isInteger(y) && (!i || y >= ys[i - 1])), `${id}: ${ys}`);
  }
});

test('WKT polygons parse to [lat, lon] rings', async () => {
  const { parseWkt } = await import('./build.mjs');
  assert.deepEqual(parseWkt('POLYGON((15.97 45.81, 15.98 45.81, 15.98 45.82, 15.97 45.81))'), [[[45.81, 15.97], [45.81, 15.98], [45.82, 15.98], [45.81, 15.97]]]);
  assert.equal(parseWkt('MULTIPOLYGON(((18 59, 18.1 59, 18 59.1, 18 59)), ((18 59, 18.1 59, 18 59.1, 18 59)))').length, 2);
  assert.throws(() => parseWkt('to be traced'));
});

// ---------- Photos ----------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLicence, photoAuthor, resolvePhoto, addPhotos, USER_AGENT } from './build.mjs';

const lic = (code, name = code) => ({ License: { value: code }, LicenseShortName: { value: name } });

test('licence check: public domain, CC0, CC BY and CC BY-SA pass', () => {
  assert.deepEqual(checkLicence(lic('pd', 'Public domain')), { ok: true, licence: 'Public domain' });
  assert.equal(checkLicence(lic('cc0', 'CC0')).licence, 'CC0');
  assert.equal(checkLicence(lic('cc-by-2.5', 'CC BY 2.5')).licence, 'CC BY 2.5');
  assert.equal(checkLicence(lic('cc-by-sa-4.0', 'CC BY-SA 4.0')).licence, 'CC BY-SA 4.0');
});

test('licence check: NC, ND, GFDL-only, other and missing licences fail with a reason', () => {
  for (const code of ['cc-by-nc-2.0', 'cc-by-nd-4.0', 'cc-by-nc-sa-3.0', 'gfdl', 'fal', 'arr']) {
    const r = checkLicence(lic(code));
    assert.equal(r.ok, false, code);
    assert.match(r.reason, /not public domain/, code);
  }
  assert.match(checkLicence({}).reason, /no licence/);
});

test('author: HTML is stripped and "ingen uppgift" reads as unknown', () => {
  assert.equal(photoAuthor({ Artist: { value: '<a href="x">Johannes Scherman</a>' } }), 'Johannes Scherman');
  assert.equal(photoAuthor({ Artist: { value: 'ingen uppgift' } }), 'unknown author');
  assert.equal(photoAuthor({}), 'unknown author');
});

// A fake Commons: one file per licence; counts requests and checks they run one at a time with our User-Agent.
function fakeCommons(files) {
  const log = { calls: 0, active: 0, maxActive: 0, agents: new Set() };
  const fetchFn = async (url, init) => {
    log.calls++; log.active++; log.maxActive = Math.max(log.maxActive, log.active);
    log.agents.add(init?.headers?.['User-Agent']);
    await new Promise((r) => setTimeout(r, 5));
    log.active--;
    const u = new URL(url);
    if (u.hostname === 'commons.wikimedia.org') {
      const title = u.searchParams.get('titles').slice(5);
      const f = files[title];
      const pages = [f ? { title, imageinfo: [{ sha1: f.sha1, thumburl: `https://upload.example/${f.sha1}.jpg`, thumbwidth: 800, thumbheight: 600,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`, extmetadata: { ...lic(f.code, f.name), Artist: { value: f.artist } } }] } : { title, missing: true }];
      return new Response(JSON.stringify({ query: { pages } }));
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
  };
  return { fetchFn, log };
}

test('resolvePhoto: an open file is downloaded once into img/<sha1>.jpg; a refused one gets no photo and a reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-'));
  const { fetchFn, log } = fakeCommons({
    'Open.jpg': { sha1: 'a'.repeat(40), code: 'cc-by-sa-4.0', name: 'CC BY-SA 4.0', artist: 'A. Person' },
    'Closed.jpg': { sha1: 'b'.repeat(40), code: 'cc-by-nc-4.0', name: 'CC BY-NC 4.0', artist: 'B' },
  });
  const r = await resolvePhoto('Open.jpg', dir, fetchFn);
  assert.equal(r.photo.src, `img/${'a'.repeat(40)}.jpg`);
  assert.ok(fs.existsSync(path.join(dir, r.photo.src)));
  assert.deepEqual(r.photo.credit, { author: 'A. Person', licence: 'CC BY-SA 4.0', page: 'https://commons.wikimedia.org/wiki/File:Open.jpg', file: 'File:Open.jpg' });
  const calls = log.calls;
  await resolvePhoto('Open.jpg', dir, fetchFn);
  assert.equal(log.calls, calls + 1, 'cached: only the metadata is asked again');
  const no = await resolvePhoto('Closed.jpg', dir, fetchFn);
  assert.equal(no.photo, undefined);
  assert.match(no.reason, /CC BY-NC 4.0/);
  assert.match((await resolvePhoto('Missing.jpg', dir, fetchFn)).reason, /no such file/);
  assert.equal(log.maxActive, 1, 'one request at a time');
  assert.deepEqual([...log.agents], [USER_AGENT]);
});

test('addPhotos: the scene JSON carries src, caption and credit; refused files are dropped with a reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-'));
  const { fetchFn } = fakeCommons({ 'Open.jpg': { sha1: 'c'.repeat(40), code: 'pd', name: 'Public domain', artist: 'ingen uppgift' } });
  const scene = { id: 'x', beats: [
    { n: 1, photo_file: 'Open.jpg', photo_caption: { en: 'A stadium', sv: 'En arena' } },
    { n: 2, photo_file: 'Gone.jpg', photo_caption: { en: 'x', sv: 'x' } },
    { n: 3 },
  ] };
  const problems = await addPhotos(scene, dir, fetchFn);
  assert.deepEqual(scene.beats[0].photo.caption, { en: 'A stadium', sv: 'En arena' });
  assert.equal(scene.beats[0].photo.credit.author, 'unknown author');
  assert.equal(scene.beats[0].photo_file, undefined);
  assert.equal(scene.beats[1].photo, undefined);
  assert.deepEqual(problems, ['x beat 2: Gone.jpg: no photo, no such file on Commons']);
});

test('built scenes: every photo is a local image under web/scenes/img with caption, credit and an open licence', () => {
  for (const id of Object.keys(SCENES)) {
    const s = JSON.parse(fs.readFileSync(new URL(`../../web/scenes/${id}.json`, import.meta.url)));
    for (const b of s.beats) {
      if (!b.photo) continue;
      const w = `${id} beat ${b.n}`;
      assert.match(b.photo.src, /^img\/[0-9a-f]{40}\.(jpg|jpeg|png|gif|webp)$/, w);
      assert.ok(fs.existsSync(new URL(`../../web/scenes/${b.photo.src}`, import.meta.url)), `${w}: image file exists`);
      assert.ok(b.photo.caption.en && b.photo.caption.sv, `${w}: caption in both languages`);
      assert.ok(b.photo.credit.author, w);
      assert.match(b.photo.credit.licence, /^(Public domain|CC0|CC BY( |-SA |$))/, w);
      assert.match(b.photo.credit.page, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/, w);
    }
  }
});

test('the earthquake story: the cathedral damage beat shows the 1880 photo, the rebuild beat the card year 1902', () => {
  const s = JSON.parse(fs.readFileSync(new URL('../../web/scenes/earthquake-1880.json', import.meta.url)));
  assert.equal(s.beats[1].photo.credit.file, 'File:Zagreb Cathedral interior 1880.jpg');
  assert.equal(s.beats[1].photo.credit.licence, 'Public domain');
  assert.equal(s.beats[4].year, 1902);
  assert.match(s.beats[4].caption.en, /Bollé/);
  assert.ok(!/die|death|killed/i.test(s.beats.map((b) => b.caption.en).join(' ')), 'no deaths: the sources disagree on the count');
});

test('a ready story with fewer than 2 photo beats gets a warning, not an error', async () => {
  const { photoWarnings } = await import('./build.mjs');
  const beat = (photo) => ({ n: 1, ...(photo && { photo: { src: 'img/x.jpg' } }) });
  assert.equal(photoWarnings({ id: 'x', ready: true, beats: [beat(true), beat()] }).length, 1);
  assert.match(photoWarnings({ id: 'x', ready: true, beats: [beat()] })[0], /^warning: x is ready but only 0/);
  assert.deepEqual(photoWarnings({ id: 'x', ready: true, beats: [beat(true), beat(true)] }), []);
  assert.deepEqual(photoWarnings({ id: 'x', beats: [beat()] }), [], 'not ready: no warning');
  for (const id of Object.keys(SCENES)) {
    const s = JSON.parse(fs.readFileSync(new URL(`../../web/scenes/${id}.json`, import.meta.url)));
    assert.deepEqual(photoWarnings(s), [], `${id}: ready stories carry photos`);
  }
});
