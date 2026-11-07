// TMK 2200: the five-part Zagreb unit in data/v20261103-fix/trams.json.
// Every body section is 6 m; four 0.5 m bellows make the measured 32 m whole.
export const BODY_PARTS = 5;
export const SECTION_LENGTH = 6;
export const BELLOWS_WIDTH = 0.5;
export const SECTION_CENTRES = [-13, -6.5, 0, 6.5, 13];

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
