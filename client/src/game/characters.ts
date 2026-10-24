import * as THREE from 'three';
import { INK_MAX, TEAM_COLORS, TEAM_COLORS_DARK } from '../../../shared/constants';

export interface CharState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  aim: number; // 弧度
  swim: boolean;
  inked: boolean; // 潜游在己方墨水中
  dead: boolean;
  protect: boolean;
  special: boolean;
  firing: boolean;
  offline: boolean;
  ink: number;
  hp: number;
}

/** 原创角色「墨团」：圆滚滚的果冻身体、大眼睛、背着墨水罐、手持喷墨枪。 */
export class CharacterView {
  readonly group = new THREE.Group();
  private humanoid = new THREE.Group();
  private body: THREE.Mesh;
  private squid: THREE.Mesh;
  private tankFill: THREE.Mesh;
  private gun: THREE.Group;
  private shadow: THREE.Mesh;
  private aura: THREE.Mesh;
  private bodyMat: THREE.MeshToonMaterial;
  private squidMat: THREE.MeshStandardMaterial;
  private t = Math.random() * 10;
  private squash = 0;
  private recoil = 0;
  private yaw = 0;
  private swimBlend = 0;
  private visibleAlpha = 1;
  hiddenFromViewer = false;

  constructor(readonly team: number, gradientMap: THREE.Texture, isMe: boolean) {
    const color = new THREE.Color(TEAM_COLORS[team]);
    const dark = new THREE.Color(TEAM_COLORS_DARK[team]);
    this.bodyMat = new THREE.MeshToonMaterial({ color, gradientMap, transparent: true });

    // 身体
    this.body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 28, 20), this.bodyMat);
    this.body.position.y = 0.44;
    this.body.castShadow = true;
    this.humanoid.add(this.body);

    // 头顶的小卷
    const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), this.bodyMat);
    tuft.position.set(-0.05, 0.86, 0);
    tuft.scale.set(1, 1.3, 1);
    this.humanoid.add(tuft);

    // 眼睛（朝向 +x 本地方向）
    const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const black = new THREE.MeshBasicMaterial({ color: '#1b1530' });
    const shine = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 12), white);
      eye.position.set(0.32, 0.56, side * 0.15);
      eye.scale.set(0.6, 1.15, 1);
      this.humanoid.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), black);
      pupil.position.set(0.39, 0.55, side * 0.15);
      pupil.scale.set(0.5, 1.2, 1);
      this.humanoid.add(pupil);
      const hl = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), shine);
      hl.position.set(0.425, 0.6, side * 0.15 + 0.02);
      this.humanoid.add(hl);
    }

    // 背部墨水罐（填充高度 = 剩余墨水）
    const tankGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 0.5, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, roughness: 0.1, side: THREE.DoubleSide }),
    );
    tankGlass.position.set(-0.43, 0.5, 0);
    this.humanoid.add(tankGlass);
    this.tankFill = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.46, 16),
      new THREE.MeshToonMaterial({ color, gradientMap, emissive: color, emissiveIntensity: 0.25 }),
    );
    this.tankFill.position.set(-0.43, 0.5, 0);
    this.humanoid.add(this.tankFill);
    const tankCap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 16), new THREE.MeshStandardMaterial({ color: '#2a2147' }));
    tankCap.position.set(-0.43, 0.77, 0);
    this.humanoid.add(tankCap);

    // 喷墨枪
    this.gun = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({ color: '#2a2147', roughness: 0.4 });
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.13, 0.13), gunMat);
    barrel.position.x = 0.2;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.14, 10), new THREE.MeshToonMaterial({ color, gradientMap }));
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.x = 0.48;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.1), gunMat);
    grip.position.set(0.05, -0.12, 0);
    this.gun.add(barrel, nozzle, grip);
    this.gun.position.set(0.18, 0.4, 0.34);
    this.humanoid.add(this.gun);

    this.group.add(this.humanoid);
    // 视觉放大（碰撞半径不变），在全场视角下更醒目
    this.group.scale.setScalar(1.35);

    // 潜游形态：贴地的水滴
    this.squidMat = new THREE.MeshStandardMaterial({ color, roughness: 0.15, metalness: 0.05, transparent: true, emissive: dark, emissiveIntensity: 0.2 });
    this.squid = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), this.squidMat);
    this.squid.scale.set(1.35, 0.32, 0.85);
    this.squid.position.y = 0.1;
    this.squid.visible = false;
    this.group.add(this.squid);

    // 阴影
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.46, 24),
      new THREE.MeshBasicMaterial({ color: '#1b1530', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.group.add(this.shadow);

    // 大招光环
    this.aura = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.06, 8, 40),
      new THREE.MeshBasicMaterial({ color: '#c6f432', transparent: true, opacity: 0.9 }),
    );
    this.aura.rotation.x = Math.PI / 2;
    this.aura.position.y = 0.08;
    this.aura.visible = false;
    this.group.add(this.aura);

    if (isMe) {
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.64, 32),
        new THREE.MeshBasicMaterial({ color: '#c6f432', transparent: true, opacity: 0.85, depthWrite: false }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.y = 0.02;
      this.group.add(marker);
    }
  }

  onShoot(): void {
    this.recoil = 1;
  }

  update(s: CharState, dt: number): void {
    this.t += dt;
    this.group.position.set(s.x, 0, s.z);
    this.group.visible = !s.dead;
    if (s.dead) return;

    const speed = Math.hypot(s.vx, s.vz);
    // 朝向：人形看准星方向，潜游形态看移动方向
    const targetYaw = s.swim && speed > 0.3 ? Math.atan2(-s.vz, s.vx) : -s.aim;
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 18);
    this.group.rotation.y = this.yaw;

    this.swimBlend += ((s.swim ? 1 : 0) - this.swimBlend) * Math.min(1, dt * 16);
    const sw = this.swimBlend;
    this.humanoid.visible = sw < 0.6;
    this.squid.visible = sw >= 0.4;

    // 人形：走路弹跳 + 挤压拉伸 + 后坐力
    const bob = speed > 0.5 ? Math.abs(Math.sin(this.t * 13)) * 0.06 : Math.sin(this.t * 3) * 0.015;
    this.squash += ((speed > 0.5 ? 0.06 : 0) - this.squash) * Math.min(1, dt * 10);
    this.recoil *= Math.exp(-dt * 18);
    const hs = 1 - sw * 0.7;
    this.humanoid.scale.set(hs * (1 + this.squash), hs * (1 - this.squash + bob), hs * (1 + this.squash));
    this.humanoid.position.y = bob;
    this.gun.position.x = 0.18 - this.recoil * 0.08;

    // 墨水罐
    const ink = Math.max(0.02, s.ink / INK_MAX);
    this.tankFill.scale.y = ink;
    this.tankFill.position.y = 0.27 + 0.23 * ink;

    // 潜游形态：沉入墨水时更低更透明
    const stretch = 1 + Math.min(0.5, speed / 18);
    this.squid.scale.set(1.35 * stretch, s.inked ? 0.18 : 0.32, 0.85 / Math.sqrt(stretch));
    this.squid.position.y = s.inked ? 0.03 : 0.1 + Math.abs(Math.sin(this.t * 10)) * 0.04;

    // 可见度：敌人潜入自己的墨水后对我隐身
    let alpha = 1;
    if (s.inked) alpha = this.hiddenFromViewer ? 0 : 0.55;
    if (s.offline) alpha = Math.min(alpha, 0.4);
    if (s.protect) alpha *= 0.55 + 0.45 * Math.round((Math.sin(this.t * 24) + 1) / 2);
    this.visibleAlpha += (alpha - this.visibleAlpha) * Math.min(1, dt * 12);
    this.bodyMat.opacity = this.visibleAlpha;
    this.squidMat.opacity = this.visibleAlpha;
    this.group.visible = this.visibleAlpha > 0.03;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.22 * this.visibleAlpha * (1 - sw * 0.6);

    // 低血量闪白
    const hurt = s.hp < 45 ? (Math.sin(this.t * 20) > 0 ? 0.35 : 0) : 0;
    this.bodyMat.emissive.setRGB(hurt, hurt, hurt);

    this.aura.visible = s.special;
    if (s.special) {
      this.aura.rotation.z += dt * 4;
      const k = 1 + Math.sin(this.t * 10) * 0.08;
      this.aura.scale.set(k, k, k);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
    });
  }
}
