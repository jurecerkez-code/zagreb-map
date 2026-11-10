// Probe: per look, min DeltaE of slopes/walls/banks vs lit water under the #24 pipe (mirrors themes.test.mjs helpers).
import { THEMES, SHADING } from '../web/themes.js';
import { readFileSync } from 'node:fs';
import { oklabLin, lin, rgb } from '../web/tone.js';
import { goldenModel } from './light-model.mjs';

const APP = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const { SUN, SUN_LEVEL, lightAt, shown } = goldenModel(APP);
const UP = [0, 1, 0];
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
  const land = rgb(th.land).map(lin), quay = rgb(th.quay).map(lin);
  const up = lightAt(UP);
  const ds = steps(16).map(k => SUN_LEVEL * (2 * k - 1));
  // Evaluate the actual light at a normal, rather than multiplying the legacy relief fudge as well.
  const slopeLit = d => land.map((v, i) => v * lightAt([d, Math.sqrt(Math.max(0, 1 - d * d)), 0])[i]);
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
