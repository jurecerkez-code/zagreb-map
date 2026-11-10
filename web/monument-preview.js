// The monument card's quiet golden-hour view. No DOM is touched at module scope: the canvas and ImageData factories are
// injectable, and Node can exercise the complete renderer -> readback -> canvas path without a browser or a GL context.
import { monumentFront } from './monument-forms.js';

export const MONUMENT_RENDER_WIDTH = 512;
export const MONUMENT_RENDER_HEIGHT = 384;
export const MONUMENT_MEDIA_TABS = ['photo', 'render'];

export function nextMonumentMediaTab(key, current, hasPhoto = true) {
  if (!hasPhoto) return ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(key) ? 'render' : null;
  const i = MONUMENT_MEDIA_TABS.indexOf(current), n = MONUMENT_MEDIA_TABS.length;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[key];
  return to === undefined || i < 0 ? null : MONUMENT_MEDIA_TABS[(to + n) % n];
}

export function monumentView(m, { surfaceAt = () => 0, streets = {}, base = null } = {}) {
  const h = Number.isFinite(m?.h) && m.h > 0 ? m.h : 3;
  const x = Number(m?.x) || 0, z = Number(m?.z) || 0, ground = surfaceAt(x, z);
  const baseY = Number.isFinite(base) ? base : ground;
  const target = [x, baseY + h / 2, z], front = monumentFront(m, streets);
  const rise = h * 0.35, horizontal = Math.sqrt((3 * h) ** 2 - rise ** 2);
  return {
    size: [MONUMENT_RENDER_WIDTH, MONUMENT_RENDER_HEIGHT], h, ground, base: baseY, front, target,
    camera: { position: [x + front.vector[0] * horizontal, target[1] + rise, z + front.vector[1] * horizontal],
      fov: 35, near: Math.max(0.03, h * 0.01), far: Math.max(100, h * 30) },
    background: '#f4e3c0',
    light: { color: '#ffd39a', direction: [front.vector[0] * 0.8, 0.38, front.vector[1] * 0.8] },
  };
}

export function flipRenderPixels(source, width, height) {
  const flipped = new Uint8ClampedArray(width * height * 4), stride = width * 4;
  for (let y = 0; y < height; y++) flipped.set(source.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  return flipped;
}

export function pixelVariance(rgba) {
  const n = Math.floor(rgba.length / 4);
  if (!n) return 0;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const luminance = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    sum += luminance; sum2 += luminance * luminance;
  }
  return Math.max(0, sum2 / n - (sum / n) ** 2);
}

export function makeMonumentPreview(T, {
  renderer, surfaceAt = () => 0, streets = {},
  createCanvas = () => document.createElement('canvas'), ImageDataClass = globalThis.ImageData,
} = {}) {
  if (!renderer) throw new Error('monument preview needs the city renderer');
  const cache = new Map();

  function render(m, singleMesh) {
    const id = String(m?.id || m?.name || '');
    if (!id) throw new Error('monument preview needs a monument id');
    if (cache.has(id)) return cache.get(id);
    const mesh = singleMesh();                   // one instance at its real map h / direction, never the whole city
    if (!mesh?.isInstancedMesh || mesh.count !== 1) throw new Error(`no single-map mesh for monument ${id}`);
    const matrix = new T.Matrix4(); mesh.getMatrixAt(0, matrix);
    const view = monumentView(m, { surfaceAt, streets, base: matrix.elements[13] });
    const [width, height] = view.size;
    const target = new T.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
    const scene = new T.Scene(); scene.background = new T.Color(view.background);
    scene.name = `monument-preview:${id}`;
    scene.userData.target = new T.Vector3(...view.target);
    const camera = new T.PerspectiveCamera(view.camera.fov, width / height, view.camera.near, view.camera.far);
    camera.position.set(...view.camera.position); camera.lookAt(...view.target); camera.updateMatrixWorld();
    let ground = null;
    const oldTarget = renderer.getRenderTarget();
    try {
      const uniforms = mesh.material?.uniforms || {};
      uniforms.uSun?.value?.set(...view.light.direction).normalize();
      if (uniforms.uFog?.value?.set) uniforms.uFog.value.set(1e9, 1e9 + 1);
      if (uniforms.uFogColor?.value?.set) uniforms.uFogColor.value.set(view.background);
      // The custom monument shader has no Light objects: give its directional light and palette the golden tint.
      if (uniforms.uStone?.value?.lerp) uniforms.uStone.value.lerp(new T.Color('#ffe0a3'), 0.12);
      for (const c of uniforms.uFig?.value || []) c.lerp?.(new T.Color(view.light.color), 0.07);
      scene.add(mesh);
      ground = new T.Mesh(new T.CircleGeometry(view.h * 4, 48),
        new T.MeshBasicMaterial({ color: '#b9a273', side: T.DoubleSide }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(m.x, view.ground - 0.035, m.z);
      scene.add(ground);

      const pixels = new Uint8Array(width * height * 4);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      const flipped = flipRenderPixels(pixels, width, height);
      if (!ImageDataClass) throw new Error('monument preview needs ImageData');
      const canvas = createCanvas(); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('monument preview cannot get a 2D canvas');
      context.putImageData(new ImageDataClass(flipped, width, height), 0, 0);
      canvas.className = 'monument-render-canvas';
      canvas.dataset.monumentId = id;
      canvas.dataset.cameraSource = view.front.source;
      const variance = pixelVariance(pixels);
      canvas.dataset.pixelVariance = String(variance);
      canvas.setAttribute('role', 'img');
      const result = { canvas, variance, view, width, height };
      cache.set(id, result);
      return result;
    } finally {
      renderer.setRenderTarget(oldTarget);
      target.dispose();
      if (mesh) { mesh.geometry.dispose(); mesh.material.dispose(); }
      if (ground) { ground.geometry.dispose(); ground.material.dispose(); }
    }
  }
  return { render, get cached() { return cache.size; } };
}
