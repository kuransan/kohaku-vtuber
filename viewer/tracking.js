import { clamp } from './rig.js';

export function cameraParameters(blends, matrix, sideMap) {
  const values = Object.fromEntries(blends.map(item => [item.categoryName, item.score]));
  const score = name => values[name] || 0;
  let yaw = 0, pitch = 0, roll = 0;
  if (matrix?.length === 16) {
    // MediaPipe MatrixData is column-major. Remove uniform scale before Euler extraction.
    const scale = Math.hypot(matrix[0], matrix[1], matrix[2]) || 1;
    yaw = Math.asin(clamp(-matrix[2] / scale, -1, 1));
    pitch = Math.atan2(matrix[6], matrix[10]);
    roll = Math.atan2(matrix[1], matrix[0]);
  }
  const degrees = 180 / Math.PI;
  const smile = (score('mouthSmileLeft') + score('mouthSmileRight')) * 0.5;
  const pucker = Math.max(score('cheekPuff'), score('mouthPucker'), score('mouthFunnel'));
  // Mirror horizontal motion and convert MediaPipe's Y-up axes to canvas Y-down.
  return {
    angleX: clamp(-yaw * degrees, -30, 30),
    angleY: clamp(-pitch * degrees, -20, 20),
    // Y-up roll toward the user's right is positive; positive canvas roll tilts screen-right.
    angleZ: clamp(roll * degrees, -20, 20),
    eyeOpenL: 1 - score(`eyeBlink${sideMap.L}`),
    eyeOpenR: 1 - score(`eyeBlink${sideMap.R}`),
    mouthOpen: clamp(score('jawOpen') * 1.5, 0, 1),
    mouthForm: clamp((score('mouthSmileLeft') + score('mouthSmileRight')) * 0.7 -
      (score('mouthFrownLeft') + score('mouthFrownRight')) * 0.5 - pucker * 1.2, -1, 1),
    eyeSmile: clamp((smile - 0.3) / 0.4, 0, 1) *
      clamp((Math.min(score('eyeSquintLeft'), score('eyeSquintRight')) - 0.25) / 0.5, 0, 1),
    cheek: smile * 0.3,
    browY: clamp(score('browInnerUp') - (score('browDownLeft') + score('browDownRight')) * 0.5, -1, 1),
    eyeBallX: clamp((score('eyeLookOutLeft') - score('eyeLookInLeft') +
      score('eyeLookInRight') - score('eyeLookOutRight')) * 0.8, -1, 1),
    eyeBallY: clamp((score('eyeLookDownLeft') + score('eyeLookDownRight') -
      score('eyeLookUpLeft') - score('eyeLookUpRight')) * 0.8, -1, 1),
  };
}

export class Tracking {
  constructor(report, stateChanged) {
    this.report = report;
    this.stateChanged = stateChanged;
    this.camera = false;
    this.mic = false;
    this.cameraPending = false;
    this.micPending = false;
    this.cameraGeneration = 0;
    this.micGeneration = 0;
    this.face = null;
    this.faceTime = 0;
    this.mouth = 0;
    this.mouthForm = 0;
    this.sideMap = { L: 'Left', R: 'Right' };
  }

  configure(model) {
    const sides = new Map();
    for (const layer of model.layers) {
      if (['eyeOpen', 'eyeWhite'].includes(layer.role) && ['L', 'R'].includes(layer.side)) {
        sides.set(layer.side, layer.center?.[0] ?? layer.rect[0] + layer.rect[2] / 2);
      }
    }
    if (sides.has('L') && sides.has('R')) {
      // Under mirroring, the subject's anatomical left eye is on the screen's left.
      this.sideMap = sides.get('L') < sides.get('R') ? { L: 'Left', R: 'Right' } : { L: 'Right', R: 'Left' };
    }
  }

