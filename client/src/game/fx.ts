import * as THREE from 'three';
import { BOMB_DMG_R, SHOT_SPEED, TEAM_COLORS } from '../../../shared/constants';

interface Proj {
  id: number;
  team: number;
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  len: number;
  t0: number; // 本地发射时间（秒）
  big: boolean;
  onLand?: (x: number, z: number) => void;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number; size: number;
  color: THREE.Color;
}

interface BombFx {
  id: number;
  mesh: THREE.Mesh;
  ring: THREE.Mesh;
  x0: number; z0: number; tx: number; tz: number;
  tThrow: number; tLand: number; tBoom: number; // 本地秒
  team: number;
  landed: boolean;
}

interface RingFx { mesh: THREE.Mesh; t: number; dur: number; r0: number; r1: number }

const MAX_PROJ = 300;
const MAX_PART = 1400;

export class Effects {
  private projMesh: THREE.InstancedMesh;
  private partMesh: THREE.InstancedMesh;
  private projs: Proj[] = [];
  private parts: Particle[] = [];
  private bombs = new Map<number, BombFx>();
  private rings: RingFx[] = [];
  private dummy = new THREE.Object3D();
  private teamCol = TEAM_COLORS.map((c) => new THREE.Color(c));
  readonly reticle: THREE.Group;
  private arcDots: THREE.InstancedMesh;
  private bombRangeRing: THREE.Mesh;
  onBombLand: ((team: number) => void) | null = null;

