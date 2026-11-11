// web/ortho-clipmap.js (issue #36): the plan-to-canvas maths the shaders depend on. The invariants that matter are that a
// level's tiles cover its canvas exactly once (a gap is a hole in the ground, an overlap is a seam that doubles),
// that a tile landing on whole texels is what keeps the photograph sharp, that the wrap draws a tile that straddles the
// edge on both sides, and that a level's centre only moves in steps that divide every texel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_TILES, Clipmap, LEVELS, TILE_PX, clipRect, parseIndex, readLevels, rectOf, snap, tileM, tileUrl, tilesOf,
} from '../ortho-clipmap.js';

// What pipeline/s18_zagreb_ortho_tiles.py writes: seven levels, 256 px tiles, res 64 -> 1 m/px, tiles as [tx, tz].
function index(levels = [1, 2, 4], extra = {}) {
  return parseIndex({
    format: 'zagreb-ortho-tiles', tilePx: TILE_PX, origin: [459370.1, 5074937.5], bytes: 176390000,
    credit: 'City of Zagreb orthophoto', levels: [
      { level: 6, res: 1, tileM: 256, bytes: 100, tiles: [[0, 0], [-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1]] },
      { level: 5, res: 2, tileM: 512, bytes: 50, tiles: [[0, 0], [-1, 0]] },
      { level: 4, res: 4, tileM: 1024, bytes: 25, tiles: [[0, 0]] },
      ...levels.filter(r => ![1, 2, 4].includes(r)).map(r => ({ level: 0, res: r, tileM: TILE_PX * r, tiles: [] })),
    ],
    ...extra,
  }, '/data/ortho');
}

test('the three levels are 1, 2 and 4 m per pixel, four times the span and twice the texel of the last', () => {
  assert.deepEqual(LEVELS.map(l => l.res), [1, 2, 4]);
  for (let i = 1; i < LEVELS.length; i++) {
    assert.equal(LEVELS[i].span, LEVELS[i - 1].span * 4);
    assert.equal(LEVELS[i].px, LEVELS[i - 1].px * 2);
  }
  assert.deepEqual(LEVELS.map(l => tileM(l)), [256, 512, 1024]);
});

test('the index is read for what it says, and a build this module cannot read is refused', () => {
  const ix = index();
  assert.equal(ix.base, '/data/ortho/');
  assert.equal(ix.tilePx, 256);
  assert.equal(ix.levels.length, 3);
  assert.ok(ix.levels[0].keys.has('-1_-1'));
  assert.equal(ix.levels[0].level, 6);
  assert.throws(() => parseIndex({ format: 'something-else', levels: [] }), /not a zagreb-ortho-tiles index/);
  assert.throws(() => parseIndex({ format: 'zagreb-ortho-tiles', tilePx: 512, levels: [{ level: 0, res: 1, tiles: [] }] }),
    /tiles are 512 px/);
  // a ladder with no 1 m level cannot feed the finest clipmap level
  const noFine = parseIndex({ format: 'zagreb-ortho-tiles', tilePx: 256, levels: [{ level: 3, res: 8, tileM: 2048, tiles: [] }] });
  assert.throws(() => readLevels(noFine), /no 1 m\/px level/);
});

test('each level centre moves in its own step, which divides every texel and its tiles', () => {
  assert.deepEqual(LEVELS.map(l => l.snap), [64, 256, 1024]);
  const fine = LEVELS[0], mid = LEVELS[1], coarse = LEVELS[2];
  assert.deepEqual(snap(fine, 0, 0), { x: 0, z: 0 });
  assert.deepEqual(snap(fine, 31.9, -40), { x: 0, z: -64 });   // 31.9 is nearer 0 than 64, and -40 is nearer -64
  assert.deepEqual(snap(fine, 32, 32), { x: 64, z: 64 });
  assert.deepEqual(snap(mid, 100, 100), { x: 0, z: 0 });        // a quarter of a level-1 step moves nothing
  assert.deepEqual(snap(coarse, 600, 600), { x: 1024, z: 1024 });
  for (const level of LEVELS) {
    const texel = level.span / level.px;
    assert.equal(level.snap % texel, 0, `${level.res} m/px: a step is whole texels`);
    assert.equal(tileM(level) % level.snap, 0, `${level.res} m/px: a step divides a tile`);
    assert.equal(level.span % level.snap, 0, `${level.res} m/px: a step divides the span`);
  }
});

test('the tiles of a level cover its canvas exactly once, gap and overlap both zero', () => {
  for (const level of LEVELS) {
    for (const centre of [{ x: 0, z: 0 }, { x: 128, z: -64 }, { x: -3000, z: 2400 }]) {
      const tiles = tilesOf(level, centre);
      const rects = tiles.map(t => clipRect(level, centre, t.tx, t.tz)).filter(Boolean);
      // Row by row, the tiles' spans must tile [0, px) exactly: no gap (a hole in the ground) and no overlap (a seam
      // that doubles the light). The integer interval walk is the whole test: 2048 rows of at most nine spans each.
      for (let y = 0; y < level.px; y++) {
        const spans = rects.filter(r => r.y <= y && y < r.y + r.h).map(r => [r.x, r.x + r.w]).sort((a, b) => a[0] - b[0]);
        let edge = 0;
        for (const [x0, x1] of spans) {
          assert.equal(x0, edge, `${level.res} m/px, row ${y}: ${x0 - edge} px of gap or overlap`);
          edge = x1;
        }
        assert.equal(edge, level.px, `${level.res} m/px, row ${y}: the canvas is filled to its edge`);
      }
      // 2, 4 and 8 tiles across, so 4 to 81 tiles depending on how the centre falls inside a tile
      const perAxis = level.px / TILE_PX;
      assert.ok(tiles.length >= perAxis * perAxis && tiles.length <= (perAxis + 1) * (perAxis + 1), `${tiles.length} tiles`);
    }
  }
});

