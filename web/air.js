// The sky (#33): a gradient and a sun, not a clear colour.
//
// The map's sky used to be one flat hex on the clear colour, repeated in the fog (DISPLAY_FOG_GLSL). At the horizon
// that is exactly right — the far city and the sky must join without a seam — but above it a single colour is the one
// surface in the picture with no light in it, and it reads as a cut-out behind the city rather than as air. This file
// adds the two things a photograph has and a cut-out does not: the sky brightens towards the zenith instead of sitting
// flat, and it carries the sun's halo.
//
// The dome is a unit sphere drawn at the camera, depth-tested off, order -1000: it is the background, and every wall in
// front of it (even a wall 2 m away) covers it. Its horizon is uFogColor *exactly*, the same uniform the fog uses, so
// the join cannot drift as the weather eases, the look changes or the Night dims the sky; and it sits on layer 0, so
// the pick pass (layer 1) never sees it.
//
// Values are display sRGB, the space the clear colour is authored in: the dome is the one surface drawn without the
// tone curve (a lit surface's values are reflectance, the sky's are what the eye sees).

// The zenith's tint over the horizon's colour. Every channel above 1, so the gradient can only ever lighten the frame:
// the picture gate holds mean luminance to the baseline, and a deeper blue zenith (the physically right one) would
// darken the sky by a few percent and fail it. A pale, slightly cooler wash upward is what haze over the basin looks
// like anyway, and it raises contrast between the sky and the roofs against it.
export const SKY_TINT = [1.02, 1.07, 1.14];
// How the exponent bends the gradient: 1 is linear in height. Below 1 the brightening sits high in the frame, which is
// where a visitor looks, and the first few degrees above the horizon — the band that meets the fogged city — stay close
// to the fog's own colour.
export const SKY_CURVE = 0.55;
// The sun's halo: a wide wash and a tighter core, as fractions of the sky's own colour, so it dims with the Night and
// with the weather exactly as the sky does. Both are small: the halo must read at the sun without flattening the
// gradient, and the sun is behind the visitor at the home view anyway.
export const SKY_GLOW = { wide: 0.055, widePow: 6, core: 0.10, corePow: 64 };
// The halo's colour: the sky's own, warmed. Multiplied into uFogColor, so it never brightens a dim sky.
export const SKY_WARM = [1.0, 0.94, 0.84];
// At night the sky is flat: the Night look's dimmed sky is already the whole statement, and a halo around a moon that
// is not modelled would be invention.
export const SKY_FLAT = [1, 1, 1];

export const SKY_VERT = /* glsl */`
  varying vec3 vSkyDir;
  void main() {
    vSkyDir = position;
    // z = w puts every vertex on the far plane: the dome is behind everything, and its own geometry cannot clip.
    gl_Position = (projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0)).xyww;
  }
`;

export const SKY_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uFogColor;   // the horizon, and the fog with it: the same uniform, so the join cannot drift
  uniform vec3 uSun;        // towards the sun (map frame)
  uniform vec3 uSkyTint;    // SKY_TINT by day, SKY_FLAT at night
  uniform float uNight;
  varying vec3 vSkyDir;
  void main() {
    vec3 d = normalize(vSkyDir);
    float up = clamp(d.y, 0.0, 1.0);
    vec3 horizon = uFogColor;
    vec3 zenith = uFogColor * uSkyTint;
    vec3 c = mix(horizon, zenith, pow(up, ${SKY_CURVE.toFixed(6)}));
    // The sun's halo, warmed and scaled by the sky's own brightness so it fades with the weather and dies at night.
    float s = max(dot(d, uSun), 0.0);
    vec3 warm = uFogColor * vec3(${SKY_WARM.map(v => v.toFixed(6)).join(', ')});
    c += warm * (${SKY_GLOW.wide.toFixed(6)} * pow(s, ${SKY_GLOW.widePow.toFixed(1)}) +
      ${SKY_GLOW.core.toFixed(6)} * pow(s, ${SKY_GLOW.corePow.toFixed(1)})) * (1.0 - uNight);
    gl_FragColor = vec4(c, 1.0);   // GLSL1: this material is the one pass drawn outside the renderer's tail
  }
`;

// The shader's own arithmetic in JS, for the unit tests and for the look's poster inks: skyColourAt({sky, dir, sun}).
// `sky` may be a '#rrggbb' string or an [r, g, b] array in display sRGB.
export function hexRgb(hex) {
  const h = hex.replace(/^#/, '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
export const rgbHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)
  .toString(16).padStart(2, '0')).join('');

export function skyColourAt({ sky, dir = [0, 1, 0], sun = [0, 1, 0], night = false }) {
  const base = typeof sky === 'string' ? hexRgb(sky) : sky;
  const tint = night ? SKY_FLAT : SKY_TINT;
  const d = norm(dir), s = norm(sun);
  const up = Math.max(0, Math.min(1, d[1]));
  const t = Math.pow(up, SKY_CURVE);
  const cosine = Math.max(0, d[0] * s[0] + d[1] * s[1] + d[2] * s[2]);
  const glow = night ? 0 : SKY_GLOW.wide * Math.pow(cosine, SKY_GLOW.widePow) +
    SKY_GLOW.core * Math.pow(cosine, SKY_GLOW.corePow);
  return base.map((v, i) => v * (1 - t + t * tint[i]) + v * SKY_WARM[i] * glow);
}
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// The dome. The material shares the scene's own uniforms (uFogColor, uSun, uNight), so the weather, the look switch,
// the sun's mode and the Night reach it without a line of wiring; only the zenith's tint is the dome's own, and step()
// flips it when the Night comes or goes.
export function makeSkyDome(THREE, { uniforms }) {
  const tint = { value: new THREE.Color(SKY_TINT[0], SKY_TINT[1], SKY_TINT[2]) };
  const material = new THREE.ShaderMaterial({
    uniforms: { uFogColor: uniforms.uFogColor, uSun: uniforms.uSun, uNight: uniforms.uNight, uSkyTint: tint },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;   // the background, drawn before any wall
  mesh.matrixAutoUpdate = false;
  let night = null;
  return {
    mesh,
    material,
    // Follow the camera (the dome is the background at every distance) and keep the zenith tint with the Night.
    step(camera, isNight = false) {
      mesh.position.copy(camera.position);
      mesh.updateMatrix();
      if (isNight !== night) {
        night = isNight;
        tint.value.setRGB(...(isNight ? SKY_FLAT : SKY_TINT));
      }
    },
  };
}
