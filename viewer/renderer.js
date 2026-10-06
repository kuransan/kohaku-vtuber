const VERTEX = `
attribute vec2 a_position;
attribute vec2 a_uv;
uniform vec2 u_modelSize;
uniform vec2 u_viewport;
uniform float u_scale;
uniform float u_offsetY;
varying vec2 v_uv;
void main() {
  vec2 screen = (a_position - u_modelSize * 0.5) * u_scale;
  screen.y += u_offsetY;
  gl_Position = vec4(screen.x * 2.0 / u_viewport.x, -screen.y * 2.0 / u_viewport.y, 0.0, 1.0);
  v_uv = a_uv;
}`;
const FRAGMENT = `
precision highp float;
uniform sampler2D u_texture;
uniform sampler2D u_mask;
uniform vec2 u_viewport;
uniform float u_opacity;
uniform bool u_maskEnabled;
varying vec2 v_uv;
void main() {
  vec4 color = texture2D(u_texture, v_uv) * u_opacity;
  if (u_maskEnabled) color *= texture2D(u_mask, gl_FragCoord.xy / u_viewport).a;
  gl_FragColor = color;
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`シェーダーを作成できません: ${message}`);
  }
  return shader;
}

function createMesh(gl, descriptor) {
  const [x, y, width, height] = descriptor.rect;
  const dense = descriptor.physics || descriptor.dome;
  const cell = dense ? 16 : 24, cap = dense ? 64 : 40;
  const columns = Math.min(cap, Math.max(1, Math.ceil(width / cell)));
  const rows = Math.min(cap, Math.max(1, Math.ceil(height / cell)));
  const rest = new Float32Array((columns + 1) * (rows + 1) * 2);
  const uv = new Float32Array(rest.length);
  let cursor = 0;
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      rest[cursor] = x + column / columns * width;
      rest[cursor + 1] = y + row / rows * height;
      uv[cursor] = column / columns;
      uv[cursor + 1] = row / rows;
      cursor += 2;
    }
  }
  const indices = new Uint16Array(columns * rows * 6);
  cursor = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column, b = a + columns + 1;
      indices.set([a, b, a + 1, a + 1, b, b + 1], cursor);
      cursor += 6;
    }
  }
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, rest, gl.DYNAMIC_DRAW);
  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return { ...descriptor, rest, positions: rest.slice(), positionBuffer, uvBuffer,
    indexBuffer, indexCount: indices.length, visible: true, opacity: 1, texture: null };
}

export class Renderer {
  constructor(canvas, { preserveDrawingBuffer = false, size = null } = {}) {
    this.canvas = canvas;
    this.fixedSize = size;
    const attributes = { alpha: true, premultipliedAlpha: true,
      antialias: true, depth: false, stencil: false, preserveDrawingBuffer };
    this.gl = canvas.getContext('webgl2', attributes);
    this.webgl2 = Boolean(this.gl);
    this.gl ||= canvas.getContext('webgl', attributes);
    if (!this.gl) throw new Error('WebGL を利用できません。ブラウザーのハードウェアアクセラレーションを確認してください。');
    const gl = this.gl;
    const vertexSource = this.webgl2 ? '#version 300 es\n' + VERTEX.replaceAll('attribute ', 'in ').replaceAll('varying ', 'out ') : VERTEX;
    const fragmentSource = this.webgl2 ? '#version 300 es\n' + FRAGMENT.replace('precision highp float;',
      'precision highp float;\nout vec4 fragmentColor;').replaceAll('varying ', 'in ')
      .replaceAll('texture2D(', 'texture(').replaceAll('gl_FragColor', 'fragmentColor') : FRAGMENT;
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    this.maxAnisotropy = this.anisotropy ? Math.min(8, gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('シェーダーをリンクできません。');
    this.attributes = Object.fromEntries(['position', 'uv'].map(name => [name, gl.getAttribLocation(this.program, `a_${name}`)]));
    this.uniforms = Object.fromEntries(['modelSize', 'viewport', 'scale', 'offsetY', 'texture', 'mask', 'opacity', 'maskEnabled']
      .map(name => [name, gl.getUniformLocation(this.program, `u_${name}`)]));
    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform1i(this.uniforms.mask, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.emptyTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.maskTexture = gl.createTexture();
    this.maskFramebuffer = gl.createFramebuffer();
    this.layers = [];
    this.model = null;
    this.zoom = 1;
    this.offsetY = 0;
  }

  async load(model, modelUrl, report) {
    if (!Array.isArray(model.canvas) || model.canvas.length !== 2 || !model.canvas.every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('model.json の canvas が不正です。');
    }
    if (!Array.isArray(model.layers)) throw new Error('model.json の layers が不正です。');
    this.model = model;
    this.layers = model.layers.map(descriptor => {
      if (!Array.isArray(descriptor.rect) || descriptor.rect.length !== 4 ||
          !descriptor.rect.every(Number.isFinite) || descriptor.rect[2] <= 0 || descriptor.rect[3] <= 0) {
        throw new Error(`レイヤー ${descriptor.id || '名称なし'} の rect が不正です。`);
      }
      return createMesh(this.gl, descriptor);
    });
    this.byId = new Map(this.layers.map(layer => [layer.id, layer]));
    await Promise.all(this.layers.map(async layer => {
      try {
        if (typeof layer.file !== 'string') throw new Error('画像ファイルが指定されていません');
        const loaded = await this.loadTexture(new URL(layer.file, modelUrl).href);
        layer.texture = loaded.texture;
        layer.image = loaded.image;
      } catch (error) {
        layer.loadError = error.message;
        report(`${layer.id || '名称なし'}: ${error.message}`);
      }
    }));
    this.resize();
    return this.layers;
  }

  loadTexture(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onerror = () => reject(new Error(`画像を読み込めません: ${url}`));
      image.onload = () => {
        try {
          resolve({ texture: this.uploadTexture(image), image });
        } catch (error) {
          reject(error);
        }
      };
      image.src = url;
    });
  }

  uploadTexture(image) {
    const gl = this.gl;
    const width = image.naturalWidth, height = image.naturalHeight;
    if (Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('画像が GPU の最大テクスチャサイズを超えています。');
    const texture = gl.createTexture();
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // WebGL1 cannot mipmap NPOT textures. Keep native pixels with linear filtering there.
      const mipmaps = this.webgl2 || ((width & (width - 1)) === 0 && (height & (height - 1)) === 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    }
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = this.fixedSize?.[0] ?? Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = this.fixedSize?.[1] ?? Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (width === this.canvas.width && height === this.canvas.height && this.maskReady) return;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTexture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    if (!complete) throw new Error('目のクリップ用バッファーを作成できません。');
    this.maskReady = true;
  }

  drawLayer(layer, maskEnabled = false, opacity = layer.opacity) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
    gl.vertexAttribPointer(this.attributes.position, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.attributes.position);
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.uvBuffer);
    gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.attributes.uv);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.indexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskEnabled ? this.maskTexture : this.emptyTexture);
    gl.uniform1f(this.uniforms.opacity, opacity);
    gl.uniform1i(this.uniforms.maskEnabled, maskEnabled ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, layer.indexCount, gl.UNSIGNED_SHORT, 0);
  }

  render() {
    const gl = this.gl;
    this.resize();
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uniforms.modelSize, ...this.model.canvas);
    gl.uniform2f(this.uniforms.viewport, this.canvas.width, this.canvas.height);
    const scale = Math.min(this.canvas.width / this.model.canvas[0], this.canvas.height / this.model.canvas[1]) * this.zoom;
    gl.uniform1f(this.uniforms.scale, scale);
    // Y offset is in model pixels, making it independent of window size and DPR.
    gl.uniform1f(this.uniforms.offsetY, this.offsetY * scale);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const layer of this.layers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, layer.positions);
    }
    for (const layer of this.layers) {
      if (!layer.visible || !layer.texture || layer.opacity < 0.001) continue;
      const clip = layer.role === 'iris' ? this.byId.get(layer.clip) : null;
      if (clip?.texture) {
        if (!clip.visible || clip.opacity < 0.001) continue;
        // Render the actual deformed eye alpha; no inverse deformation approximation.
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.drawLayer(clip, false, 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this.drawLayer(layer, Boolean(clip?.texture));
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  toModelPoint(clientX, clientY) {
    const bounds = this.canvas.getBoundingClientRect();
    const scale = Math.min(bounds.width / this.model.canvas[0], bounds.height / this.model.canvas[1]) * this.zoom;
    return [(clientX - bounds.left - bounds.width / 2) / scale + this.model.canvas[0] / 2,
      (clientY - bounds.top - bounds.height / 2) / scale + this.model.canvas[1] / 2 - this.offsetY];
  }

  async screenshot() {
    // Context attributes cannot be toggled on an existing canvas. Preserve only this
    // one-frame context, then dispose it; the live renderer keeps its fast default.
    const canvas = document.createElement('canvas');
    const capture = new Renderer(canvas, { preserveDrawingBuffer: true, size: [this.canvas.width, this.canvas.height] });
    try {
      capture.model = this.model;
      capture.zoom = this.zoom;
      capture.offsetY = this.offsetY;
      for (const source of this.layers) {
        const layer = createMesh(capture.gl, source);
        capture.layers.push(layer);
        layer.positions.set(source.positions);
        layer.visible = source.visible;
        layer.opacity = source.opacity;
        if (source.image) layer.texture = capture.uploadTexture(source.image);
      }
      capture.byId = new Map(capture.layers.map(layer => [layer.id, layer]));
      capture.render();
      return await new Promise((resolve, reject) => canvas.toBlob(blob =>
        blob ? resolve(blob) : reject(new Error('PNG を保存できません。')), 'image/png'));
    } finally { capture.dispose(); }
  }

  dispose() {
    const gl = this.gl;
    for (const layer of this.layers) {
      gl.deleteBuffer(layer.positionBuffer); gl.deleteBuffer(layer.uvBuffer); gl.deleteBuffer(layer.indexBuffer);
      if (layer.texture) gl.deleteTexture(layer.texture);
    }
    gl.deleteTexture(this.emptyTexture); gl.deleteTexture(this.maskTexture);
    gl.deleteFramebuffer(this.maskFramebuffer); gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
