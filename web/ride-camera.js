// The critical spring used by the tram ride's look-ahead (k = 2 * PI * 0.8).
// This is the exact solution of position'' + 2k position' + k^2 position = 0.
// Unlike an explicit Euler step, it stays finite and damping remains monotone at a real 0.5 s frame gap.
export function advanceRideAim({ position, velocity, target, dt }) {
  if (dt <= 0) return { position: position.clone(), velocity: velocity.clone() };
  const k = 2 * Math.PI * 0.8;
  const decay = Math.exp(-k * dt);
  const nextPosition = position.clone(), nextVelocity = velocity.clone();
  for (const axis of ['x', 'y', 'z']) {
    const error = position[axis] - target[axis], advance = velocity[axis] + k * error;
    nextPosition[axis] = target[axis] + (error + advance * dt) * decay;
    nextVelocity[axis] = (velocity[axis] - k * advance * dt) * decay;
  }
  return { position: nextPosition, velocity: nextVelocity };
}
