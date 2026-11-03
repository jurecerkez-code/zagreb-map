"""Zagreb port: cut what the map needs out of Geofabrik's Croatia extract (OpenStreetMap, ODbL), once, outside the
pipeline's steps (Overpass is not reachable from the build machine).

    uv run python -m pipeline.zagreb_osm [path/to/croatia-latest.osm.pbf]

Reads the PBF with GDAL's OSM driver (pyogrio) inside BBOX and writes to ../data/raw/osm/ (EPSG:3765):
  zg_osm_buildings.parquet   every building polygon: osm_id (w123 / r123), building, name, start_date (raw tag value,
                             start_date, else building:start_date, else construction_date), addr_street,
                             addr_number, levels, wikidata, historic, amenity, geometry
  zg_osm_admin.parquet       administrative boundaries (admin_level 4..10) with name and admin_level
  zg_osm_water.parquet       water areas (natural=water, water=*, waterway=riverbank/dock, landuse=reservoir/basin)
  zg_osm_streets.parquet     named highway centrelines (name, highway, geometry)
  zg_osm_addr_points.parquet address nodes (street, number, geometry)
  zg_osm_waterways.parquet   named river/canal/stream lines (name, waterway, geometry)
"""
import re
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "raw" / "osm"
PBF = OUT / "croatia-latest.osm.pbf"
BBOX = (15.74, 45.60, 16.26, 45.98)          # WGS84, a little more than Grad Zagreb
CRS = 3765
TAG = re.compile(r'"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"')


def tags(s) -> dict:
    return {k: v for k, v in TAG.findall(s)} if isinstance(s, str) else {}


def read(layer: str) -> gpd.GeoDataFrame:
    t = time.perf_counter()
    g = pyogrio.read_dataframe(PBF if len(sys.argv) < 2 else sys.argv[1], layer=layer, bbox=BBOX)
    print(f"{layer}: {len(g):,} features in {time.perf_counter() - t:.0f} s", flush=True)
    return g


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    mp = read("multipolygons")
    mp["osm_id"] = np.where(mp.osm_id.notna(), "r" + mp.osm_id.astype(str), "w" + mp.osm_way_id.astype(str))
    mp.loc[mp.osm_id.isna() | (mp.osm_id == "rNone"), "osm_id"] = "w" + mp.osm_way_id.astype(str)
    ot = [tags(s) for s in mp.other_tags]

    def col(*keys):
        return pd.array([next((d[k] for k in keys if d.get(k)), None) for d in ot], dtype="str")

    # buildings
    isb = mp.building.notna() & (mp.building != "no")
    b = mp[isb.to_numpy()]
    bt = [ot[i] for i in np.flatnonzero(isb.to_numpy())]

    def bcol(*keys):
        return pd.array([next((d[k] for k in keys if d.get(k)), None) for d in bt], dtype="str")

    bld = gpd.GeoDataFrame({
        "osm_id": b.osm_id.to_numpy(), "building": b.building.to_numpy(), "name": b["name"].to_numpy(),
        "start_date": bcol("start_date", "building:start_date", "construction_date", "year_of_construction"),
        "addr_street": bcol("addr:street"), "addr_number": bcol("addr:housenumber"),
        "levels": bcol("building:levels"), "wikidata": bcol("wikidata"),
        "historic": b.historic.to_numpy(), "amenity": b.amenity.to_numpy(),
        "heritage": bcol("heritage", "heritage:operator", "ref:RST"),
    }, geometry=b.geometry.values, crs=4326).to_crs(CRS)
    bld.to_parquet(OUT / "zg_osm_buildings.parquet", index=False)
    print(f"buildings {len(bld):,}; with a start date {bld.start_date.notna().sum():,}; wikidata "
          f"{bld.wikidata.notna().sum():,}; levels {bld.levels.notna().sum():,}")

    adm = mp[(mp["boundary"] == "administrative").to_numpy() & mp.admin_level.notna().to_numpy()]
    gpd.GeoDataFrame({"osm_id": adm.osm_id.to_numpy(), "name": adm["name"].to_numpy(),
                      "admin_level": adm.admin_level.astype(str).to_numpy()},
                     geometry=adm.geometry.values, crs=4326).to_crs(CRS).to_parquet(OUT / "zg_osm_admin.parquet",
                                                                                      index=False)
    print("admin:", sorted(set(zip(adm.admin_level, adm["name"])))[:80])

    wt = col("water")
    ww = col("waterway")
    isw = ((mp.natural == "water").to_numpy() | pd.notna(np.asarray(wt, dtype=object))
           | np.isin(np.asarray(ww, dtype=object), ["riverbank", "dock"])
           | np.isin(mp.landuse.to_numpy(dtype=object), ["reservoir", "basin"]))
    w = mp[isw]
    gpd.GeoDataFrame({"osm_id": w.osm_id.to_numpy(), "name": w["name"].to_numpy(),
                      "water": np.asarray(wt, dtype=object)[isw]},
                     geometry=w.geometry.values, crs=4326).to_crs(CRS).to_parquet(OUT / "zg_osm_water.parquet",
                                                                                 index=False)
    print(f"water areas {int(isw.sum()):,}")

    ln = read("lines")
    st = ln[ln.highway.notna().to_numpy() & ln["name"].notna().to_numpy()]
    gpd.GeoDataFrame({"name": st["name"].to_numpy(), "highway": st.highway.to_numpy()},
                     geometry=st.geometry.values, crs=4326).to_crs(CRS).to_parquet(OUT / "zg_osm_streets.parquet",
                                                                                  index=False)
    print(f"named street lines {len(st):,}")
    wl = ln[ln.waterway.isin(["river", "canal", "stream"]).to_numpy() & ln["name"].notna().to_numpy()]
    gpd.GeoDataFrame({"name": wl["name"].to_numpy(), "waterway": wl.waterway.to_numpy()},
                     geometry=wl.geometry.values, crs=4326).to_crs(CRS).to_parquet(OUT / "zg_osm_waterways.parquet",
                                                                                  index=False)
    print(f"named waterway lines {len(wl):,}")

    pt = read("points")
    pot = [tags(s) for s in pt.other_tags]
    has = np.array([bool(d.get("addr:housenumber") and d.get("addr:street")) for d in pot])
    gpd.GeoDataFrame({"street": [d.get("addr:street") for d, h in zip(pot, has) if h],
                      "number": [d.get("addr:housenumber") for d, h in zip(pot, has) if h]},
                     geometry=pt.geometry.values[has], crs=4326).to_crs(CRS).to_parquet(
        OUT / "zg_osm_addr_points.parquet", index=False)
    print(f"address points {int(has.sum()):,}")


if __name__ == "__main__":
    main()
