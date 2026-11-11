// The orthophoto clipmap (issue #36): real photograph tiles from the pipeline's quadtree, laid into three canvases the
// terrain and roof shaders sample. No three.js here, so node --test can drive the maths (web/test/ortho-clipmap.test.mjs).
//
// Why a clipmap: the city is 41 km wide and the photograph is 1.17 m/px, so one texture is out of the question and a
// single level is either mush up close or a blur of 20 MB. Three levels, each four times the last one's span and twice
// its texel, cover 512 m at 1 m/px, 2 km at 2 m/px and 8 km at 4 m/px for 21 MB of texture: the near ground keeps the
// photograph's own detail, the far city keeps its pattern, and everything beyond 8 km keeps the sampled mean colour.
//
// Why a wrapping canvas: a level's picture repeats every `span` metres, so following the camera is only a matter of
// where tiles are drawn, never of re-cutting a rectangle out of a bigger image (the texture is RepeatWrapping, and
// `uv = (world - centre) / span + 0.5` is all the shader needs). The level's centre snaps to SNAP_M metres, which
// divides every level's texel and every tile, so a tile always lands on whole texels: filtering never blurs a tile
// into its neighbour. The canvas is filled exactly once (the plan's tiles cover it, and a tile at the edge is clipped
// to it) and is a torus only in how it is sampled — canvas x = px is x = 0, which is what carries the photograph
// across its own edge without a seam when the camera crosses the level's boundary.
//
// Every tile is fetched and decoded once (web/ortho-worker.js) and kept as an ImageBitmap; a level redraw is a handful
// of drawImage calls from that cache, and a tile that arrives mid-flight is blitted into its own slot alone.

// The three levels: span in metres, canvas side in pixels, and the pipeline level each one reads (res m/px). A level's
// centre snaps to its own `snap` — a tenth of its span, which is always a whole number of its texels and a divisor of its
// tiles — so following a moving camera redraws the small level often and the big one rarely, instead of re-uploading
// 21 MB of canvas for every 64 m of travel.
export const LEVELS = Object.freeze([
  { span: 512, px: 512, res: 1, snap: 64 },
  { span: 2048, px: 1024, res: 2, snap: 256 },
  { span: 8192, px: 2048, res: 4, snap: 1024 },
]);
// A tile is TILE_PX texels of its level (pipeline/s18_zagreb_ortho_tiles.py TILE_PX): 256, 512 and 1024 m here.
export const TILE_PX = 256;
// Bitmaps kept decoded across levels; the wanted set is 84 tiles, so this only holds on to what is still in view.
export const CACHE_TILES = 200;

export const texelM = level => level.span / level.px;
export const tileM = level => TILE_PX * texelM(level);

// The index (web/data/ortho/index.json, pipeline/s18_zagreb_ortho_tiles.py): the pyramid's levels and which tiles of
// each exist. Everything the client needs to avoid asking for a tile that was never cut.
export function parseIndex(doc, base = '') {
  if (!doc || doc.format !== 'zagreb-ortho-tiles' || !Array.isArray(doc.levels) || !doc.levels.length) {
    throw new Error('ortho index: not a zagreb-ortho-tiles index');
  }
  if (!Number.isSafeInteger(doc.tilePx) || doc.tilePx !== TILE_PX) {
    throw new Error(`ortho index: tiles are ${doc.tilePx} px, this build reads ${TILE_PX}`);
  }
  const levels = doc.levels.map(l => {
    if (!(l.res > 0) || !Array.isArray(l.tiles) || !Number.isSafeInteger(l.level)) {
      throw new Error(`ortho index: level ${l.level} has no tiles`);
    }
    return {
      level: l.level, res: l.res, tileM: l.tileM ?? TILE_PX * l.res, bytes: l.bytes ?? 0,
      keys: new Set(l.tiles.map(([tx, tz]) => `${tx}_${tz}`)),
    };
  });
  return { base: base.endsWith('/') ? base : `${base}/`, tilePx: doc.tilePx, origin: doc.origin,
    bytes: doc.bytes ?? 0, credit: doc.credit ?? '', levels };
}

// The clipmap's three levels paired with the index levels that hold their tiles, deepest first. A build whose
// resolution ladder is not 1/2/4 m per pixel is not something these three levels can read.
export function readLevels(index) {
  return LEVELS.map((spec, at) => {
    const found = index.levels.find(l => Math.abs(l.res - spec.res) < 1e-9);
    if (!found) throw new Error(`ortho index: no ${spec.res} m/px level for clipmap level ${at}`);
    if (found.tileM !== TILE_PX * spec.res) throw new Error(`ortho index: ${spec.res} m/px tiles are ${found.tileM} m`);
    return { ...spec, at, index: found };
  });
}

