// =============================================================================
// compositor.js — WebGL2-accelerated layer compositing
//
// Ported from index.html L504–680. Ping-pong FBO approach with 16 CSS blend
// modes implemented in GLSL. Falls back to Canvas 2D if WebGL2 unavailable.
//
// Usage:
//   import { Compositor } from './compositor.js';
//   const comp = new Compositor(displayCanvas);
//   comp.composite(layers); // layers bottom → top
//   comp.resize(w, h, dpr);
//   comp.destroy();
// =============================================================================

const BLEND_MODE_MAP = {
  'source-over':0,'multiply':1,'screen':2,'overlay':3,
  'darken':4,'lighten':5,'color-dodge':6,'color-burn':7,
  'hard-light':8,'soft-light':9,'difference':10,'exclusion':11,
  'hue':12,'saturation':13,'color':14,'luminosity':15
};

// ----- GLSL shaders -----

const GL_VERT = `#version 300 es
layout(location=0)in vec2 aPos;
out vec2 vUV;
void main(){vUV=aPos*.5+.5;gl_Position=vec4(aPos,0,1);}`;

const GL_BLEND_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBase,uLayer;
uniform float uOpacity;
uniform int uMode;
in vec2 vUV;
out vec4 oColor;
vec3 rgb2hsl(vec3 c){
  float mx=max(c.r,max(c.g,c.b)),mn=min(c.r,min(c.g,c.b));
  float h=0.0,s=0.0,l=(mx+mn)*0.5,d=mx-mn;
  if(d>0.001){s=l>0.5?d/(2.0-mx-mn):d/(mx+mn);
    if(mx==c.r)h=(c.g-c.b)/d+(c.g<c.b?6.0:0.0);
    else if(mx==c.g)h=(c.b-c.r)/d+2.0;
    else h=(c.r-c.g)/d+4.0;h/=6.0;}
  return vec3(h,s,l);}
float hue2rgb(float p,float q,float t){
  if(t<0.0)t+=1.0;if(t>1.0)t-=1.0;
  if(t<1.0/6.0)return p+(q-p)*6.0*t;
  if(t<0.5)return q;
  if(t<2.0/3.0)return p+(q-p)*(2.0/3.0-t)*6.0;
  return p;}
vec3 hsl2rgb(vec3 c){
  if(c.y<0.001)return vec3(c.z);
  float q=c.z<0.5?c.z*(1.0+c.y):c.z+c.y-c.z*c.y,p=2.0*c.z-q;
  return vec3(hue2rgb(p,q,c.x+1.0/3.0),hue2rgb(p,q,c.x),hue2rgb(p,q,c.x-1.0/3.0));}
vec3 blend(vec3 b,vec3 s,int m){
  if(m==1)return b*s;
  if(m==2)return 1.0-(1.0-b)*(1.0-s);
  if(m==3)return mix(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),step(0.5,b));
  if(m==4)return min(b,s);
  if(m==5)return max(b,s);
  if(m==6)return min(b/(1.0-s+0.001),vec3(1.0));
  if(m==7)return max(1.0-(1.0-b)/(s+0.001),vec3(0.0));
  if(m==8)return mix(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),step(0.5,s));
  if(m==9)return mix(b*(2.0*s+b*(1.0-2.0*s)),sqrt(b)*(2.0*s-1.0)+2.0*b*(1.0-s),step(0.5,s));
  if(m==10)return abs(b-s);
  if(m==11)return b+s-2.0*b*s;
  vec3 bh=rgb2hsl(b),sh=rgb2hsl(s);
  if(m==12)return hsl2rgb(vec3(sh.x,bh.y,bh.z));
  if(m==13)return hsl2rgb(vec3(bh.x,sh.y,bh.z));
  if(m==14)return hsl2rgb(vec3(sh.x,sh.y,bh.z));
  if(m==15)return hsl2rgb(vec3(bh.x,bh.y,sh.z));
  return s;}
void main(){
  vec4 base=texture(uBase,vUV);
  vec4 layer=texture(uLayer,vUV);
  float sa=layer.a*uOpacity;
  if(sa<0.001){oColor=base;return;}
  float ra=sa+base.a*(1.0-sa);
  if(uMode==0){
    // Source-over: premultiplied Porter-Duff (no division, no precision loss)
    oColor=vec4(layer.rgb*uOpacity+base.rgb*(1.0-sa),ra);return;}
  // Non-trivial blend modes: un-premultiply for blend function
  vec3 Cb=base.a>0.001?base.rgb/base.a:vec3(0.0);
  vec3 Cs=layer.a>0.001?layer.rgb/layer.a:vec3(0.0);
  vec3 Cr=blend(Cb,Cs,uMode);
  // Output premultiplied (numerator of compositing formula)
  vec3 co=sa*(1.0-base.a)*Cs+sa*base.a*Cr+(1.0-sa)*base.a*Cb;
  oColor=vec4(co,ra);}`;

const GL_CHECKER_FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
in vec2 vUV;
out vec4 oColor;
void main(){
  vec2 p=vUV*uSize;float sz=10.0;
  float c=mod(floor(p.x/sz)+floor(p.y/sz),2.0);
  oColor=vec4(mix(vec3(0.784),vec3(0.878),c),1.0);}`;

