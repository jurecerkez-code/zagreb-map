"""Zagreb: the permitted orthophoto cut into a quadtree of WebP tiles the client can page in (issue #36).

    uv run python -m pipeline.run s18_zagreb_ortho_tiles
    uv run python -m pipeline.run s18_zagreb_ortho_tiles -- --out web/data/ortho --quality 84

Input (both already on disk from earlier steps):

  data/raw/ortho/t_<e0>_<n0>_<e1>_<n1>_2048.jpg   the Ortofoto2022 WMS tiles scripts/sample_ortho.py read
                                                 (2400 m at 2048 px = 1.171875 m/px, EPSG:3765)
  data/land_zagreb.geojson                        the city's land polygons: everything outside them is left out

Output (OUTSIDE git: web/data is ignored, and issue #36 forbids publishing tiles until a human records the
permission; #37 moves the directory to release assets or object storage):

  web/data/ortho/index.json            the pyramid's metadata: levels, resolutions, which tiles exist, total bytes
  web/data/ortho/l<L>/<tx>_<tz>.webp   256 px tiles, level 0 coarsest

Levels: L0 64 m/px ... L6 1 m/px, each 256 px, so a tile is 16384 m down to 256 m across and every level nests
exactly into the next (a coarser tile is its four children halved). 1 m/px is the finest level the source supports:
the imagery is 1.171875 m/px, so L6 is a 17% resample and a 0.5 or 0.25 m/px level would be a pure enlargement --
four to sixteen times the bytes for no new detail. If a finer orthophoto is ever fetched, add levels at the top of
LEVEL_RES and nothing else changes.

Tiles are rectangles of the local frame (metres from city.ORIGIN, x east, z south) and land-clipped: a tile with no
land is not written, a tile on the boundary keeps transparent pixels over the water and the neighbouring
municipalities, so the client's fallback (the sampled mean ground colours) shows through. Nothing is invented:
outside the mosaic's own footprint there is simply no tile.
"""
import argparse
import json
import math
import time
from collections import OrderedDict
from pathlib import Path

from PIL import Image, ImageDraw
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.prepared import prep

from . import city

DATA = Path("data")
WEB = Path("web") / "data"

# Metres per pixel per level, coarsest first. Powers of two: every level's tiles are exactly four children of the
# next level's. The client's clipmap picks two of these from one distance (web/ortho-clipmap.js).
LEVEL_RES = [64.0, 32.0, 16.0, 8.0, 4.0, 2.0, 1.0]
TILE_PX = 256
SOURCE_TILE_M = 2400.0      # scripts/sample_ortho.py --tile
SOURCE_PX = 2048            # ... --px
QUALITY = 84                # 37.9 dB PSNR against the source crop at 512 m: visually lossless for photography
WEBP_METHOD = 4             # 0.06 s per 256 px tile; method 6 costs 0.31 s for 7% fewer bytes
CACHE = 6                   # source tiles kept decoded at once (each 2048^2 RGB is 12.6 MB)
# A tile read straight from the source builds an intermediate canvas of (tile_m / source res) squared; past this many
# source pixels it is assembled from its four children instead (a 16384 m tile would need 14000^2 px, 580 MB).
MAX_DIRECT_PX = 4096


