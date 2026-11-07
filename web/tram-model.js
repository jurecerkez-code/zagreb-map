// TMK 2200: the five-part Zagreb unit in data/v20261103-fix/trams.json.
// Every body section is 6 m; four 0.5 m bellows make the measured 32 m whole.
export const BODY_PARTS = 5;
export const SECTION_LENGTH = 6;
export const BELLOWS_WIDTH = 0.5;
export const SECTION_CENTRES = [-13, -6.5, 0, 6.5, 13];

export const BELLOWS_CENTRES = SECTION_CENTRES.slice(0, -1).map((centre, i) => (centre + SECTION_CENTRES[i + 1]) / 2);

// The data uses length_m / width_m / height_m. Keep the old fallback names for existing readers.
export const vehicleDimensions = (vehicle = {}) => ({
  length: vehicle.length_m ?? vehicle.length ?? 32,
  width: vehicle.width_m ?? vehicle.width ?? 2.3,
  height: vehicle.height_m ?? vehicle.height ?? 3.4,
});

// A real open frame: a rectangle with a hole, not a blue slab over the door's glass.
export function makeDoorFrame(THREE, width = 1.3, height = 1.9) {
  const x = width / 2, y = height / 2, margin = 0.06;
  const shape = new THREE.Shape([
    new THREE.Vector2(-x, -y), new THREE.Vector2(x, -y),
    new THREE.Vector2(x, y), new THREE.Vector2(-x, y), new THREE.Vector2(-x, -y),
  ]);
  shape.holes.push(new THREE.Path([
    new THREE.Vector2(-x + margin, -y + margin), new THREE.Vector2(-x + margin, y - margin),
    new THREE.Vector2(x - margin, y - margin), new THREE.Vector2(x - margin, -y + margin),
    new THREE.Vector2(-x + margin, -y + margin),
  ]));
  return { geometry: new THREE.ShapeGeometry(shape), width, height };
}

// The same yaw as the vehicle instance matrix: local +Z maps to (-sin(heading), cos(heading)).
export function sideOffset(heading, offset) {
  return { x: -Math.sin(heading) * offset, z: Math.cos(heading) * offset };
}

export function makeVehicleParts({ make, geoOf, tag, cap, bodyMat, winMat, roofMat, doorGeo, doorMat, wheelGeo, wheelMat, faceMat, pantMat, signMat }) {
  return {
    body: make(cap * BODY_PARTS, geoOf('#0e63b8'), bodyMat, `${tag}-body`),
    win: make(cap * BODY_PARTS, geoOf('#171a1e'), winMat, `${tag}-windows`),
    roof: make(cap * BODY_PARTS, geoOf('#c9cdd2'), roofMat, `${tag}-roof`),
    bellows: make(cap * BELLOWS_CENTRES.length, geoOf('#22262b'), bodyMat, `${tag}-bellows`),
    doors: make(cap * BODY_PARTS * 2, doorGeo, doorMat, `${tag}-doors`),
    wheels: make(cap * BODY_PARTS * 2, wheelGeo, wheelMat, `${tag}-wheels`),
    face: make(cap * 2, geoOf('#171a1e'), faceMat, `${tag}-cab`),
    pant: make(cap * 2, geoOf('#22262b'), pantMat, `${tag}-pant`),
    sign: make(cap * 2, geoOf('#e8b33f'), signMat, `${tag}-sign`),
    cap,
  };
}

export function setVehicleNight(p, enabled, factor = 0.36) {
  const k = enabled ? factor : 1;
  for (const m of [p.body, p.win, p.roof, p.bellows, p.face, p.pant, p.sign]) m.material.color.setScalar(k);
  p.doors.material.color.set('#c9cdd2').multiplyScalar(k);
  p.wheels.material.color.set('#22262b').multiplyScalar(k);
}
