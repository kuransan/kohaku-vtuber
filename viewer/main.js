import { Renderer } from './renderer.js';
import { Parameters, Rig, clamp } from './rig.js';
import { HairPhysics } from './physics.js';
import { Tracking } from './tracking.js';
import { UI } from './ui.js';

const query = new URLSearchParams(location.search);
const obs = query.get('obs') === '1';
const canvas = document.getElementById('stage');
const parameters = new Parameters();
const settings = { zoom: 1, offsetY: 0, explode: 0, background: 'transparent', stiffness: 1, wind: 1 };
const pointer = { x: 0, y: 0 };
let ui = null, renderer = null, animation = null;
const errors = [];

function report(message, error = true) {
  if (error) errors.push(message);
  ui?.report(message, error);
}

const tracking = new Tracking(report, () => ui?.updateDevices());
ui = new UI(document.getElementById('panel'), parameters, settings, tracking, obs, saveScreenshot);
const vt = window.vt = {
  setParam(name, value) { parameters.set(name, value); ui.update(); },
  release(name) { parameters.release(name); ui.update(); },
  setExpression(id) { parameters.setExpression(id); ui.update(); },
  getParams() { return { ...parameters.values }; },
  ready: null,
  model: null,
  layers: [],
  errors,
};

async function saveScreenshot() {
  const blob = await renderer.screenshot();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vtuber-${new Date().toISOString().replaceAll(':', '-')}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

window.addEventListener('pointermove', event => {
  pointer.x = clamp(event.clientX / Math.max(1, window.innerWidth) * 2 - 1, -1, 1);
  pointer.y = clamp(event.clientY / Math.max(1, window.innerHeight) * 2 - 1, -1, 1);
});
window.addEventListener('pointerout', event => {
  if (event.relatedTarget === null) pointer.x = pointer.y = 0;
});
window.addEventListener('pointerdown', () => tracking.resumeAudio());
window.addEventListener('keydown', () => tracking.resumeAudio());
window.addEventListener('pagehide', () => {
  if (animation != null) cancelAnimationFrame(animation);
  tracking.stopCamera();
  tracking.stopMic();
});

async function initialize() {
  renderer = new Renderer(canvas);
  const modelUrl = new URL(query.get('model') || '../model/model.json', location.href);
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`モデルを読み込めません (${response.status}): ${modelUrl.href}`);
  const model = await response.json();
  const layers = await renderer.load(model, modelUrl, report);
  vt.model = model;
  vt.layers = layers;
  tracking.configure(model);
  const physics = new HairPhysics(model.physics || {});
  const rig = new Rig(model, layers, physics);
  ui.setModel(model, layers);
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !rig.containsHead(...renderer.toModelPoint(event.clientX, event.clientY))) return;
    parameters.boop();
    physics.impulse(130);
  });
  let previous = performance.now(), elapsed = 0, lastUI = -Infinity;
  let failed = false;
  function frame(now) {
    if (failed) return;
    try {
      // Cap elapsed time so tab switches do not inject huge motion/physics impulses.
      const dt = clamp((now - previous) / 1000, 0, 0.05);
      previous = now;
      elapsed += dt;
      const inputs = tracking.update(dt, now);
      const params = parameters.update(dt, elapsed, pointer, inputs.face, inputs.mic);
      physics.stiffness = settings.stiffness;
      physics.wind = settings.wind;
      physics.update(dt, params);
      rig.update(params, settings.explode, elapsed);
      renderer.zoom = settings.zoom;
      renderer.offsetY = settings.offsetY;
      renderer.render();
      if (now - lastUI >= 100) { ui.update(); lastUI = now; }
      animation = requestAnimationFrame(frame);
    } catch (error) {
      failed = true;
      report(`描画: ${error.message}`);
      tracking.stopCamera();
      tracking.stopMic();
    }
  }
  window.addEventListener('resize', () => {
    try { renderer.resize(); } catch (error) { report(error.message); }
  });
  document.addEventListener('visibilitychange', () => { previous = performance.now(); });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    failed = true;
    if (animation != null) cancelAnimationFrame(animation);
    tracking.stopCamera();
    tracking.stopMic();
    report('WebGL の接続が失われました。ページを再読み込みしてください。');
  });
  // ready resolves after the first drawing, so automation can inspect a loaded scene.
  rig.update(parameters.values, settings.explode);
  renderer.render();
  ui.update();
  animation = requestAnimationFrame(frame);
  if (query.get('cam') === '1') void tracking.toggleCamera();
  if (query.get('mic') === '1') void tracking.toggleMic();
  return vt;
}

vt.ready = initialize();
// Leave ready rejected for automated callers, while handling it for normal page use.
vt.ready.catch(error => {
  report(error.message);
  if (!obs) {
    const notice = document.getElementById('notice');
    notice.textContent = `${error.message}\nテストモデル: ?model=../viewer/test-model/model.json`;
    notice.hidden = false;
  }
});
