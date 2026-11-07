// Build web/og.png from the actual app. Use ?sunmode=day while golden is still #24 work in progress.
import { chromium } from 'playwright';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../..', import.meta.url));
const url = process.argv[2] || 'http://127.0.0.1:8646/';
const python = process.platform === 'win32' ? 'python' : 'python3';
const server = spawn(python, ['-m', 'http.server', '8646', '--bind', '127.0.0.1'], { cwd: `${project}/web`, stdio: 'ignore' });
const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Shader|WebGL/i.test(message.text())) errors.push(message.text());
  });
  await delay(1500);
  const target = new URL(url);
  target.search = queryString();
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const d = window.__dbg, s = d?.stats();
    return s && s.tiles >= s.tilesTotal && s.terrain === 'ready'
      && d.uniforms.uRoof.value && d.uniforms.uGround.value && d.uniforms.uVegOn.value;
  }, null, { timeout: 300000 });
  await page.evaluate(() => {
    window.__dbg.goHome({ x: 0, z: 500, span: 1500, azimuth: 190, elevation: 40 });
    // Remove only presentation chrome. Map geometry, coordinates and light stay untouched.
    document.querySelectorAll('body > :not(#scene):not(script)').forEach(element => {
      element.setAttribute('aria-hidden', 'true');
      element.style.visibility = 'hidden';
    });
  });
  await page.waitForTimeout(7000);
  const result = await page.evaluate(() => {
    const { renderer, scene, camera } = window.__dbg;
    renderer.setPixelRatio(1);
    if (renderer.domElement.width !== innerWidth || renderer.domElement.height !== innerHeight) {
      throw new Error(`Unexpected OG render buffer: ${renderer.domElement.width}x${renderer.domElement.height}`);
    }
    renderer.render(scene, camera);
    const stats = window.__dbg.stats();
    return { image: renderer.domElement.toDataURL('image/png'), stats: { tiles: stats.tiles, triangles: stats.triangles } };
  });
  if (errors.length) throw new Error(errors.join(' | '));
  const frame = Buffer.from(result.image.split(',')[1], 'base64');
  const frameStats = await sharp(frame).stats();
  const spread = await frameStats.channels.reduce((max, c) => Math.max(max, c.stdev), 0);
  if (spread < 10) throw new Error(`OG capture is too close to blank (max channel stdev ${spread.toFixed(2)})`);

  const overlays = [];
  // Sharp renders these vector overlays at the real output size. Only true map pixels are underneath them.
  const caption = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade" x1="0%" x2="100%" y1="0%" y2="0%">
        <stop offset="0%" stop-color="#0d1720" stop-opacity="0.90"/>
        <stop offset="70%" stop-color="#0d1720" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#0d1720" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="365" width="1000" height="265" fill="url(#shade)"/>
    <rect x="46" y="414" width="56" height="4" fill="#d4b36a"/>
    <text x="46" y="486" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#fffaf0">Zagreb, zgradu po zgradu</text>
    <text x="46" y="534" font-family="Arial, sans-serif" font-size="22" font-weight="400" fill="#f4efe6">298.675 zgrada. Poznate godine u boji, nepoznate sivo.</text>
    <text x="46" y="596" font-family="Arial, sans-serif" font-size="14" fill="#d7e0e2">© Grad Zagreb · © OpenStreetMap contributors</text>
    <text x="1154" y="596" text-anchor="end" font-family="Arial, sans-serif" font-size="14" fill="#d7e0e2">jurecerkez-code.github.io/zagreb-map</text>
  </svg>`;
  overlays.push({ input: Buffer.from(caption), top: 0, left: 0 });

  mkdirSync(`${project}/shots/og`, { recursive: true });
  writeFileSync(`${project}/shots/og/base.png`, frame);
  let output = null;
  for (const quality of [80, 65, 50]) {
    const candidate = await sharp(frame).composite(overlays)
      .png({ compressionLevel: 9, palette: true, quality, effort: 10 }).toBuffer();
    output = candidate;
    if (candidate.length <= 300 * 1024) break;
  }
  if (!output || output.length > 300 * 1024) throw new Error(`OG output exceeds the 300 KiB limit (${output?.length || 0} bytes)`);
  writeFileSync(`${project}/web/og.png`, output);
  writeFileSync(`${project}/shots/og/build.json`, JSON.stringify({
    url: target.href,
    camera: { x: 0, z: 500, span: 1500, azimuth: 190, elevation: 40 },
    viewport: [1200, 630], pixels: [output.readUInt32BE(16), output.readUInt32BE(20)],
    bytes: output.length, renderer: result.stats,
    subtitle: '298.675 zgrada. Poznate godine u boji, nepoznate sivo.',
    source: queryString(),
  }, null, 1));
  console.log(`web/og.png: ${output.length} bytes, ${result.stats.tiles} tiles, ${result.stats.triangles} triangles`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.race([browser.close(), delay(10000)]);
  server.kill();
}
process.exit(process.exitCode ?? 0);

function queryString() {
  return '?theme=foto&sunmode=day&date=2026-06-21&weather=none';
}
