export const PARAMS = {
  angleX: { label: '顔の左右', min: -30, max: 30, initial: 0 },
  angleY: { label: '顔の上下', min: -20, max: 20, initial: 0 },
  angleZ: { label: '顔の傾き', min: -20, max: 20, initial: 0 },
  bodyX: { label: '体の傾き', min: -1, max: 1, initial: 0 },
  breath: { label: '呼吸', min: 0, max: 1, initial: 0.5 },
  // above 1 = widened (surprise): the lids open further and the iris shrinks a little
  eyeOpenL: { label: '目の開き L', min: 0, max: 1.25, initial: 1 },
  eyeOpenR: { label: '目の開き R', min: 0, max: 1.25, initial: 1 },
  eyeBallX: { label: '視線の左右', min: -1, max: 1, initial: 0 },
  eyeBallY: { label: '視線の上下', min: -1, max: 1, initial: 0 },
  browY: { label: '眉の高さ', min: -1, max: 1, initial: 0 },
  mouthOpen: { label: '口の開き', min: 0, max: 1, initial: 0 },
  mouthForm: { label: '笑顔', min: -1, max: 1, initial: 0 },
  cheek: { label: '頬の赤み', min: 0, max: 1, initial: 0 },
  eyeSmile: { label: '笑い目', min: 0, max: 1, initial: 0 },
  shoulderY: { label: '肩の高さ', min: -1, max: 1, initial: 0 },
};
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const radians = Math.PI / 180;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Parameters {
  constructor() {
    this.values = {};
    this.targets = {};
    this.auto = {};
    for (const [name, definition] of Object.entries(PARAMS)) {
      this.values[name] = this.targets[name] = definition.initial;
      this.auto[name] = true;
    }
    this.nextBlink = 2 + Math.random() * 4;
    this.blinkStart = -Infinity;
    this.doubleBlink = false;
    this.nextSaccade = 0;
    this.gaze = [0, 0];
    this.time = 0;
    this.velocities = { angleX: 0, angleY: 0, angleZ: 0 };
    this.expressions = [];
    this.expression = null;
    this.expressionPins = {};
    this.transitions = {};
    this.nextLook = 6 + Math.random() * 6;
    this.lookStart = -Infinity;
    this.lookFrom = this.lookTo = [0, 0];
    this.boopStart = -Infinity;
  }

  set(name, value) {
    if (!Object.hasOwn(PARAMS, name) || !Number.isFinite(Number(value))) return;
    const definition = PARAMS[name];
    this.targets[name] = clamp(Number(value), definition.min, definition.max);
    this.auto[name] = false;
    delete this.expressionPins[name];
  }

  release(name) {
    if (Object.hasOwn(PARAMS, name)) {
      this.auto[name] = true;
      delete this.expressionPins[name];
    }
  }

  isAuto(name) { return this.auto[name] && !Object.hasOwn(this.expressionPins, name); }
  target(name) { return this.expressionPins[name] ?? this.targets[name]; }

  setExpression(id) {
    const expression = id == null ? null : this.expressions.find(item => item.id === id);
    if (id != null && !expression) return;
    const pins = {};
    for (const [name, value] of Object.entries(expression?.params || {})) {
      if (Object.hasOwn(PARAMS, name) && Number.isFinite(Number(value))) {
        pins[name] = clamp(Number(value), PARAMS[name].min, PARAMS[name].max);
      }
    }
    for (const name of new Set([...Object.keys(this.expressionPins), ...Object.keys(pins)])) this.transitions[name] = 0.25;
    this.expression = expression?.id ?? null;
    this.expressionPins = pins;
  }

  boop() {
    this.boopStart = this.blinkStart = this.time;
    this.doubleBlink = false;
    this.nextBlink = this.time + 2 + Math.random() * 4;
  }

  update(dt, time, pointer, face, mic) {
    dt = clamp(dt, 0, 0.05);
    this.time = time;
    if (time >= this.nextBlink) {
      this.blinkStart = time;
      const repeat = !this.doubleBlink && Math.random() < 0.15;
      this.nextBlink = time + (repeat ? 0.33 : 2 + Math.random() * 4);
      this.doubleBlink = repeat;
    }
    const phase = time - this.blinkStart;
    const blink = phase < 0 ? 1 : phase < 0.07 ? 1 - phase / 0.07 : phase < 0.10 ? 0 :
      phase < 0.23 ? (phase - 0.10) / 0.13 : 1;
    if (time >= this.nextSaccade) {
      this.gaze = [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.2];
      this.nextSaccade = time + 0.5 + Math.random() * 2;
    }
    if (time >= this.nextLook) {
      this.lookFrom = this.lookTo;
      this.lookTo = [(Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.8];
      this.lookStart = time;
      this.nextLook = time + 6 + Math.random() * 6;
    }
    const headLook = smoothstep(0, 0.8, time - this.lookStart - 0.12);
    const eyeLook = smoothstep(0, 0.8, time - this.lookStart);
    const look = this.lookFrom.map((value, i) => value + (this.lookTo[i] - value) * headLook);
    const eyes = this.lookFrom.map((value, i) => value + (this.lookTo[i] - value) * eyeLook);
    const breathingPhase = time * Math.PI * 2 / 3.5;
    const micOpen = typeof mic === 'number' ? mic : mic?.open || 0;
    const micForm = typeof mic === 'object' && mic?.speaking ? mic.form : null;
    const sway = Math.sin(time * 0.73) + Math.sin(time * 1.19) * 0.4;
    const automatic = {
      angleX: pointer.x * 24 + sway * 1.2 + look[0] * 12,
      angleY: pointer.y * 15 + Math.sin(time * 0.91) * 0.8 + look[1] * 8 + Math.sin(breathingPhase - Math.PI / 2) * 0.4,
      angleZ: pointer.x * 3 + Math.sin(time * 0.61) * 1.3,
      bodyX: pointer.x * 0.12 + Math.sin(time * 0.49) * 0.04,
      breath: (1 + Math.sin(breathingPhase)) / 2,
      shoulderY: Math.sin(breathingPhase) * 0.15,
      cheek: 0, eyeSmile: 0,
      eyeOpenL: blink, eyeOpenR: blink,
      eyeBallX: pointer.x * 0.75 + this.gaze[0] + eyes[0] * 0.6,
      eyeBallY: pointer.y * 0.65 + this.gaze[1] + eyes[1] * 0.6,
      browY: 0, mouthOpen: micOpen, mouthForm: micForm ?? 0,
    };
    if (face) {
      for (const name of ['angleX', 'angleY', 'angleZ']) automatic[name] = face[name] + automatic[name] * 0.06;
      automatic.bodyX = face.angleX / 30 * 0.12 + Math.sin(time * 0.49) * 0.04;
      automatic.eyeOpenL = Math.min(blink, face.eyeOpenL);
      automatic.eyeOpenR = Math.min(blink, face.eyeOpenR);
      automatic.eyeBallX = face.eyeBallX + this.gaze[0] * 0.15;
      automatic.eyeBallY = face.eyeBallY + this.gaze[1] * 0.15;
      automatic.browY = face.browY;
      automatic.mouthForm = micForm == null ? face.mouthForm : face.mouthForm * 0.4 + micForm * 0.6;
      automatic.mouthOpen = Math.max(face.mouthOpen, micOpen);
      automatic.eyeSmile = face.eyeSmile ?? 0;
      automatic.cheek = face.cheek ?? 0;
    }
    automatic.browY -= (1 - blink) * 0.15;
    const boopAge = time - this.boopStart;
    if (boopAge >= 0 && boopAge < 0.45) {
      const recoil = Math.sin(boopAge / 0.45 * Math.PI) * Math.exp(-boopAge * 4);
      automatic.angleY -= recoil * 6;
      automatic.angleZ += recoil * 2;
    }
    for (const [name, definition] of Object.entries(PARAMS)) {
      if (this.auto[name]) this.targets[name] = clamp(automatic[name], definition.min, definition.max);
      const target = this.target(name);
      const expressionMotion = Object.hasOwn(this.expressionPins, name) || this.transitions[name] > 0;
      if (name.startsWith('angle') && !expressionMotion) {
        // Analytic second-order spring: natural speed 9, slight overshoot, stable at any frame rate.
        const speed = 9, damping = 0.82, frequency = speed * Math.sqrt(1 - damping * damping);
        const decay = Math.exp(-damping * speed * dt), c = Math.cos(frequency * dt), s = Math.sin(frequency * dt);
        const displacement = this.values[name] - target, velocity = this.velocities[name];
        this.values[name] = target + decay * (displacement * c + (velocity + damping * speed * displacement) / frequency * s);
        this.velocities[name] = decay * (velocity * c - (damping * speed * velocity + speed * speed * displacement) / frequency * s);
      } else {
        const speed = expressionMotion ? 12 : name.startsWith('eyeOpen') ? 70 : name.startsWith('eyeBall') ? 28 : name === 'mouthOpen' ? 25 : 12;
        this.values[name] += (target - this.values[name]) * (1 - Math.exp(-dt * speed));
        if (name.startsWith('angle')) this.velocities[name] = 0;
      }
      const bounded = clamp(this.values[name], definition.min, definition.max);
      if (bounded !== this.values[name] && name.startsWith('angle')) this.velocities[name] = 0;
      this.values[name] = bounded;
      if (this.transitions[name] > 0) this.transitions[name] -= dt;
    }
    return this.values;
  }
}

export class Rig {
  constructor(model, layers, physics) {
    this.model = model;
    this.layers = layers;
    this.physics = physics;
    const [width, height] = model.canvas;
    const pivots = model.pivots || {};
    this.hip = pivots.hip || [width / 2, height * 0.86];
    this.neck = pivots.neck || [width / 2, height * 0.31];
    this.head = pivots.headCenter || [width / 2, height * 0.2];
    this.radius = pivots.headRadius || [width * 0.17, height * 0.12];
    this.byId = new Map(layers.map(layer => [layer.id, layer]));
    this.closedEyes = new Set(layers.filter(layer => layer.role === 'eyeClosed').map(layer => layer.side));
    this.smileEyes = new Set(layers.filter(layer => layer.role === 'eyeSmile').map(layer => layer.side));
    this.roles = new Set(layers.map(layer => layer.role));
    this.hasOpenMouth = ['mouthOpen', 'mouthOpenSmile', 'mouthO'].some(role => this.roles.has(role));
    this.offset = { x: 0, y: 0 };
  }

  update(params, explode = 0, time = 0) {
    const [hx, hy] = this.head;
    const [rx, ry] = this.radius;
    const [nx, ny] = this.neck;
    const [hipX, hipY] = this.hip;
    // Flat artwork breaks up under a literal rotation, so the turn is damped and x is only mildly foreshortened.
    const pitch = params.angleY * 0.7 * radians, yaw = params.angleX * 0.7 * radians;
    const roll = params.angleZ * radians;
    const lean = (params.bodyX * 4 + params.angleZ * 0.15) * radians;
    const squeeze = 1 - (1 - Math.cos(yaw)) * 0.5;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), sy = Math.sin(yaw);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // Move a head as a unit by the body's transform at the neck, then apply lean.
    const neckHeight = clamp((hipY - ny) / Math.max(1, hipY), 0, 1);
    const neckBreath = (ny - hipY) * 0.012 * params.breath * neckHeight;
    // Swap to the open mouth almost at once and let it grow from small: a long cross-fade shows a
    // half-transparent open mouth with the closed smile line poking out at both corners.
    const mouthAlpha = smoothstep(0.03, 0.14, params.mouthOpen);
    // Two different mouth drawings ghost when mixed half and half, so the swap band is kept narrow.
    const smile = smoothstep(0.42, 0.58, params.mouthForm);
    const pucker = this.roles.has('mouthO') ? smoothstep(-0.42, -0.58, params.mouthForm) : 0;
    const hasPlainOpen = this.roles.has('mouthOpen'), hasSmileOpen = this.roles.has('mouthOpenSmile');
    const hasPlainClosed = this.roles.has('mouthClosed'), hasSmileClosed = this.roles.has('mouthSmile');
    for (const layer of this.layers) {
      const [x0, y0, width, height] = layer.rect;
      const center = layer.center || [x0 + width / 2, y0 + height / 2];
      const eyeWhite = this.byId.get(layer.clip) || this.layers.find(item => item.role === 'eyeWhite' && item.side === layer.side);
      const eyeCenter = ['iris', 'eyeHighlight'].includes(layer.role) && !layer.center && eyeWhite ? (eyeWhite.center || [eyeWhite.rect[0] + eyeWhite.rect[2] / 2, eyeWhite.rect[1] + eyeWhite.rect[3] / 2]) : center;
      const eyeOpen = layer.side === 'R' ? params.eyeOpenR : params.eyeOpenL;
      const hasClosedEye = this.closedEyes.has(layer.side);
      let scaleX = 1, scaleY = 1, translateX = 0, translateY = 0, centerY = center[1];
      layer.opacity = 1;
      const eyeSmile = this.smileEyes.has(layer.side) ? params.eyeSmile ?? 0 : 0;
      if (['eyeOpen', 'eyeWhite', 'iris', 'eyeHighlight'].includes(layer.role)) {
        // The upper lid comes down onto a fixed lower lid. Squashing the whole eye about its centre
        // (iris included) reads as a deformed eye, so the iris keeps its shape and is simply covered.
        const lids = eyeWhite || layer;
        const wide = Math.max(0, eyeOpen - 1), shut = Math.min(1, eyeOpen);
        const lidScale = (hasClosedEye ? 0.12 : 0.08) + (hasClosedEye ? 0.88 : 0.92) * shut + wide * 0.5;
        if (['eyeOpen', 'eyeWhite'].includes(layer.role) || !eyeWhite) {
          scaleY = lidScale;
          centerY = lids.rect[1] + lids.rect[3] * 0.86;
        } else {
          scaleX = scaleY = 1 - wide * 0.6;
          centerY = eyeCenter[1];
          translateY += (1 - shut) * lids.rect[3] * 0.12;
        }
        layer.opacity = hasClosedEye ? smoothstep(0.14, 0.26, eyeOpen) : 1;
      } else if (layer.role === 'eyeClosed') {
        layer.opacity = 1 - smoothstep(0.14, 0.26, eyeOpen);
      } else if (layer.role === 'brow') {
        translateY = -params.browY * 0.03 * ry;
      } else if (['mouthOpen', 'mouthOpenSmile', 'mouthO'].includes(layer.role)) {
        const round = hasPlainOpen || hasSmileOpen ? pucker : 1;
        const openSmile = hasPlainOpen ? smile : 1;
        layer.opacity = mouthAlpha * (layer.role === 'mouthO' ? round : (1 - pucker) *
          (layer.role === 'mouthOpenSmile' ? openSmile : hasSmileOpen ? 1 - smile : 1));
        scaleY = 0.25 + 0.75 * params.mouthOpen;
        scaleX = (1 + 0.08 * params.mouthForm) * (0.78 + 0.22 * Math.min(1, params.mouthOpen * 2));
      } else if (['mouthClosed', 'mouthSmile'].includes(layer.role)) {
        const closedSmile = hasPlainClosed ? smile : 1;
        layer.opacity = (this.hasOpenMouth ? 1 - mouthAlpha : 1) *
          (layer.role === 'mouthSmile' ? closedSmile : hasSmileClosed ? 1 - smile : 1);
        scaleY = this.hasOpenMouth ? 1 : 1 + 1.2 * params.mouthOpen;
        scaleX = 1 + 0.08 * params.mouthForm;
      } else if (layer.role === 'blush') {
        layer.opacity = params.cheek ?? 0;
      } else if (layer.role === 'eyeSmile') {
        layer.opacity = params.eyeSmile ?? 0;
      }
      if (['eyeOpen', 'eyeWhite', 'iris', 'eyeClosed', 'eyeHighlight'].includes(layer.role)) layer.opacity *= 1 - eyeSmile;
      if (['iris', 'eyeHighlight'].includes(layer.role)) {
        const eyeWidth = eyeWhite ? eyeWhite.rect[2] : width;
        const movement = layer.role === 'eyeHighlight' ? 0.35 : 1;
        translateX += params.eyeBallX * 0.10 * eyeWidth * movement;
        translateY += params.eyeBallY * 0.07 * eyeWidth * movement;
        if (layer.role === 'eyeHighlight') {
          const shimmer = 1 + Math.sin(time * Math.PI * 2 * 0.4) * 0.015;
          scaleX *= shimmer;
          scaleY *= shimmer;
        }
      }
      if (layer.group === 'body' && layer.pivot && Number.isFinite(layer.shrug)) {
        translateY -= (params.shoulderY ?? 0) * layer.shrug * 0.01 * this.model.canvas[1];
      }
      const hair = this.physics.get(layer.physics);
      const depth = Number(layer.depth) || 0;
      for (let i = 0; i < layer.rest.length; i += 2) {
        let x = layer.rest[i], y = layer.rest[i + 1];
        if (hair) {
          const root = hair.config.rootY ?? hy;
          const tip = hair.config.tipY ?? root + ry * 2;
          const weight = Math.pow(clamp((y - root) / Math.max(1, tip - root), 0, 1), 1.5);
          const offset = this.physics.sample(hair, weight, this.offset);
          if (hair.config.mode === 'rotate') {
            const pivot = layer.pivot || center;
            const angle = offset.x * (hair.config.amount ?? 1) * (hair.config.rotateScale ?? 0.05) * radians;
            const c = Math.cos(angle), s = Math.sin(angle), dx = x - pivot[0], dy = y - pivot[1];
            x = pivot[0] + dx * c - dy * s;
            y = pivot[1] + dx * s + dy * c;
          } else {
            x += offset.x * (hair.config.amount ?? 1);
            y -= Math.abs(offset.x) * 0.08;
          }
          y += offset.y;
        }
        x = center[0] + (x - center[0]) * scaleX + translateX;
        y = centerY + (y - centerY) * scaleY + translateY;
        if (layer.group === 'head') {
          const restX = x, restY = y;
          const u = (x - hx) / rx, v = (y - hy) / ry;
          // Paraboloid rather than a sphere: a finite slope at the rim keeps parts there from collapsing.
          const z = depth * rx + (layer.dome ? 0.55 * rx * Math.max(0, 1 - u * u - v * v) : 0);
          const localX = x - hx, localY = Math.min(y, ny) - hy;
          const pitchedY = localY * cp - z * sp;
          const pitchedZ = localY * sp + z * cp;
          x = hx + localX * squeeze + pitchedZ * sy;
          y = hy + pitchedY + (y - Math.min(y, ny));
          const dx = x - nx, dy = y - ny;
          x = nx + dx * cr - dy * sr + params.angleX / 30 * 0.02 * rx;
          y = ny + dx * sr + dy * cr;
          // Hair hanging below the neck rests on the shoulders: it follows the head less and less.
          const follow = 1 - 0.8 * smoothstep(ny, ny + 1.3 * ry, restY);
          x = restX + (x - restX) * follow;
          y = restY + (y - restY) * follow + neckBreath;
        } else if (layer.group === 'body' && y < hipY) {
          const weight = clamp((hipY - y) / Math.max(1, hipY), 0, 1);
          y += (y - hipY) * 0.012 * params.breath * weight;
        }
        // Lean bends the torso above the hip; the legs stay planted.
        const bend = smoothstep(0, 260, hipY - y);
        const cbb = Math.cos(lean * bend), sbb = Math.sin(lean * bend);
        const dx = x - hipX, dy = y - hipY;
        layer.positions[i] = hipX + dx * cbb - dy * sbb + explode * depth * rx * 2;
        layer.positions[i + 1] = hipY + dx * sbb + dy * cbb - explode * depth * ry;
      }
    }
  }

  containsHead(x, y) {
    // Use the posed mesh so zoom, lean, head turns and breathing still hit the visible head.
    const layer = this.layers.find(item => item.visible && (item.id === 'face' || item.role === 'face')) ||
      this.layers.filter(item => item.visible && item.group === 'head' && item.dome)
        .reduce((largest, item) => !largest || item.rect[2] * item.rect[3] > largest.rect[2] * largest.rect[3] ? item : largest, null);
    if (!layer) return Math.hypot((x - this.head[0]) / this.radius[0], (y - this.head[1]) / this.radius[1]) <= 1;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let i = 0; i < layer.positions.length; i += 2) {
      left = Math.min(left, layer.positions[i]); right = Math.max(right, layer.positions[i]);
      top = Math.min(top, layer.positions[i + 1]); bottom = Math.max(bottom, layer.positions[i + 1]);
    }
    return Math.hypot((x - (left + right) / 2) / Math.max(1, (right - left) / 2),
      (y - (top + bottom) / 2) / Math.max(1, (bottom - top) / 2)) <= 1;
  }
}
