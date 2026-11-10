// Analytical golden-hour colours using the selected renderer recipe, not duplicated constants.
// The ACES matrices and fit mirror THREE.ShaderChunk.tonemapping_pars_fragment in this checkout.
import { SUN_LIGHT } from '../web/themes.js';
import { sunVector } from '../web/sun.js';
import { lin, rgb, hex } from '../web/tone.js';

const mul = (matrix, colour) => matrix[0].map((_, row) =>
  matrix[0][row] * colour[0] + matrix[1][row] * colour[1] + matrix[2][row] * colour[2]);
const clamp = value => Math.min(1, Math.max(0, value));
const unlin = value => value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;

// GLSL constructors take these three vec3 values as columns, not as rows.
const ACES_IN = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
const ACES_OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
const fit = v => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
const aces = (colour, exposure) => {
  const fitColour = mul(ACES_IN, colour.map(value => value * exposure / 0.6)).map(fit);
  return mul(ACES_OUT, fitColour).map(clamp);
};

const REC2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const SRGB_BACK = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const INSET = [[0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const OUTSET = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
const agxCurve = x => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
  - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };
const agx = (colour, exposure) => {
  let v = mul(INSET, mul(REC2020, colour.map(value => value * exposure)));
  v = v.map(value => clamp((Math.log2(Math.max(value, 1e-10)) + 12.47393) / (4.026069 + 12.47393)));
  v = v.map(agxCurve);
  v = mul(OUTSET, v).map(value => Math.pow(Math.max(0, value), 2.2));
  return mul(SRGB_BACK, v).map(clamp);
};

// #24: the neutral curve (Khronos PBR Neutral), mirroring THREE.ShaderChunk.tonemapping_pars_fragment: identity
// through the mid-tones, a linear toe that sinks the darkest values, and a hyperbolic shoulder above 0.76.
const neutral = (colour, exposure) => {
  const START = 0.76, DESATURATION = 0.15;
  let c = colour.map(value => value * exposure);
  const x = Math.min(...c);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c = c.map(value => value - offset);
  const peak = Math.max(...c);
  if (peak < START) return c.map(clamp);
  const d = 1 - START;
  const newPeak = 1 - d * d / (peak + d - START);
  c = c.map(value => value * newPeak / peak);
  const g = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
  return c.map(value => clamp(value * (1 - g) + newPeak * g));
};

export function goldenModel(source) {
  const tone = source.match(/renderer\.toneMapping\s*=\s*THREE\.(\w+ToneMapping)/)?.[1];
  const exposure = Number(source.match(/renderer\.toneMappingExposure\s*=\s*([\d.]+)/)?.[1]);
  const uniHex = name => source.match(new RegExp(`${name}:.*THREE\\.Color\\('(#[0-9a-f]{6})'\\)`))?.[1];
  if (!['ACESFilmicToneMapping', 'AgXToneMapping', 'NeutralToneMapping'].includes(tone) || !Number.isFinite(exposure)) {
    throw new Error(`Unsupported renderer recipe in app.js: ${tone}, exposure ${exposure}`);
  }
  const SUN_COL = rgb(uniHex('uSunCol')).map(lin), SKY_COL = rgb(uniHex('uSkyCol')).map(lin);
  const SUN = sunVector({ elevation: 38, azimuth: 225 });
  const length = Math.hypot(...SUN);
  SUN.forEach((value, i) => { SUN[i] = value / length; });
  const SUN_LEVEL = Math.hypot(SUN[0], SUN[2]);
  const lightAt = normal => SUN_COL.map((channel, i) =>
    channel * Math.max(normal[0] * SUN[0] + normal[1] * SUN[1] + normal[2] * SUN[2], 0) * SUN_LIGHT.direct
    + SKY_COL[i] * (0.6 + 0.4 * (normal[1] * 0.5 + 0.5)) * SUN_LIGHT.skyFill);
  const CURVES = { ACESFilmicToneMapping: aces, AgXToneMapping: agx, NeutralToneMapping: neutral };
  const shown = colour => hex(CURVES[tone](colour, exposure).map(unlin));
  return { SUN, SUN_LEVEL, lightAt, shown, tone, exposure };
}
