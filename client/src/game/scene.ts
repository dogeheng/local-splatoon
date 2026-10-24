import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  ARENA_H, ARENA_W, GRID_H, GRID_W, SPAWN_BARRIER_R, TEAM_COLORS, TEAM_COLORS_DARK,
} from '../../../shared/constants';
import { SPAWNS, WALLS } from '../../../shared/arena';

export interface Insets { left: number; right: number; top: number; bottom: number }

const NOISE_GLSL = /* glsl */ `
float sa_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float sa_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sa_hash(i), sa_hash(i + vec2(1.0, 0.0)), u.x),
             mix(sa_hash(i + vec2(0.0, 1.0)), sa_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly paintData: Uint8Array;
  readonly paintTex: THREE.DataTexture;
  private floorUniforms = { uTime: { value: 0 } };
  private barriers: THREE.Mesh[] = [];
  private insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private camBase = new THREE.Vector3();
  private camTarget = new THREE.Vector3(ARENA_W / 2, 0, ARENA_H / 2);
  private shake = 0;
  readonly gradientMap: THREE.DataTexture;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#e9e4f2');

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 200);

    // 卡通渐变贴图（三阶）
    const g = new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
    this.gradientMap = new THREE.DataTexture(g, 3, 1, THREE.RGBAFormat);
    this.gradientMap.minFilter = THREE.NearestFilter;
    this.gradientMap.magFilter = THREE.NearestFilter;
    this.gradientMap.needsUpdate = true;

    // 灯光
    const hemi = new THREE.HemisphereLight('#ffffff', '#b8aed6', 1.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff4e0', 2.3);
    sun.position.set(ARENA_W / 2 - 14, 30, ARENA_H / 2 - 12);
    sun.target.position.set(ARENA_W / 2, 0, ARENA_H / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -28; sc.right = 28; sc.top = 22; sc.bottom = -22; sc.near = 5; sc.far = 80;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    // 涂色贴图（RGBA：R=橙，G=青）
    this.paintData = new Uint8Array(GRID_W * GRID_H * 4);
    this.paintTex = new THREE.DataTexture(this.paintData, GRID_W, GRID_H, THREE.RGBAFormat);
    this.paintTex.minFilter = THREE.LinearFilter;
    this.paintTex.magFilter = THREE.LinearFilter;
    this.paintTex.wrapS = THREE.ClampToEdgeWrapping;
    this.paintTex.wrapT = THREE.ClampToEdgeWrapping;
    this.paintTex.needsUpdate = true;

    this.buildArena();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private buildArena(): void {
    // 场地外的大地面
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 160),
      new THREE.MeshStandardMaterial({ color: '#d9d2ea', roughness: 1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(ARENA_W / 2, -0.32, ARENA_H / 2);
    outer.receiveShadow = true;
    this.scene.add(outer);

    // 基座
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(ARENA_W + 1.6, 0.6, ARENA_H + 1.6, 3, 0.25),
      new THREE.MeshStandardMaterial({ color: '#3b3060', roughness: 0.8 }),
    );
    base.position.set(ARENA_W / 2, -0.31, ARENA_H / 2);
    base.receiveShadow = true;
    this.scene.add(base);

    // 涂色地面
    const floorMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0 });
    const u = this.floorUniforms;
    const paintTex = this.paintTex;
    floorMat.onBeforeCompile = (shader) => {
      shader.uniforms.uPaint = { value: paintTex };
      shader.uniforms.uColA = { value: new THREE.Color(TEAM_COLORS[0]) };
      shader.uniforms.uColB = { value: new THREE.Color(TEAM_COLORS[1]) };
      shader.uniforms.uTime = u.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPaintPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaintPos = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vPaintPos;
          uniform sampler2D uPaint;
          uniform vec3 uColA;
          uniform vec3 uColB;
          uniform float uTime;
          ${NOISE_GLSL}`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec2 tileId = floor(vPaintPos / 2.0);
          float tv = sa_hash(tileId);
          vec3 baseCol = mix(vec3(0.90, 0.88, 0.94), vec3(0.83, 0.81, 0.89), tv);
          vec2 fw = fract(vPaintPos / 2.0);
          float seam = max(1.0 - smoothstep(0.0, 0.035, fw.x), 1.0 - smoothstep(0.0, 0.035, fw.y));
          baseCol *= 1.0 - 0.09 * seam;
          vec2 jit = (vec2(sa_noise(vPaintPos * 3.3), sa_noise(vPaintPos * 3.3 + 17.0)) - 0.5) * 0.2;
          vec2 puv = (vPaintPos + jit) / vec2(${ARENA_W.toFixed(1)}, ${ARENA_H.toFixed(1)});
          vec4 pt = texture2D(uPaint, puv);
          float n = sa_noise(vPaintPos * 7.0) - 0.5;
          float va = pt.r + n * 0.14;
          float vb = pt.g + n * 0.14;
          float ca = smoothstep(0.44, 0.52, va);
          float cb = smoothstep(0.44, 0.52, vb);
          bool isA = va >= vb;
          float cov = isA ? ca : cb;
          float depth = smoothstep(0.5, 0.9, isA ? va : vb);
          vec3 inkCol = isA ? uColA : uColB;
          inkCol = mix(inkCol * 0.72, inkCol * 1.04, depth);
          float gloss = sa_noise(vPaintPos * 1.3 + vec2(uTime * 0.04, 0.0));
          inkCol += vec3(0.10) * smoothstep(0.62, 0.92, gloss) * depth;
          diffuseColor.rgb = mix(baseCol, inkCol, cov);
          float paintCov = cov;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.32, paintCov);`,
        );
    };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_H, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ARENA_W / 2, 0, ARENA_H / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 障碍物
    const wallMat = new THREE.MeshStandardMaterial({ color: '#f1edf8', roughness: 0.7 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#4a3e78', roughness: 0.6 });
    for (const w of WALLS) {
      const sx = w.x1 - w.x0;
      const sz = w.z1 - w.z0;
      const m = new THREE.Mesh(new RoundedBoxGeometry(sx, w.h, sz, 3, 0.16), wallMat);
      m.position.set((w.x0 + w.x1) / 2, w.h / 2, (w.z0 + w.z1) / 2);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      const cap = new THREE.Mesh(new RoundedBoxGeometry(sx + 0.06, 0.14, sz + 0.06, 2, 0.06), capMat);
      cap.position.set(m.position.x, w.h + 0.02, m.position.z);
      cap.castShadow = true;
      this.scene.add(cap);
    }

    // 出生点与屏障
    for (let t = 0; t < 2; t++) {
      const s = SPAWNS[t];
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 2.05, 0.14, 48),
        new THREE.MeshStandardMaterial({ color: TEAM_COLORS_DARK[t], roughness: 0.4, emissive: TEAM_COLORS[t], emissiveIntensity: 0.25 }),
      );
      pad.position.set(s.x, 0.07, s.z);
      pad.receiveShadow = true;
      this.scene.add(pad);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.55, 0.07, 8, 64),
        new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(s.x, 0.16, s.z);
      this.scene.add(ring);

      const barrierMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color(TEAM_COLORS[t]) }, uTime: this.floorUniforms.uTime },
        vertexShader: /* glsl */ `
          varying vec3 vN; varying vec3 vP; varying vec3 vView;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vP = position;
            vN = normalize(mat3(modelMatrix) * normal);
            vView = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime;
          varying vec3 vN; varying vec3 vP; varying vec3 vView;
          void main() {
            float fres = pow(1.0 - abs(dot(normalize(vN), vView)), 2.0);
            float bands = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 2.0);
            float a = 0.08 + fres * 0.45 + bands * 0.05;
            gl_FragColor = vec4(uColor * (0.9 + fres), a);
          }`,
      });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(SPAWN_BARRIER_R, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), barrierMat);
      dome.position.set(s.x, 0, s.z);
      dome.scale.y = 0.55;
      dome.renderOrder = 5;
      this.barriers.push(dome);
      this.scene.add(dome);
    }
  }

  /** 把整张地面或部分格子写入涂色贴图。 */
  writePaint(cells: Uint8Array, indices?: number[]): void {
    const d = this.paintData;
    const put = (i: number) => {
      const v = cells[i];
      d[i * 4] = v === 1 ? 255 : 0;
      d[i * 4 + 1] = v === 2 ? 255 : 0;
    };
    if (indices) for (const i of indices) put(i);
    else for (let i = 0; i < cells.length; i++) put(i);
    this.paintTex.needsUpdate = true;
  }

  setInsets(ins: Insets): void {
    this.insets = ins;
    this.fit();
  }

  addShake(amount: number): void {
    this.shake = Math.min(0.6, this.shake + amount);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fit();
  }

  /** 二分查找镜头距离，让整个场地完整落在可用区域内。 */
  private fit(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const el = (58 * Math.PI) / 180;
    const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
    const ins = this.insets;
    const ndc = {
      l: -1 + (2 * (ins.left + 16)) / w,
      r: 1 - (2 * (ins.right + 16)) / w,
      t: 1 - (2 * (ins.top + 10)) / h,
      b: -1 + (2 * (ins.bottom + 10)) / h,
    };
    // 让场地中心对准可用区域中心
    const corners = [
      new THREE.Vector3(-0.8, 0, -0.8), new THREE.Vector3(ARENA_W + 0.8, 0, -0.8),
      new THREE.Vector3(-0.8, 0, ARENA_H + 0.8), new THREE.Vector3(ARENA_W + 0.8, 0, ARENA_H + 0.8),
      new THREE.Vector3(-0.8, 1.8, -0.8), new THREE.Vector3(ARENA_W + 0.8, 1.8, -0.8),
    ];
    let target = new THREE.Vector3(ARENA_W / 2, 0, ARENA_H / 2);
    let lo = 10;
    let hi = 200;
    for (let iter = 0; iter < 3; iter++) {
      lo = 10;
      hi = 200;
      for (let i = 0; i < 30; i++) {
        const d = (lo + hi) / 2;
        this.camera.position.copy(target).addScaledVector(dir, d);
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld();
        let ok = true;
        for (const c of corners) {
          const p = c.clone().project(this.camera);
          if (p.x < ndc.l || p.x > ndc.r || p.y > ndc.t || p.y < ndc.b) {
            ok = false;
            break;
          }
        }
        if (ok) hi = d;
        else lo = d;
      }
      // 计算投影包围盒中心与可用区域中心的偏差，平移目标点
      this.camera.position.copy(target).addScaledVector(dir, hi);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      let minX = 9, maxX = -9, minY = 9, maxY = -9;
      for (const c of corners) {
        const p = c.clone().project(this.camera);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2 - (ndc.l + ndc.r) / 2;
      const cy = (minY + maxY) / 2 - (ndc.t + ndc.b) / 2;
      // 近似换算：NDC 偏差 → 世界偏移
      const halfH = Math.tan((this.camera.fov * Math.PI) / 360) * hi;
      const halfW = halfH * this.camera.aspect;
      target = target.clone();
      target.x += cx * halfW;
      target.z -= (cy * halfH) / Math.sin(el);
    }
    this.camTarget.copy(target);
    this.camBase.copy(target).addScaledVector(dir, hi * 1.0);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camTarget);
  }

  /** 屏幕坐标 → 地面（y = h）上的世界坐标。 */
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  screenToGround(sx: number, sy: number, h = 0): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    this.plane.constant = -h;
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  worldToScreen(v: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight, visible: p.z < 1 };
  }

  render(dt: number, timeS: number): void {
    this.floorUniforms.uTime.value = timeS;
    if (this.shake > 0.001) {
      this.shake *= Math.exp(-dt * 9);
      const s = this.shake;
      this.camera.position.set(
        this.camBase.x + (Math.random() - 0.5) * s,
        this.camBase.y + (Math.random() - 0.5) * s * 0.5,
        this.camBase.z + (Math.random() - 0.5) * s,
      );
    } else this.camera.position.copy(this.camBase);
    this.renderer.render(this.scene, this.camera);
  }
}
