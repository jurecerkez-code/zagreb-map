// #24: the clear background is unlit, display-space colour, not a linear HDR emitter.
// #24: the background is an sRGB display colour. Fog must join a material's own output, not its linear input.
// `edge` carries the municipality's opacity, or 1 when only distance fog applies.
export const DISPLAY_FOG_GLSL = /* glsl */`
  uniform vec3 uFogDisplay;
  vec3 displayFog(vec3 colour, float range, float edge) {
    return mix(uFogDisplay, colour, edge * (1.0 - smoothstep(uFog.x, uFog.y, range)));
  }
`;

// Use Three's colour management for the same conversion as WebGLBackground's clear colour.
export function syncDisplaySky(THREE, uniforms) {
  const rgb = uniforms.uFogColor.value.getRGB({}, THREE.SRGBColorSpace);
  uniforms.uFogDisplay.value.set(rgb.r, rgb.g, rgb.b);
}
