// Probe: per look, min DeltaE of slopes/walls/banks vs lit water under the #24 pipe (mirrors themes.test.mjs helpers).
import { THEMES, SHADING } from '../web/themes.js';
import { sunVector } from '../web/sun.js';
import { readFileSync } from 'node:fs';
import { oklabLin, lin, rgb, hex } from '../web/tone.js';

const APP = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const uniHex = u => APP.match(new RegExp(`${u}: \\{ value: new THREE\\.Color\\('(#[0-9a-f]{6})'\\)`))?.[1];
const SUN_COL = rgb(uniHex('uSunCol')).map(lin), SKY_COL = rgb(uniHex('uSkyCol')).map(lin);
const SUN = sunVector({ elevation: 38, azimuth: 225 });
{ const l = Math.hypot(...SUN); SUN.forEach((v, i) => SUN[i] = v / l); }
const SUN_LEVEL = Math.hypot(SUN[0], SUN[2]);
const UP = [0, 1, 0];
const lightAt = n => SUN_COL.map((c, i) => c * Math.max(n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2], 0) * 2.2
  + SKY_COL[i] * (0.6 + 0.4 * (n[1] * 0.5 + 0.5)) * 0.55);
const mulv = (m, c) => m[0].map((_, r) => m[0][r] * c[0] + m[1][r] * c[1] + m[2][r] * c[2]);
const REC2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const SRGB_BACK = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const INSET = [[0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const OUTSET = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
const agxCurve = x => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
  - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };
const agx = c => {
  let v = mulv(INSET, mulv(REC2020, c.map(x => x * 1.15)));
  v = v.map(x => Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393))));
  v = v.map(agxCurve);
  v = mulv(OUTSET, v).map(x => Math.pow(Math.max(0, x), 2.2));
  return mulv(SRGB_BACK, v).map(x => Math.min(1, Math.max(0, x)));
};
const unlin = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const shown = c => hex(agx(c).map(unlin));
const steps = n => Array.from({ length: n + 1 }, (_, i) => i / n);
const dE = (a, b, kind) => {
  const CVD = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
  };
  const seen = (h, k) => { const c = rgb(h).map(lin); return k === 'normal' ? c : CVD[k].map(row => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))); };
  const p = oklabLin(seen(a, kind)), q = oklabLin(seen(b, kind));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
function ground(th) {
  const s = th.reliefShade, lo = 1 - SHADING.dark * s, hi = 1 + SHADING.light * s;
  const slopeK = d => Math.min(hi, Math.max(lo, 1 + s * (d - SUN[1])));
  const land = rgb(th.land).map(lin), quay = rgb(th.quay).map(lin);
  const up = lightAt(UP);
  const ds = steps(16).map(k => SUN_LEVEL * (2 * k - 1));
  const slopeLit = d => land.map((v, i) => v * slopeK(d) * up[i]);
  const wallLit = d => quay.map((v, i) => v * lightAt([d, 0, Math.sqrt(Math.max(0, 1 - d * d))])[i]);
  return {
    slopes: [slopeLit(SUN_LEVEL), slopeLit(-SUN_LEVEL)].map(shown),
    walls: ds.map(d => shown(wallLit(d))),
    banks: ds.flatMap(d => steps(8).map(w => shown(slopeLit(d).map((v, i) => v * (1 - w) + wallLit(d)[i] * w)))),
    water: shown(rgb(th.water).map(lin).map((v, i) => v * up[i])),
  };
}
for (const [name, th] of Object.entries(THEMES)) {
  const g = ground(th);
  const kinds = name === 'paper' ? ['normal'] : ['normal', 'protan', 'deutan', 'tritan'];
  for (const k of kinds) {
    const mins = k => Math.min(...k.map(c => dE(c, g.water, k)));
    // shadows of variable names collide; compute directly:
    const ms = Math.min(...g.slopes.map(c => dE(c, g.water, k)));
    const mw = Math.min(...g.walls.map(c => dE(c, g.water, k)));
    const mb = Math.min(...g.banks.map(c => dE(c, g.water, k)));
    console.log(`${name} ${k}: slope ${ms.toFixed(1)}, wall ${mw.toFixed(1)}, bank ${mb.toFixed(1)}, quay/land ${dE(th.quay, th.land, k).toFixed(1)}`);
  }
}