// The centre a level is drawn around: its own snap, so every tile lands on whole texels of the canvas.
export function snap(level, x, z) {
  return { x: Math.round(x / level.snap) * level.snap, z: Math.round(z / level.snap) * level.snap };
}

// The tiles a level needs to fill its canvas around `centre`, half-open ([x0, x1) covers exactly the span): 2 or 3
// across per axis, 4 to 9 tiles, and their union is the canvas with no gap and no overlap.
export function tilesOf(level, centre) {
  const t = tileM(level), half = level.span / 2;
  const x0 = centre.x - half, z0 = centre.z - half, x1 = centre.x + half, z1 = centre.z + half;
  const out = [];
  for (let tz = Math.floor(z0 / t); tz * t < z1; tz++) {
    for (let tx = Math.floor(x0 / t); tx * t < x1; tx++) out.push({ tx, tz, key: `${tx}_${tz}` });
  }
  return out;
}

// Where a tile lands on the canvas, in pixels: {x, y, size}. Whole numbers whenever the centre is snapped, which is
// what keeps a level free of sub-texel blur. x and y can be negative or past the canvas: a tile at the level's edge
// hangs off it, and `clipRect` keeps the part that is on it.
export function rectOf(level, centre, tx, tz) {
  const t = tileM(level), px = level.px;
  return {
    x: Math.round((tx * t - centre.x) / level.span * px + px / 2),
    y: Math.round((tz * t - centre.z) / level.span * px + px / 2),
    size: TILE_PX,
  };
}

