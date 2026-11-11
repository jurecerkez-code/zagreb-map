# Truth pass, 2026-11-10

The orthophoto is a raster, not a building mask. This table therefore measures the two claims the
model can be held to without inventing a mask: the ZG3D part union against the OSM footprint it is
drawn in (IoU), and the model's own LoD2 height. A row below 0.85 is explained, not hidden.

| Landmark | gid | Footprint IoU | Model height | Note |
|---|---:|---:|---:|---|
| Zagrebačka katedrala | 92547 | 1.000 | 103.5 m | part union vs OSM footprint |
| Crkva sv. Marka | 89286 | 1.000 | 52.6 m | part union vs OSM footprint |
| HNK | 53482 | 1.000 | 32.1 m | part union vs OSM footprint |
| Zagrepčanka | 295074,295075,295076,295077 | 1.000 | 91.5 m | part union vs OSM footprint |
| Glavni kolodvor | 52127,52203,52204,52205,52207 | 1.000 | 25.2 m | part union vs OSM footprint |
| Mamutica | 115966 | 1.000 | 59.7 m | part union vs OSM footprint |
| Mirogoj arkade | 84770,84772,84773,84777 | 1.000 | 39.1 m | part union vs OSM footprint |
| Arena Zagreb | 298412 | 1.000 | 55.9 m | part union vs OSM footprint |
| Filozofski fakultet | - | n/a | n/a | not measurable: no named building for it in this build's index |
| Botanički vrt, staklenik | - | n/a | n/a | not measurable: no named building for it in this build's index |

Measured from `data/buildings.parquet`, `data/lod2_parts.parquet`, `data/ground.parquet` and
`data/towers.parquet` by `scripts/truth.py`. Reproduce with `uv run python scripts/truth.py`.