def source_geometry(root: Path) -> tuple[int, int, int, int]:
    """The mosaic's own extent as (e0, n1, tiles_x, tiles_y) from the cached tiles' file names."""
    xs, ys = set(), set()
    for p in root.glob("t_*.jpg"):
        parts = p.stem.split("_")
        xs.add(int(parts[1]))
        ys.add(int(parts[2]))
    if not xs:
        raise SystemExit(f"no orthophoto tiles in {root}: run scripts/sample_ortho.py first")
    step = int(SOURCE_TILE_M)
    if any((x % step) for x in xs) or any((y % step) for y in ys):
        raise SystemExit(f"{root}: tile origins are not multiples of {step} m")
    return min(xs), max(ys), len({x // step for x in xs}), len({y // step for y in ys})


class Mosaic:
    """The source tiles as one picture in EPSG:3765, decoded lazily and kept in a small LRU."""

    def __init__(self, root: Path):
        self.root = root
        self.e0, self.n1, self.nx, self.ny = source_geometry(root)
        self.res = SOURCE_TILE_M / SOURCE_PX
        self.cache: OrderedDict[tuple[int, int], Image.Image] = OrderedDict()

    def tile(self, tx: int, ty: int) -> Image.Image | None:
        if tx < 0 or ty < 0 or tx >= self.nx or ty >= self.ny:
            return None
        key = (tx, ty)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        e0 = self.e0 + tx * int(SOURCE_TILE_M)
        n1 = self.n1 - ty * int(SOURCE_TILE_M)
        p = self.root / f"t_{e0}_{n1 - int(SOURCE_TILE_M)}_{e0 + int(SOURCE_TILE_M)}_{n1}_{SOURCE_PX}.jpg"
        if not p.exists():
            return None
        im = Image.open(p).convert("RGB")
        if im.size != (SOURCE_PX, SOURCE_PX):
            raise SystemExit(f"{p}: {im.size} px, expected {SOURCE_PX} square")
        self.cache[key] = im
        while len(self.cache) > CACHE:
            self.cache.popitem(last=False)
        return im

    def crop(self, e0: float, n0: float, e1: float, n1: float, px: int) -> Image.Image:
        """The mosaic over an EPSG:3765 box, resampled to px square. Sub-pixel exact: the box handed to resize is
        fractional, so a tile lands where its coordinates say, not on the nearest whole source pixel."""
        sx0, sx1 = (e0 - self.e0) / self.res, (e1 - self.e0) / self.res
        sy0, sy1 = (self.n1 - n1) / self.res, (self.n1 - n0) / self.res
        ix0, iy0 = math.floor(sx0), math.floor(sy0)
        ix1, iy1 = math.ceil(sx1), math.ceil(sy1)
        canvas = Image.new("RGB", (ix1 - ix0, iy1 - iy0))
        for ty in range(iy0 // SOURCE_PX, (iy1 - 1) // SOURCE_PX + 1):
            for tx in range(ix0 // SOURCE_PX, (ix1 - 1) // SOURCE_PX + 1):
                im = self.tile(tx, ty)
                if im is None:
                    continue
                # paste only the part of the source tile that lands on the canvas: a whole 2048 px tile is 4 M px
                dx, dy = tx * SOURCE_PX - ix0, ty * SOURCE_PX - iy0
                cx0, cy0 = max(0, -dx), max(0, -dy)
                cx1 = min(SOURCE_PX, canvas.width - dx)
                cy1 = min(SOURCE_PX, canvas.height - dy)
                if cx1 > cx0 and cy1 > cy0:
                    canvas.paste(im.crop((cx0, cy0, cx1, cy1)), (dx + cx0, dy + cy0))
        return canvas.resize((px, px), Image.LANCZOS,
                             box=(sx0 - ix0, sy0 - iy0, sx1 - ix0, sy1 - iy0))


def load_land() -> dict:
    """The city's land polygons in the LOCAL frame: x east of city.ORIGIN, z south of it (the pipeline's frame is a
    reflection and a shift of EPSG:3765, so every ring is mapped coordinate by coordinate, not merely shifted)."""
    doc = json.loads((DATA / "land_zagreb.geojson").read_text())
    oe, on = city.ORIGIN
    polys = []
    for f in doc["features"]:
        g = f["geometry"]
        parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for rings in parts:
            mapped = [[(e - oe, on - n) for e, n in ring] for ring in rings]
            polys.append(Polygon(mapped[0], mapped[1:]))
    return {"polys": polys, "prepared": prep(unary_union(polys))}


def land_mask(land: dict, x0: float, z0: float, size: float, px: int, ss: int = 2) -> Image.Image | None:
    """The city's land over one tile as an L mask at px square: None when no land touches the tile, a full mask when
    the tile is entirely inside it, otherwise the polygons drawn at ss times the size and averaged down (a soft edge,
    so the coast does not stair-step at 1 m/px)."""
    b = box(x0, z0, x0 + size, z0 + size)
    if not land["prepared"].intersects(b):
        return None
    if land["prepared"].contains(b):
        return Image.new("L", (px, px), 255)
    big = Image.new("L", (px * ss, px * ss), 0)
    d = ImageDraw.Draw(big)
    s = px * ss / size
    for poly in land["polys"]:
        for ring, ink in [(poly.exterior, 255)] + [(r, 0) for r in poly.interiors]:
            d.polygon([((x - x0) * s, (z - z0) * s) for x, z in ring.coords], fill=ink)
    return big.resize((px, px), Image.BOX)


def from_children(d: Path, tx: int, tz: int) -> Image.Image | None:
    """A parent tile assembled from its four children, halved. The child grid is the parent's doubled: tile (tx, tz)
    covers the same ground as children (2tx, 2tz) .. (2tx+1, 2tz+1) of the next level."""
    block = Image.new("RGBA", (TILE_PX * 2, TILE_PX * 2))
    any_child = False
    for dz in (0, 1):
        for dx in (0, 1):
            p = d / f"{2 * tx + dx}_{2 * tz + dz}.webp"
            if p.exists():
                block.paste(Image.open(p).convert("RGBA"), (dx * TILE_PX, dz * TILE_PX))
                any_child = True
    return block.resize((TILE_PX, TILE_PX), Image.BOX) if any_child else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(WEB / "ortho"), help="tile directory (outside git; see the docstring)")
    ap.add_argument("--quality", type=int, default=QUALITY)
    ap.add_argument("--bbox", default="", help="x0,z0,x1,z1 in the local frame: build one area only (a quick check)")
    args = ap.parse_args(argv)
    out = Path(args.out)
    t0 = time.time()
    mosaic = Mosaic(DATA / "raw" / "ortho")
    land = load_land()
    area = box(*[float(v) for v in args.bbox.split(",")]) if args.bbox else None

    x_lo = mosaic.e0 - city.ORIGIN[0]
    x_hi = mosaic.e0 + mosaic.nx * SOURCE_TILE_M - city.ORIGIN[0]
    z_lo = city.ORIGIN[1] - mosaic.n1
    z_hi = city.ORIGIN[1] - (mosaic.n1 - mosaic.ny * SOURCE_TILE_M)
    if area is not None:
        x_lo, z_lo, x_hi, z_hi = area.bounds

    levels = []
    # Finest first, so a level assembled from its children finds them on disk from this same run.
    for L in range(len(LEVEL_RES) - 1, -1, -1):
        res = LEVEL_RES[L]
        tile_m = TILE_PX * res
        d = out / f"l{L}"
        d.mkdir(parents=True, exist_ok=True)
        written, skipped, total = 0, 0, 0
        entries = []
        direct = tile_m / mosaic.res <= MAX_DIRECT_PX
        for tz in range(math.floor(z_lo / tile_m), math.ceil(z_hi / tile_m)):
            for tx in range(math.floor(x_lo / tile_m), math.ceil(x_hi / tile_m)):
                x0, z0 = tx * tile_m, tz * tile_m
                if area is not None and not area.intersects(box(x0, z0, x0 + tile_m, z0 + tile_m)):
                    continue
                mask = land_mask(land, x0, z0, tile_m, TILE_PX)
                if mask is None:
                    skipped += 1
                    continue
                if direct:
                    e0, n0 = city.ORIGIN[0] + x0, city.ORIGIN[1] - (z0 + tile_m)
                    im = mosaic.crop(e0, n0, e0 + tile_m, city.ORIGIN[1] - z0, TILE_PX)
                else:
                    im = from_children(out / f"l{L + 1}", tx, tz)
                    if im is None:
                        skipped += 1
                        continue
                rgba = im.convert("RGBA")
                rgba.putalpha(mask)
                p = d / f"{tx}_{tz}.webp"
                if mask.getextrema()[0] == 255:
                    rgba.convert("RGB").save(p, "WEBP", quality=args.quality, method=WEBP_METHOD)
                else:
                    rgba.save(p, "WEBP", quality=args.quality, method=WEBP_METHOD)
                size = p.stat().st_size
                total += size
                written += 1
                entries.append([tx, tz, size])
        levels.append({"level": L, "res": res, "tileM": tile_m, "tiles": entries, "bytes": total})
        print(f"l{L} {res:g} m/px ({tile_m:.0f} m tiles, {'source' if direct else 'children'}): {written} written, "
              f"{skipped} skipped, {total / 1e6:.2f} MB", flush=True)

    levels.sort(key=lambda level: level["level"])
    index = {
        "format": "zagreb-ortho-tiles", "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "origin": list(city.ORIGIN), "crs": city.CRS,
        "tilePx": TILE_PX, "quality": args.quality,
        "credit": "© Grad Zagreb, Ortofoto 2022, used with permission (email 29.10.2026)",
        "levels": levels,
        "bytes": sum(level["bytes"] for level in levels),
        "buildSeconds": round(time.time() - t0, 1),
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"index.json: {sum(len(level['tiles']) for level in levels)} tiles, {index['bytes'] / 1e6:.2f} MB, "
          f"{index['buildSeconds']} s -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
