import { PARAMS } from './rig.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function rangeControl(parent, { label, min, max, step, value, onInput }) {
  const row = element('div', null, 'control');
  const caption = element('label', label);
  const output = element('output', String(value));
  caption.append(output);
  const input = element('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => { output.textContent = input.value; onInput(Number(input.value)); });
  row.append(caption, input);
  parent.append(row);
  return { row, input, output };
}

export class UI {
  constructor(panel, parameters, settings, tracking, obs, screenshot) {
    this.panel = panel;
    this.parameters = parameters;
    this.tracking = tracking;
    this.obs = obs;
    this.controls = new Map();
    panel.hidden = obs;
    this.title = element('h1', '2D VTuber ビューアー');
    panel.append(this.title, element('p', 'H: パネル表示切替 · マウスで視線を操作'));
    this.status = element('p', 'モデルを読み込み中…', 'status');
    this.errors = element('p', '', 'status error');
    this.errors.setAttribute('role', 'alert');
    panel.append(this.status, this.errors);
    const buttons = element('div', null, 'buttons');
    this.cameraButton = element('button', 'カメラ開始');
    this.micButton = element('button', 'マイク開始');
    this.cameraButton.type = this.micButton.type = 'button';
    this.cameraButton.addEventListener('click', () => tracking.toggleCamera());
    this.micButton.addEventListener('click', () => tracking.toggleMic());
    buttons.append(this.cameraButton, this.micButton);
    this.screenshotButton = element('button', 'PNG 保存');
    this.screenshotButton.type = 'button';
    this.screenshotButton.disabled = true;
    this.screenshotButton.addEventListener('click', async () => {
      this.screenshotButton.disabled = true;
      try { await screenshot(); this.report('透明 PNG を保存しました。', false); }
      catch (error) { this.report(`画像保存: ${error.message}`); }
      finally { this.screenshotButton.disabled = false; }
    });
    buttons.append(this.screenshotButton);
    panel.append(buttons);
    this.expressionSection = element('section');
    this.expressionSection.hidden = true;
    this.expressionSection.append(element('h2', '表情'));
    this.expressionButtons = element('div', null, 'buttons');
    this.expressionSection.append(this.expressionButtons);
    this.expressionControls = new Map();
    panel.append(this.expressionSection);
    const backgroundLabel = element('label', '背景 ');
    const background = element('select');
    for (const [value, label] of [['transparent', '透明'], ['green', 'グリーン'], ['gray', 'グレー']]) {
      const option = element('option', label);
      option.value = value;
      background.append(option);
    }
    background.value = 'transparent';
    background.addEventListener('change', () => {
      settings.background = background.value;
      document.body.style.background = { transparent: 'transparent', green: '#00ff00', gray: '#666666' }[background.value];
    });
    backgroundLabel.append(background);
    panel.append(backgroundLabel);
    rangeControl(panel, { label: 'ズーム', min: 0.25, max: 3, step: 0.01, value: 1, onInput: value => { settings.zoom = value; } });
    this.offset = rangeControl(panel, { label: '上下位置', min: -2688, max: 2688, step: 1, value: 0, onInput: value => { settings.offsetY = value; } });
    const physicsSection = element('details');
    physicsSection.append(element('summary', '物理'));
    rangeControl(physicsSection, { label: '硬さ（全体）', min: 0.1, max: 3, step: 0.05, value: 1,
      onInput: value => { settings.stiffness = value; } });
    rangeControl(physicsSection, { label: '風（全体）', min: 0, max: 3, step: 0.05, value: 1,
      onInput: value => { settings.wind = value; } });
    panel.append(physicsSection);
    const parametersSection = element('details');
    parametersSection.open = true;
    parametersSection.append(element('summary', 'パラメーター'));
    panel.append(parametersSection);
    for (const [name, definition] of Object.entries(PARAMS)) {
      const control = rangeControl(parametersSection, {
        label: definition.label, min: definition.min, max: definition.max,
        step: definition.max > 1 ? 0.1 : 0.01, value: definition.initial,
        onInput: value => { parameters.set(name, value); control.auto.checked = false; },
      });
      const autoLabel = element('label', null, 'auto');
      const auto = element('input');
      auto.type = 'checkbox';
      auto.checked = true;
      auto.setAttribute('aria-label', `${definition.label}を自動制御`);
      auto.addEventListener('change', () => {
        if (auto.checked) parameters.release(name);
        else parameters.set(name, parameters.values[name]);
      });
      autoLabel.append(auto, document.createTextNode('自動'));
      control.row.insertBefore(autoLabel, control.input);
      control.auto = auto;
      this.controls.set(name, control);
    }
    this.parts = element('details');
    this.parts.append(element('summary', 'パーツ表示（デバッグ）'));
    rangeControl(this.parts, { label: '分解表示', min: 0, max: 2, step: 0.01, value: 0, onInput: value => { settings.explode = value; } });
    this.partList = element('div');
    this.parts.append(this.partList);
    panel.append(this.parts);
    window.addEventListener('keydown', event => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
          event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
      if (!obs && event.key.toLowerCase() === 'h') { panel.hidden = !panel.hidden; event.preventDefault(); }
      const expression = parameters.expressions.find(item => /^[1-9]$/.test(String(item.key)) && String(item.key) === event.key);
      if (expression) { this.toggleExpression(expression.id); event.preventDefault(); }
    });
  }

  setModel(model, layers) {
    this.title.textContent = model.name || '2D VTuber ビューアー';
    this.offset.input.min = -model.canvas[1];
    this.offset.input.max = model.canvas[1];
    this.screenshotButton.disabled = false;
    this.parameters.expressions = Array.isArray(model.expressions) ? model.expressions.filter(item => item && typeof item.id === 'string') : [];
    this.expressionSection.hidden = !this.parameters.expressions.length;
    for (const expression of this.parameters.expressions) {
      const key = /^[1-9]$/.test(String(expression.key)) ? `${expression.key}: ` : '';
      const button = element('button', key + (expression.label || expression.id));
      button.type = 'button';
      button.addEventListener('click', () => this.toggleExpression(expression.id));
      this.expressionControls.set(expression.id, button);
      this.expressionButtons.append(button);
    }
    for (const layer of layers) {
      const label = element('label', null, 'part');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = layer.visible;
      checkbox.disabled = Boolean(layer.loadError);
      checkbox.addEventListener('change', () => { layer.visible = checkbox.checked; });
      label.append(checkbox, document.createTextNode(` ${layer.id || '名称なし'}${layer.loadError ? '（読み込み失敗）' : ''}`));
      this.partList.append(label);
    }
    this.status.textContent = `${layers.length} パーツを読み込みました。`;
  }

  toggleExpression(id) {
    this.parameters.setExpression(this.parameters.expression === id ? null : id);
    this.update();
  }

  report(message, error = true) {
    if (error) this.errors.textContent += `${this.errors.textContent ? '\n' : ''}${message}`;
    else this.status.textContent = message;
  }

  updateDevices() {
    const tracking = this.tracking;
    this.cameraButton.disabled = tracking.cameraPending;
    this.cameraButton.textContent = tracking.cameraPending ? 'カメラ準備中…' : tracking.camera ? 'カメラ停止' : 'カメラ開始';
    this.cameraButton.setAttribute('aria-pressed', String(tracking.camera));
    this.micButton.disabled = tracking.micPending;
    this.micButton.textContent = tracking.micPending ? 'マイク準備中…' : tracking.mic ? 'マイク停止' : 'マイク開始';
    this.micButton.setAttribute('aria-pressed', String(tracking.mic));
  }

  update() {
    if (this.obs || this.panel.hidden) return;
    for (const [name, control] of this.controls) {
      const automatic = this.parameters.isAuto(name);
      const value = automatic ? this.parameters.values[name] : this.parameters.target(name);
      control.auto.checked = automatic;
      control.input.value = value;
      control.output.textContent = value.toFixed(PARAMS[name].max > 1 ? 1 : 2);
    }
    for (const [id, button] of this.expressionControls) button.setAttribute('aria-pressed', String(this.parameters.expression === id));
  }
}