test('a tile lands on whole texels, and the one right of the centre sits in the right half', () => {
  const level = LEVELS[0];
  for (const centre of [{ x: 0, z: 0 }, { x: 192, z: -128 }]) {
    for (const { tx, tz } of tilesOf(level, centre)) {
      const r = rectOf(level, centre, tx, tz);
      assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), 'whole texels only');
      assert.equal(r.size, 256);
    }
  }
  assert.deepEqual(rectOf(level, { x: 0, z: 0 }, 0, 0), { x: 256, y: 256, size: 256 });
  assert.deepEqual(rectOf(level, { x: 0, z: 0 }, -1, 0), { x: 0, y: 256, size: 256 });
});

test('a tile at the level edge is clipped to the canvas, not wrapped, and never drawn twice', () => {
  const level = LEVELS[0];
  const centre = { x: 0, z: 0 };
  // a tile whose left edge is the canvas's right edge has none of it on the canvas
  assert.equal(clipRect(level, centre, 1, 0), null);
  // a tile hanging off the left by 128 texels keeps its right half, at the canvas's left
  assert.deepEqual(clipRect(level, { x: 128, z: 0 }, -1, 0), { sx: 128, sy: 0, x: 0, y: 256, w: 128, h: 256 });
  // a tile fully inside is copied 1:1
  assert.deepEqual(clipRect(level, centre, 0, 0), { sx: 0, sy: 0, x: 256, y: 256, w: 256, h: 256 });
});

test('a tile URL is the pipeline level folder and the tile index', () => {
  const ix = index(), levels = readLevels(ix);
  assert.equal(tileUrl(ix, levels[0], 12, -3), '/data/ortho/l6/12_-3.webp');
  assert.equal(tileUrl(ix, levels[2], -1, 5), '/data/ortho/l4/-1_5.webp');
});

// A canvas stub: records the blits instead of rasterising them.
function stubCanvas(w, h) {
  const blits = [];
  return { blits, canvas: { width: w, height: h }, ctx: {
    clearRect(x, y, cw, ch) { blits.push({ clear: [x, y, cw, ch] }); },
    drawImage(bmp, x, y, s) { blits.push({ bmp, x, y, s }); },
  } };
}

test('a level asks once for a tile it does not have, never for one the index says was not cut, and draws it on arrival', async () => {
  const ix = index();
  const canvases = [], waiting = new Map();
  const clipmap = new Clipmap({
    index: ix,
    makeCanvas: (w, h) => { const c = stubCanvas(w, h); canvases.push(c); return c; },
    load: url => new Promise((resolve, reject) => waiting.set(url, { resolve, reject })),
  });
  assert.equal(clipmap.levels.length, 3);
  clipmap.update(0, 0);
  // level 0 covers four tiles at the centre; the coarser levels cover four each but the index lists fewer of them
  const urls = [...waiting.keys()].filter(u => u.includes('/l6/'));
  assert.equal(urls.length, 4);
  assert.ok(urls.every(u => /\/l6\/-?[01]_-?[01]\.webp$/.test(u)), urls.join(' '));
  assert.equal(clipmap.stats.asked, 7, '4 fine + 2 of level 1 + 1 of level 2: only tiles the index lists');
  // a redraw at the same centre asks for nothing more, and one 64 m away asks only for what is missing
  const before = clipmap.stats.asked;
  clipmap.update(0, 0);
  assert.equal(clipmap.stats.asked, before);
  clipmap.update(64, 0);
  assert.ok(clipmap.stats.asked > before);
  // a tile that arrives while its level still shows it is blitted, and its bytes are counted
  const url = [...waiting.keys()].find(u => u.endsWith('/0_0.webp') && u.includes('/l6/'));
  const job = waiting.get(url);
  waiting.delete(url);
  job.resolve({ bmp: { id: 'tile' }, bytes: 9999 });
  await new Promise(r => setImmediate(r));
  assert.equal(clipmap.stats.loaded, 1);
  assert.equal(clipmap.stats.bytes, 9999);
  assert.ok(canvases[0].blits.some(b => b.bmp?.id === 'tile'), 'the arriving tile is blitted');
});

test('a tile that fails is remembered as failed, not asked for on every redraw', async () => {
  const waiting = new Map(), calls = [];
  const clipmap = new Clipmap({
    index: index(),
    makeCanvas: (w, h) => stubCanvas(w, h),
    load: url => { calls.push(url); return new Promise((resolve, reject) => waiting.set(url, { resolve, reject })); },
  });
  clipmap.update(0, 0);
  const url = calls.find(u => u.includes('/l6/'));
  waiting.get(url).reject(new Error('404'));
  await new Promise(r => setImmediate(r));
  assert.equal(clipmap.stats.failed, 1);
  const asked = calls.length;
  clipmap.update(64, 0);
  assert.ok(!calls.slice(asked).includes(url), 'the failed URL is never asked for again');
});

test('the bitmap cache keeps the newest tiles and lets go of the rest', () => {
  const clipmap = new Clipmap({ index: index(), makeCanvas: (w, h) => stubCanvas(w, h), load: () => new Promise(() => {}), cacheTiles: 2 });
  const closed = [];
  clipmap.remember('a', { close: () => closed.push('a') });
  clipmap.remember('b', { close: () => closed.push('b') });
  clipmap.remember('c', { close: () => closed.push('c') });
  assert.deepEqual([...clipmap.bitmaps.keys()], ['b', 'c']);
  assert.deepEqual(closed, ['a'], 'the evicted bitmap is released, not leaked');
  assert.ok(CACHE_TILES > 64, 'the default cache holds three levels of tiles at once');
});
