// The history facts: data/facts.json, the 24 verified events of data/facts/zagreb_facts.json (forged by the facts
// worker, each with at least two sources), placed at the spot they are about.
//
// A gold disc marks the place, the same size on screen at any distance, following the relief as it changes. The
// timeline drives them: an event appears once the year on the slider reaches it, and goes again when it is scrubbed
// back, so the map tells the city's story in the order it happened.
export function makeFacts({ THREE, list, surfaceAt, camera, renderer }) {
  const group = new THREE.Group();
  group.name = 'facts';

  // A four-pointed gold star with a dark edge: a mark that says "a story happened here", and that can never be read as
  // a letter or a punctuation mark (an "i" in a disc was tried first and read as an exclamation mark).
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const star = (outer, inner) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? inner : outer;
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      const x = 48 + r * Math.cos(a);
      const y = 48 + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  star(44, 17);
  ctx.fillStyle = '#e0b437';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#241f16';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(48, 48, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map, sizeAttenuation: false, depthTest: false, transparent: true,
  });

  for (const fact of list) {
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.024, 0.024, 1);
    sprite.renderOrder = 4;
    sprite.visible = false;
    sprite.userData = { fact };
    group.add(sprite);
  }

  let year = Infinity;
  let on = true;
  const wanted = fact => on && fact.year <= year;

  function update() {
    for (const sprite of group.children) {
      const fact = sprite.userData.fact;
      sprite.visible = wanted(fact);
      if (sprite.visible) sprite.position.set(fact.x, surfaceAt(fact.x, fact.z) + 12, fact.z);
    }
  }

  // The fact whose disc is under the pointer, in screen pixels: a click gives a generous 16 px around it, the same
  // lesson as the statues' grab box (a small target falls through to whatever stands behind).
  const projected = new THREE.Vector3();
  function under(clientX, clientY) {
    const el = renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    let best = null;
    let bestDistance = 16;
    for (const sprite of group.children) {
      if (!sprite.visible) continue;
      projected.copy(sprite.position).project(camera);
      if (projected.z > 1) continue;                       // behind the camera
      const x = ((projected.x + 1) / 2) * w;
      const y = ((1 - projected.y) / 2) * h;
      const distance = Math.hypot(x - clientX, y - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = sprite.userData.fact;
      }
    }
    return best;
  }

  update();

  return {
    group,
    list,                     // the facts themselves, for the sightseeing walk (app.js renderTour)
    count: list.length,
    under,
    update,
    setYear(y) {
      if (y === year) return false;
      year = y;
      update();
      return true;
    },
    setOn(v) {
      on = !!v;
      group.visible = on;
      update();
    },
    get on() { return on; },
  };
}