  async toggleCamera() {
    if (this.cameraPending) return;
    if (this.camera) { this.stopCamera(); return; }
    this.cameraPending = true;
    this.stateChanged();
    const generation = ++this.cameraGeneration;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラは localhost または HTTPS で利用してください。');
      if (!window.Worker || !window.createImageBitmap || !window.OffscreenCanvas) throw new Error('このブラウザーはカメラ追跡用ワーカーに対応していません。');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false,
      });
      if (generation !== this.cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      this.cameraStream = stream;
      const video = this.video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
      video.srcObject = stream;
      document.body.append(video);
      await video.play();
      if (generation !== this.cameraGeneration) return;
      const worker = new Worker(new URL('./tracking-worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('追跡データの読み込みがタイムアウトしました。CDN 接続を確認してください。')), 45000);
        this.cancelCameraInit = () => { clearTimeout(timeout); reject(new Error('カメラを停止しました。')); };
        worker.onerror = event => {
          event.preventDefault();
          clearTimeout(timeout);
          reject(new Error(event.message || '追跡ワーカーを起動できません。'));
        };
        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
          else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        worker.postMessage({ type: 'init' });
      });
      this.cancelCameraInit = null;
      if (generation !== this.cameraGeneration) return;
      this.camera = true;
      this.cameraBusy = false;
      this.lastSent = -Infinity;
      worker.onmessage = ({ data }) => {
        this.cameraBusy = false;
        if (data.type === 'error') { this.cameraError(data.message); return; }
        if (data.type === 'result') {
          this.face = data.found ? cameraParameters(data.blends, data.matrix, this.sideMap) : null;
          this.faceTime = performance.now();
        }
      };
      worker.onerror = event => { event.preventDefault(); this.cameraError(event.message || '追跡ワーカーが停止しました。'); };
      stream.getVideoTracks()[0].onended = () => this.cameraError('カメラとの接続が切れました。');
      this.report('カメラ追跡を開始しました。', false);
    } catch (error) {
      if (generation === this.cameraGeneration) this.cameraError(error.message);
    } finally {
      if (generation === this.cameraGeneration) { this.cameraPending = false; this.stateChanged(); }
    }
  }

  cameraError(message) {
    this.stopCamera();
    this.report(`カメラ: ${message}\n待機モーションとマウス追従を続けます。`, true);
  }

  stopCamera() {
    this.cameraGeneration++;
    this.cancelCameraInit?.();
    this.cancelCameraInit = null;
    this.camera = false;
    this.cameraPending = false;
    this.worker?.terminate();
    this.worker = null;
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.cameraStream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; this.video.remove(); }
    this.video = null;
    this.face = null;
    this.cameraBusy = false;
    this.stateChanged();
  }

  sendFrame(now) {
    if (!this.camera || this.cameraBusy || this.video.readyState < 2 ||
      now - this.lastSent < 50) return;
    this.cameraBusy = true;
    this.lastSent = now;
    const worker = this.worker;
    const generation = this.cameraGeneration;
    createImageBitmap(this.video).then(bitmap => {
      if (generation !== this.cameraGeneration || !this.camera) { bitmap.close(); return; }
      try { worker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]); }
      catch (error) { bitmap.close(); this.cameraError(error.message); }
    }).catch(error => { if (generation === this.cameraGeneration) this.cameraError(error.message); });
  }

  async toggleMic() {
    if (this.micPending) return;
    if (this.mic) { this.stopMic(); return; }
    this.micPending = true;
    this.stateChanged();
    const generation = ++this.micGeneration;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('マイクは localhost または HTTPS で利用してください。');
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('WebAudio に対応していません。');
      // Resume on the button gesture before waiting for the permission dialog.
      this.audio = new AudioContext();
      // Autoplay-blocked resume() can stay pending until a gesture. Still request
      // the microphone now so ?mic=1 can initialize independently of that policy.
      this.audio.resume().catch(error => {
        if (generation === this.micGeneration) this.report(`マイク: ${error.message}`, true);
      });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== this.micGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      this.micStream = stream;
      this.source = this.audio.createMediaStreamSource(stream);
      this.analyser = this.audio.createAnalyser();
      this.analyser.fftSize = 1024;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
      this.source.connect(this.analyser); // No destination connection: never play mic audio back.
      this.mic = true;
      stream.getAudioTracks()[0].onended = () => { this.stopMic(); this.report('マイクとの接続が切れました。', true); };
      this.report(this.audio.state === 'running' ? 'マイクの口パクを開始しました。' : '音声が停止中です。画面をクリックして再開してください。', false);
      this.micPending = false;
      this.stateChanged();
    } catch (error) {
      if (generation === this.micGeneration) { this.stopMic(); this.report(`マイク: ${error.message}`, true); }
    }
  }

  stopMic() {
    this.micGeneration++;
    this.mic = false;
    this.micPending = false;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.micStream?.getTracks().forEach(track => track.stop());
    if (this.audio && this.audio.state !== 'closed') this.audio.close().catch(() => {});
    this.audio = this.source = this.analyser = this.micStream = null;
    this.mouth = 0;
    this.mouthForm = 0;
    this.stateChanged();
  }

  resumeAudio() {
    if (this.audio?.state === 'suspended') this.audio.resume().catch(error => this.report(`マイク: ${error.message}`, true));
  }

  update(dt, now) {
    this.sendFrame(now);
    if (this.face && now - this.faceTime > 500) this.face = null;
    let target = 0, form = 0;
    if (this.mic && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      let squareSum = 0;
      for (const sample of this.samples) squareSum += sample * sample;
      target = clamp((Math.sqrt(squareSum / this.samples.length) - 0.012) * 8, 0, 1);
      if (target > 0.035) {
        this.analyser.getFloatFrequencyData(this.spectrum);
        const binHz = this.audio.sampleRate / this.analyser.fftSize;
        let magnitude = 0, weighted = 0;
        for (let i = 1; i < this.spectrum.length; i++) {
          const frequency = i * binHz;
          if (frequency < 100 || frequency > 5000) continue;
          const amplitude = 10 ** (this.spectrum[i] / 20);
          magnitude += amplitude;
          weighted += amplitude * frequency;
        }
        if (magnitude > 0) form = (clamp((weighted / magnitude - 700) / 1900, 0, 1) * 2 - 1) * 0.6;
      }
    }
    this.mouth += (target - this.mouth) * (1 - Math.exp(-dt * (target > this.mouth ? 35 : 6)));
    this.mouthForm += (form - this.mouthForm) * (1 - Math.exp(-dt * 10));
    return { face: this.face, mic: { open: this.mouth, form: this.mouthForm, speaking: target > 0.035 } };
  }
}