// The part of a tile's rect that is on the canvas, with where it starts inside the tile, or null if none of it is.
// Every tile of the level is drawn exactly once, and the tiles the plan gives fill the canvas exactly once: the canvas
// is a torus only in how it is sampled (RepeatWrapping, so canvas x = px is x = 0), never in how it is filled.
export function clipRect(level, centre, tx, tz) {
  const r = rectOf(level, centre, tx, tz), px = level.px;
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(px, r.x + r.size), y1 = Math.min(px, r.y + r.size);
  if (x1 <= x0 || y1 <= y0) return null;
  return { sx: x0 - r.x, sy: y0 - r.y, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The tile's URL under the index's base: l<level>/<tx>_<tz>.webp, exactly as s18 writes them.
export function tileUrl(index, level, tx, tz) {
  return `${index.base}l${level.index.level}/${tx}_${tz}.webp`;
}

// The GLSL both shaders include (app.js FRAG and TERRAIN_FRAG). Sampling is by plan position: the orthophoto is
// orthorectified, so the roof at (x, z) was photographed at (x, z) and a wall reads its own footprint's ground.
// The levels nest, so compositing fine over coarse leaves the coarse level showing only past the fine one's edge, and
// the coarsest level's own edge fades to coverage 0 (the caller's mean colour, which is the old foreground).
// texture() is called unconditionally on all three levels, out of uniform control flow (uClipOn gates the callers):
// the tiles have no mipmaps, so their implicit derivatives select nothing and a level boundary cannot shimmer.
export const CLIPMAP_GLSL = /* glsl */`
  uniform sampler2D uClip0, uClip1, uClip2;
  uniform vec2 uClipC0, uClipC1, uClipC2;
  uniform float uClipS0, uClipS1, uClipS2;
  uniform float uClipOn;
  // How much of a level shows at m metres from its centre: all of it inside 90% of the span, then out to nothing.
  float clipRim(float m, float span) { return 1.0 - smoothstep(span * 0.45, span * 0.5, m); }
  // The photographed colour at plan position w: alpha is coverage, 0 where there is no tile (water, a neighbouring
  // municipality, outside the mosaic) and so the caller keeps its mean colour there.
  vec4 orthoAt(vec2 w) {
    vec2 d0 = w - uClipC0, d1 = w - uClipC1, d2 = w - uClipC2;
    vec4 c0 = texture(uClip0, d0 / uClipS0 + 0.5);
    vec4 c1 = texture(uClip1, d1 / uClipS1 + 0.5);
    vec4 c2 = texture(uClip2, d2 / uClipS2 + 0.5);
    float a2 = c2.a * clipRim(length(d2), uClipS2);
    vec4 out_ = vec4(c2.rgb, a2);
    float a1 = c1.a * clipRim(length(d1), uClipS1);
    out_ = vec4(mix(out_.rgb, c1.rgb, a1), max(out_.a, a1));
    float a0 = c0.a * clipRim(length(d0), uClipS0);
    out_ = vec4(mix(out_.rgb, c0.rgb, a0), max(out_.a, a0));
    return out_;
  }
`;

// The clipmap itself: three canvases, the centre each was drawn around, and the decoded bitmaps every level shares.
// makeCanvas(w, h) returns {canvas, ctx} (document.createElement in app.js, a stub in a test); load(url) resolves with
// {bmp, bytes} (the worker in app.js). update() is called with the camera's plan position and returns whether any level
// redrew; the caller then marks that level's texture for upload.
export class Clipmap {
  constructor({ index, makeCanvas, load, cacheTiles = CACHE_TILES }) {
    this.index = index;
    this.load = load;
    this.cacheTiles = cacheTiles;
    this.bitmaps = new Map();       // 'at/tx_tz' -> ImageBitmap, oldest first
    this.flying = new Set();        // URLs asked for and not yet answered
    this.failed = new Set();        // URLs that 404'd or would not decode: asked once, not every frame
    this.wanted = new Set();
    this.stats = { asked: 0, loaded: 0, bytes: 0, failed: 0 };
    this.levels = readLevels(index).map(level => {
      const { canvas, ctx } = makeCanvas(level.px, level.px);
      return { ...level, canvas, ctx, cx: null, cz: null, dirty: false, tex: null };
    });
  }

  // Move the levels to a plan position. A level only redraws when its own snapped centre changed: walking 64 m inside a
  // level costs nothing, and a level is at most its tiles of drawImage calls from the bitmap cache.
  update(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const moved = [];
    for (const level of this.levels) {
      const c = snap(level, x, z);
      if (c.x === level.cx && c.z === level.cz) continue;
      level.cx = c.x;
      level.cz = c.z;
      moved.push(level);
    }
    if (!moved.length) return false;
    this.refreshWanted();
    for (const level of moved) {
      this.drawLevel(level);
      level.dirty = true;
    }
    return true;
  }

  // The tiles the three levels need where they stand now: what an arriving bitmap is checked against before it is
  // drawn (a level that has moved on ignores a tile it no longer shows).
  refreshWanted() {
    this.wanted.clear();
    for (const level of this.levels) {
      for (const t of tilesOf(level, { x: level.cx, z: level.cz })) this.wanted.add(`${level.at}/${t.key}`);
    }
  }

  // A level's canvas, filled from whatever of its tiles is decoded; the rest are asked for once and drawn when they
  // arrive. Returns nothing: `dirty` tells the caller to re-upload.
  drawLevel(level) {
    const { ctx, px } = level;
    ctx.clearRect(0, 0, px, px);
    for (const { tx, tz, key } of tilesOf(level, { x: level.cx, z: level.cz })) {
      const bmp = this.bitmaps.get(`${level.at}/${key}`);
      if (bmp) {
        this.blit(level, bmp, tx, tz);
        continue;
      }
      if (!level.index.keys.has(key)) continue;      // never cut: water, or outside the city
      this.ask(level, tx, tz, key);
    }
  }

  // Ask the loader for one tile, once: a 404 or a broken image is remembered so a level redraw never re-asks.
  ask(level, tx, tz, key) {
    const url = tileUrl(this.index, level, tx, tz);
    if (this.flying.has(url) || this.failed.has(url)) return;
    this.flying.add(url);
    this.stats.asked++;
    this.load(url).then(({ bmp, bytes = 0 }) => {
      this.flying.delete(url);
      this.stats.loaded++;
      this.stats.bytes += bytes;
      this.remember(`${level.at}/${key}`, bmp);
      // only draw it if its level is still centred where it was asked for, and the tile is still in view
      if (level.cx !== null && this.wanted.has(`${level.at}/${key}`)) {
        this.blit(level, bmp, tx, tz);
        level.dirty = true;
      }
    }).catch(() => {
      this.flying.delete(url);
      this.failed.add(url);
      this.stats.failed++;
    });
  }

  // One tile onto a level's canvas, the part that is on it: a 1:1 copy, never a scale.
  blit(level, bmp, tx, tz) {
    const r = clipRect(level, { x: level.cx, z: level.cz }, tx, tz);
    if (!r) return;
    level.ctx.drawImage(bmp, r.sx, r.sy, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  // Keep the newest `cacheTiles` bitmaps, dropping the oldest that no level is drawing now.
  remember(key, bmp) {
    this.bitmaps.delete(key);
    this.bitmaps.set(key, bmp);
    if (this.bitmaps.size <= this.cacheTiles) return;
    for (const [k, v] of this.bitmaps) {
      if (this.bitmaps.size <= this.cacheTiles) break;
      if (this.wanted.has(k)) continue;
      this.bitmaps.delete(k);
      v.close?.();
    }
  }
}
