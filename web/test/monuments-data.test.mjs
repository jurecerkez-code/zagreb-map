// Issue #31, audited against the data the page actually ships: every one of the records is drawable (a mesh, no
// exception) and every photo and year it claims is complete. The counts are checked against the report committed
// beside the data, so a record can never gain a photo, a year or a lost field without the report and this test moving
// together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.core.js';
import { makeMonuments, KINDS, FIGURE_VARIANTS } from '../monuments.js';

const dir = fileURLToPath(new URL('../data/v20261103-fix/', import.meta.url));
const photos = fileURLToPath(new URL('../data/photos/', import.meta.url));
const records = JSON.parse(readFileSync(dir + 'monuments.json', 'utf8'));
const report = JSON.parse(readFileSync(dir + 'monuments_report.json', 'utf8'));

test('the record set is the issue’s 421 unique monuments, each of a kind the map draws', () => {
  assert.equal(records.length, 421);
  assert.equal(new Set(records.map(r => r.id)).size, 421);
  for (const r of records) {
    assert.ok(KINDS.includes(r.kind), `${r.id}: unknown kind ${r.kind}`);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.z), `${r.id}: no position`);
    assert.ok(r.h > 0 && r.h < 40, `${r.id}: implausible height ${r.h}`);
    if (r.kind === 'statue' || r.kind === 'bust') {
      assert.ok(FIGURE_VARIANTS[r.kind], `${r.id}: no figure variants for ${r.kind}`);
    }
  }
});

test('every monument gets a drawn instance at the default (foto) and the arg look, inside the triangle budget', () => {
  for (const look of ['foto', 'arg']) {
    const layer = makeMonuments(THREE, {
      list: records,
      uniforms: { uYear: { value: 2026 }, uSun: {}, uFog: {}, uFogColor: {} },
      surfaceAt: () => 12, camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, look: () => look, yearMax: 2026,
    });
    layer.place();
    const meshes = layer.group.children.filter(m => m.isInstancedMesh);
    assert.ok(meshes.length > 0, `${look}: no mesh`);
    let instances = 0, triangles = 0;
    for (const mesh of meshes) {
      instances += mesh.count;
      triangles += mesh.count * (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
    }
    assert.equal(instances, records.length, `${look}: a record has no mesh`);
    assert.ok(triangles < 150_000, `${look}: ${triangles} triangles at home`);
  }
});

test('every claimed photo is a licensed file on disk, within the card’s byte budget, with its credit', () => {
  const withPhoto = records.filter(r => r.photo);
  for (const r of withPhoto) {
    const p = r.photo;
    assert.match(p.key, /^[0-9a-f]{16}-\d+\.jpg$/, `${r.id}: odd photo key ${p.key}`);
    const file = photos + p.key;
    const size = statSync(file).size;
    assert.ok(size > 10_000 && size <= 400_000, `${r.id}: ${p.key} is ${size} bytes`);
    assert.ok(p.by && p.lic, `${r.id}: no credit for ${p.key}`);
    // A public-domain or CC0 file has a licence name and no deed URL; every CC BY(-SA) licence carries its deed.
    if (p.lic.startsWith('CC BY')) assert.match(p.lu || '', /^https?:\/\/(www\.)?creativecommons\.org\//, `${r.id}: no licence URL`);
    assert.match(p.page, /^https:\/\/(commons\.wikimedia\.org|hr\.wikipedia\.org)\//, `${r.id}: no source page`);
  }
  assert.equal(withPhoto.length, report.after.all.photo);
});

test('every claimed year has a source, a quote of at most 15 words and a link to it', () => {
  const dated = records.filter(r => r.year);
  for (const r of dated) {
    assert.ok(Number.isInteger(r.year) && r.year > 1000 && r.year <= 2026, `${r.id}: year ${r.year}`);
    assert.ok(r.ysrc, `${r.id}: ${r.year} with no source`);
    assert.ok(r.yquote && r.yquote.trim(), `${r.id}: ${r.year} with no quote`);
    assert.ok(r.yquote.trim().split(/\s+/).length <= 15, `${r.id}: quote too long`);
    assert.match(r.yurl || '', /^https?:\/\//, `${r.id}: no link to ${r.ysrc}`);
  }
  assert.equal(dated.length, report.after.all.year);
  assert.equal(report.verification.year_quotes_max_words <= 15, true);
});

test('the committed report’s counts are the counts in the data, gaps included', () => {
  const { after, before, remaining_gaps: gaps } = report;
  const photo = records.filter(r => r.photo).length;
  const year = records.filter(r => r.year).length;
  const sb = records.filter(r => r.kind === 'statue' || r.kind === 'bust');
  assert.deepEqual([after.all.entries, after.all.photo, after.all.year], [records.length, photo, year]);
  assert.equal(before.all.entries, records.length);
  assert.ok(before.all.photo < photo && before.all.year < year, 'a fix that adds nothing is not a fix');
  assert.deepEqual([after.statues_and_busts.entries, after.statues_and_busts.photo, after.statues_and_busts.year],
    [sb.length, sb.filter(r => r.photo).length, sb.filter(r => r.year).length]);
  assert.equal(gaps.no_photo_count, records.length - photo);
  assert.equal(gaps.empty_year_count, records.length - year);
  assert.equal(gaps.no_photo_entries.length, gaps.no_photo_count);
  assert.equal(gaps.empty_year_entries.length, gaps.empty_year_count);
  const ids = new Set(records.map(r => r.id));
  const gapIds = [...gaps.no_photo_entries, ...gaps.empty_year_entries].map(e => e.id);
  assert.equal(gapIds.length, gaps.no_photo_count + gaps.empty_year_count);
  for (const id of gapIds) assert.ok(ids.has(id), `${id} is a gap but not a monument`);
  assert.equal(new Set(gaps.no_photo_entries.map(e => e.id)).size, gaps.no_photo_count);
  assert.equal(new Set(gaps.empty_year_entries.map(e => e.id)).size, gaps.empty_year_count);
});
