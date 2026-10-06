const STEP = 1 / 120;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function nodeValue(group, index, vertical, gravity) {
  if (index <= 0) return 0;
  const node = group.nodes[Math.min(group.nodes.length, index) - 1];
  return vertical ? node.lift + node.velocity * 0.025 * gravity : node.swing;
}

function interpolate(group, index, t, vertical, gravity) {
  const a = nodeValue(group, index - 1, vertical, gravity), b = nodeValue(group, index, vertical, gravity);
  const c = nodeValue(group, index + 1, vertical, gravity), d = nodeValue(group, index + 2, vertical, gravity);
  return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t +
    (-a + 3 * b - 3 * c + d) * t * t * t);
}

/** Semi-implicit spring integration, independent of render frame rate. */
export class HairPhysics {
  constructor(definitions = {}) {
    this.groups = new Map(Object.entries(definitions).map(([name, config]) => {
      const segments = Number(config.segments);
      return [name, {
        config, swing: 0, velocity: 0,
        nodes: Array.from({ length: Number.isFinite(segments) ? Math.max(1, Math.trunc(segments)) : 1 },
          () => ({ swing: 0, velocity: 0, lift: 0, liftVelocity: 0 })),
      }];
    }));
    this.accumulator = 0;
    this.time = 0;
    this.previous = null;
    this.stiffness = 1;
    this.wind = 1;
  }

  update(dt, params) {
    dt = clamp(dt, 0, 0.05);
    const previous = this.previous || params;
    const inverseDt = dt > 0 ? 1 / dt : 0;
    const yawVelocity = clamp((params.angleX - previous.angleX) * inverseDt, -250, 250);
    const rollVelocity = clamp((params.angleZ - previous.angleZ) * inverseDt, -200, 200);
    const bodyVelocity = clamp((params.bodyX - previous.bodyX) * inverseDt, -10, 10);
    const pitchVelocity = clamp((params.angleY - previous.angleY) * inverseDt, -200, 200);
    const breathVelocity = clamp((params.breath - previous.breath) * inverseDt, -10, 10);
    this.previous = { ...params };
    this.accumulator += dt;
    while (this.accumulator >= STEP) {
      this.time += STEP;
      let index = 0;
      for (const group of this.groups.values()) {
        const stiffness = clamp((Number(group.config.stiffness) || 40) * this.stiffness, 1, 600);
        const damping = Math.max(0, Number(group.config.damping ?? 6));
        const wind = Math.sin(this.time * 1.7 + index++) * 22 * this.wind;
        const drive = { yaw: 1, roll: 1, body: 1, breath: 0, wind: 1, ...group.config.drive };
        const force = -yawVelocity * 2.2 * drive.yaw - rollVelocity * 2.8 * drive.roll -
          bodyVelocity * 75 * drive.body - breathVelocity * 40 * drive.breath + wind * drive.wind;
        const gravity = clamp(Number(group.config.gravity) || 0, 0, 1);
        const liftForce = gravity * (-pitchVelocity * 0.8 * drive.yaw + Math.abs(rollVelocity) * 0.25 * drive.roll -
          bodyVelocity * 10 * drive.body - breathVelocity * 18);
        for (let i = 0; i < group.nodes.length; i++) {
          const node = group.nodes[i], parent = group.nodes[i - 1];
          // Node zero is exactly the v1 spring; each later node chases its parent.
          const nodeForce = parent ? stiffness * parent.swing : force;
          node.velocity += (nodeForce - stiffness * node.swing - damping * node.velocity) * STEP;
          node.swing = clamp(node.swing + node.velocity * STEP, -180, 180);
          node.liftVelocity += ((parent ? stiffness * parent.lift : liftForce) -
            stiffness * node.lift - damping * node.liftVelocity) * STEP;
          node.lift = clamp(node.lift + node.liftVelocity * STEP, -40, 40);
        }
        const tip = group.nodes.at(-1);
        group.swing = tip.swing;
        group.velocity = tip.velocity;
      }
      this.accumulator -= STEP;
    }
  }

  get(name) { return this.groups.get(name); }

  /** Cubic interpolation through the fixed root and chain nodes; no per-vertex allocations. */
  sample(group, weight, output) {
    const nodes = group.nodes;
    const gravity = clamp(Number(group.config.gravity) || 0, 0, 1);
    if (nodes.length === 1) {
      output.x = group.swing * weight;
      output.y = nodeValue(group, 1, true, gravity) * weight;
      return output;
    }
    const position = clamp(weight, 0, 1) * nodes.length;
    const index = Math.min(nodes.length - 1, Math.floor(position)), t = position - index;
    output.x = interpolate(group, index, t, false, gravity);
    output.y = interpolate(group, index, t, true, gravity);
    return output;
  }

  impulse(amount = 100) {
    for (const group of this.groups.values()) {
      group.nodes.forEach((node, i) => { node.velocity += amount / (i + 1); });
    }
  }
}