  constructor(private scene: THREE.Scene, gradientMap: THREE.Texture) {
    const dropGeo = new THREE.SphereGeometry(0.15, 10, 8);
    this.projMesh = new THREE.InstancedMesh(dropGeo, new THREE.MeshToonMaterial({ gradientMap }), MAX_PROJ);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false;
    this.projMesh.castShadow = true;
    this.projMesh.count = 0;
    scene.add(this.projMesh);

    const partGeo = new THREE.SphereGeometry(0.1, 8, 6);
    this.partMesh = new THREE.InstancedMesh(partGeo, new THREE.MeshToonMaterial({ gradientMap }), MAX_PART);
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.frustumCulled = false;
    this.partMesh.count = 0;
    scene.add(this.partMesh);
    // 预先分配实例颜色
    for (let i = 0; i < MAX_PROJ; i++) this.projMesh.setColorAt(i, this.teamCol[0]);
    for (let i = 0; i < MAX_PART; i++) this.partMesh.setColorAt(i, this.teamCol[0]);

    // 准星
    this.reticle = new THREE.Group();
    const rmat = new THREE.MeshBasicMaterial({ color: '#1b1530', transparent: true, opacity: 0.75, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.36, 32), rmat);
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), rmat);
    dot.rotation.x = -Math.PI / 2;
    this.reticle.add(ring, dot);
    this.reticle.position.y = 0.03;
    this.reticle.renderOrder = 10;
    scene.add(this.reticle);

    // 炸弹投掷预览
    this.arcDots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 }),
      16,
    );
    this.arcDots.visible = false;
    this.arcDots.frustumCulled = false;
    scene.add(this.arcDots);
    this.bombRangeRing = new THREE.Mesh(
      new THREE.RingGeometry(BOMB_DMG_R - 0.08, BOMB_DMG_R, 48),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.bombRangeRing.rotation.x = -Math.PI / 2;
    this.bombRangeRing.visible = false;
    scene.add(this.bombRangeRing);
  }

  /** 发射一发墨弹的视觉效果。age 为已飞行时间（秒），用于补偿网络延迟。 */
  shot(id: number, team: number, x0: number, z0: number, angle: number, len: number, now: number, age: number, big: boolean, onLand?: (x: number, z: number) => void): void {
    if (this.projs.length >= MAX_PROJ) this.projs.shift();
    this.projs.push({ id, team, x0, z0, dx: Math.cos(angle), dz: Math.sin(angle), len, t0: now - age, big, onLand });
  }

  /** 服务器判定命中玩家：提前结束这发墨弹的显示。 */
  killShot(predicate: (p: Proj) => boolean, burstAt = true): void {
    const keep: Proj[] = [];
    for (const p of this.projs) {
      if (predicate(p)) {
        if (burstAt) {
          const now = performance.now() / 1000;
          const d = Math.min(p.len, (now - p.t0) * SHOT_SPEED);
          this.splash(p.x0 + p.dx * d, 0.45, p.z0 + p.dz * d, p.team, 7, 3);
        }
      } else keep.push(p);
    }
    this.projs = keep;
  }

  findShot(id: number): boolean {
    return this.projs.some((p) => p.id === id);
  }

  splash(x: number, y: number, z: number, team: number, count: number, power: number, size = 1): void {
    const col = this.teamCol[team];
    for (let i = 0; i < count; i++) {
      if (this.parts.length >= MAX_PART) this.parts.shift();
      const a = Math.random() * Math.PI * 2;
      const s = power * (0.4 + Math.random() * 0.8);
      this.parts.push({
        x, y, z,
        vx: Math.cos(a) * s, vy: 2 + Math.random() * power * 1.4, vz: Math.sin(a) * s,
        life: 0, max: 0.35 + Math.random() * 0.4, size: size * (0.6 + Math.random() * 0.9), color: col,
      });
    }
  }

  ring(x: number, z: number, team: number | 'lime', r0: number, r1: number, dur: number): void {
    const color = team === 'lime' ? new THREE.Color('#c6f432') : this.teamCol[team];
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.06, z);
    this.scene.add(m);
    this.rings.push({ mesh: m, t: 0, dur, r0, r1 });
  }

  bomb(id: number, team: number, x0: number, z0: number, tx: number, tz: number, tThrow: number, tLand: number, tBoom: number): void {
    if (this.bombs.has(id)) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 18, 14),
      new THREE.MeshStandardMaterial({ color: this.teamCol[team], emissive: this.teamCol[team], emissiveIntensity: 0.3, roughness: 0.3 }),
    );
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 6, 24), new THREE.MeshStandardMaterial({ color: '#1b1530' }));
    band.rotation.x = Math.PI / 2;
    mesh.add(band);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(BOMB_DMG_R - 0.1, BOMB_DMG_R, 48),
      new THREE.MeshBasicMaterial({ color: this.teamCol[team], transparent: true, opacity: 0, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(tx, 0.05, tz);
    this.scene.add(ring);
    this.bombs.set(id, { id, mesh, ring, x0, z0, tx, tz, tThrow, tLand, tBoom, team, landed: false });
  }

  boom(id: number, x: number, z: number, team: number): void {
    const b = this.bombs.get(id);
    if (b) {
      this.scene.remove(b.mesh, b.ring);
      this.bombs.delete(id);
    }
    this.splash(x, 0.3, z, team, 70, 7, 1.6);
    this.ring(x, z, team, 0.4, BOMB_DMG_R + 0.4, 0.45);
  }

  showBombPreview(show: boolean, fromX = 0, fromZ = 0, toX = 0, toZ = 0): void {
    this.arcDots.visible = show;
    this.bombRangeRing.visible = show;
    if (!show) return;
    for (let i = 0; i < 16; i++) {
      const t = (i + 1) / 16;
      const x = fromX + (toX - fromX) * t;
      const z = fromZ + (toZ - fromZ) * t;
      const y = 0.6 + 4 * t * (1 - t) * 1.8;
      this.dummy.position.set(x, y, z);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.arcDots.setMatrixAt(i, this.dummy.matrix);
    }
    this.arcDots.instanceMatrix.needsUpdate = true;
    this.bombRangeRing.position.set(toX, 0.05, toZ);
  }

  update(dt: number): void {
    const now = performance.now() / 1000;
    // 墨弹
    const keep: Proj[] = [];
    let n = 0;
    for (const p of this.projs) {
      const d = (now - p.t0) * SHOT_SPEED;
      if (d >= p.len) {
        const ex = p.x0 + p.dx * p.len;
        const ez = p.z0 + p.dz * p.len;
        this.splash(ex, 0.15, ez, p.team, p.big ? 9 : 6, p.big ? 3.2 : 2.4);
        p.onLand?.(ex, ez);
        continue;
      }
      keep.push(p);
      const t = d / Math.max(0.01, p.len);
      this.dummy.position.set(p.x0 + p.dx * d, 0.55 - 0.4 * t * t + 0.12 * Math.sin(t * Math.PI), p.z0 + p.dz * d);
      const s = p.big ? 1.35 : 1;
      this.dummy.scale.set(s * 1.5, s * 0.85, s * 0.85);
      this.dummy.rotation.set(0, -Math.atan2(p.dz, p.dx), 0);
      this.dummy.updateMatrix();
      this.projMesh.setMatrixAt(n, this.dummy.matrix);
      this.projMesh.setColorAt(n, this.teamCol[p.team]);
      n++;
    }
    this.projs = keep;
    this.projMesh.count = n;
    this.projMesh.instanceMatrix.needsUpdate = true;
    if (this.projMesh.instanceColor) this.projMesh.instanceColor.needsUpdate = true;

    // 粒子
    const alive: Particle[] = [];
    let m = 0;
    for (const q of this.parts) {
      q.life += dt;
      if (q.life >= q.max) continue;
      q.vy -= 22 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z += q.vz * dt;
      if (q.y < 0.03) {
        q.y = 0.03;
        q.vx *= 0.5;
        q.vz *= 0.5;
        q.vy = 0;
      }
      alive.push(q);
      const k = q.size * (1 - q.life / q.max);
      this.dummy.position.set(q.x, q.y, q.z);
      this.dummy.scale.set(k, k, k);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.partMesh.setMatrixAt(m, this.dummy.matrix);
      this.partMesh.setColorAt(m, q.color);
      m++;
    }
    this.parts = alive;
    this.partMesh.count = m;
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;

    // 炸弹
    for (const b of this.bombs.values()) {
      if (now < b.tLand) {
        const t = Math.max(0, (now - b.tThrow) / Math.max(0.01, b.tLand - b.tThrow));
        b.mesh.position.set(b.x0 + (b.tx - b.x0) * t, 0.6 + 4 * t * (1 - t) * 1.8, b.z0 + (b.tz - b.z0) * t);
        b.mesh.rotation.z += dt * 10;
      } else {
        if (!b.landed) {
          b.landed = true;
          this.splash(b.tx, 0.2, b.tz, b.team, 6, 1.5);
          this.onBombLand?.(b.team);
        }
        const k = Math.max(0, Math.min(1, (now - b.tLand) / Math.max(0.01, b.tBoom - b.tLand)));
        b.mesh.position.set(b.tx, 0.28, b.tz);
        const pulse = 1 + k * 0.35 + Math.sin(now * (20 + k * 30)) * 0.08 * k;
        b.mesh.scale.setScalar(pulse);
        const mat = b.mesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.3 + (Math.sin(now * (14 + k * 30)) > 0 ? 0.8 : 0);
        (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.5 * k;
      }
      // 超时保护：没收到爆炸事件时自动清理
      if (now > b.tBoom + 1.5) {
        this.scene.remove(b.mesh, b.ring);
        this.bombs.delete(b.id);
      }
    }

    // 冲击波
    const rs: RingFx[] = [];
    for (const r of this.rings) {
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        continue;
      }
      const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k));
      r.mesh.scale.set(rad, rad, rad);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      rs.push(r);
    }
    this.rings = rs;
  }

  clear(): void {
    this.projs = [];
    this.parts = [];
    for (const b of this.bombs.values()) this.scene.remove(b.mesh, b.ring);
    this.bombs.clear();
  }
}