const GL_PASS_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
out vec4 oColor;
void main(){oColor=texture(uTex,vUV);}`;

export class Compositor {
  constructor(displayCanvas) {
    this.canvas = displayCanvas;
    this.gl = null;
    this.ready = false;
    this._prog = null;
    this._checkerProg = null;
    this._passProg = null;
    this._fbo = [null, null];
    this._fboTex = [null, null];
    this._vao = null;
    this._w = 0;
    this._h = 0;
    this._initGL();
  }

  get gpuReady() { return this.ready; }

  // ---- Public API ----

  /** Composite layers array (index 0 = top, last = bottom) onto display canvas. */
  composite(layers, cssW, cssH) {
    if (this.ready) {
      this._compositeGL(layers, cssW, cssH);
    } else {
      this._composite2D(layers, cssW, cssH);
    }
  }

  /** Resize internal FBOs after canvas dimension change. */
  resize(w, h, dpr) {
    this._w = w;
    this._h = h;
    if (!this.ready) return;
    const gl = this.gl;
    const pw = w * dpr, ph = h * dpr;
    gl.viewport(0, 0, pw, ph);
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Read pixel at CSS coords (for eyedropper). Returns [r,g,b,a]. */
  readPixel(x, y, dpr) {
    if (!this.ready) return [0, 0, 0, 0];
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(x * dpr), gl.drawingBufferHeight - 1 - Math.round(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  /** Clean up all GL resources. */
  destroy() {
    if (!this.gl) return;
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      if (this._fbo[i]) gl.deleteFramebuffer(this._fbo[i]);
      if (this._fboTex[i]) gl.deleteTexture(this._fboTex[i]);
    }
    this.ready = false;
    this.gl = null;
  }

  /** Delete a layer's GL texture (call before discarding a layer). */
  deleteLayerTex(layer) {
    if (layer.glTex && this.gl) {
      this.gl.deleteTexture(layer.glTex);
      layer.glTex = null;
    }
  }

  // ---- GL init ----

  _initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true
    });
    if (!gl) { console.warn('WebGL2 unavailable — CPU compositing'); return; }
    this.gl = gl;

    const compile = (src, type) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader fail:', gl.getShaderInfoLog(s));
        gl.deleteShader(s); return null;
      }
      return s;
    };
    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('Link fail:', gl.getProgramInfoLog(p)); return null;
      }
      return p;
    };

    const bvs = compile(GL_VERT, gl.VERTEX_SHADER), bfs = compile(GL_BLEND_FRAG, gl.FRAGMENT_SHADER);
    const cvs = compile(GL_VERT, gl.VERTEX_SHADER), cfs = compile(GL_CHECKER_FRAG, gl.FRAGMENT_SHADER);
    const pvs = compile(GL_VERT, gl.VERTEX_SHADER), pfs = compile(GL_PASS_FRAG, gl.FRAGMENT_SHADER);
    if (!bvs || !bfs || !cvs || !cfs || !pvs || !pfs) {
      console.warn('Shader compilation failed — CPU compositing');
      this.gl = null; return;
    }

    this._prog = link(bvs, bfs);
    this._checkerProg = link(cvs, cfs);
    this._passProg = link(pvs, pfs);
    if (!this._prog || !this._checkerProg || !this._passProg) {
      this.gl = null; return;
    }

    // Full-screen quad
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Ping-pong FBOs
    for (let i = 0; i < 2; i++) {
      this._fboTex[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex[i]);
      this._initTex(gl);
      this._fbo[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fboTex[i], 0);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.ready = true;
  }

  _initTex(gl) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---- GPU composite ----

  _compositeGL(layers, cssW, cssH) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this._vao);

    // Pass 1: checkerboard → FBO 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[0]);
    gl.useProgram(this._checkerProg);
    gl.uniform2f(gl.getUniformLocation(this._checkerProg, 'uSize'), cssW, cssH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: blend layers bottom → top
    let src = 0, dst = 1;
    gl.useProgram(this._prog);
    const uBase = gl.getUniformLocation(this._prog, 'uBase');
    const uLayer = gl.getUniformLocation(this._prog, 'uLayer');
    const uOpacity = gl.getUniformLocation(this._prog, 'uOpacity');
    const uMode = gl.getUniformLocation(this._prog, 'uMode');

    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.visible) continue;
      if (!l.glTex) {
        l.glTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, l.glTex);
        this._initTex(gl);
        l.dirty = true;
      }
      if (l.dirty) {
        gl.bindTexture(gl.TEXTURE_2D, l.glTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.canvas);
        l.dirty = false;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[dst]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex[src]);
      gl.uniform1i(uBase, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, l.glTex);
      gl.uniform1i(uLayer, 1);
      gl.uniform1f(uOpacity, l.opacity);
      gl.uniform1i(uMode, BLEND_MODE_MAP[l.blend] || 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const tmp = src; src = dst; dst = tmp;
    }

    // Final blit to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this._passProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._fboTex[src]);
    gl.uniform1i(gl.getUniformLocation(this._passProg, 'uTex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // ---- 2D fallback ----

  _composite2D(layers, cssW, cssH) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.canvas.width / cssW;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Checkerboard
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#e0e0e0';
    const sz = 10;
    for (let y = 0; y < cssH; y += sz)
      for (let x = 0; x < cssW; x += sz)
        if ((Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0) ctx.fillRect(x, y, sz, sz);
    // Layers bottom → top
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      ctx.drawImage(l.canvas, 0, 0, l.canvas.width, l.canvas.height, 0, 0, cssW, cssH);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}

export { BLEND_MODE_MAP };
