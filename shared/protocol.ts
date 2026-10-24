import { z } from 'zod';
import { AIM_STEPS, NAME_MAX, ROOM_CODE_LEN, ROUND_SEC_OPTIONS } from './constants';
import type { InputFrame } from './sim';

// ===================== 客户端 → 服务器 =====================

const roomCode = z.string().length(ROOM_CODE_LEN).regex(/^[0-9A-Z]+$/);

export const helloSchema = z.strictObject({
  t: z.literal('hello'),
  v: z.number().int(),
  act: z.enum(['create', 'join', 'resume']),
  room: roomCode.optional(),
  name: z.string().min(1).max(40),
  tok: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

export const controlSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('ready'), r: z.boolean() }),
  z.strictObject({ t: z.literal('team'), team: z.union([z.literal(0), z.literal(1)]) }),
  z.strictObject({ t: z.literal('start') }),
  z.strictObject({ t: z.literal('set'), roundSec: z.number().int().refine((v) => ROUND_SEC_OPTIONS.includes(v)) }),
  z.strictObject({ t: z.literal('again') }),
  z.strictObject({ t: z.literal('ping'), t0: z.number().finite() }),
  z.strictObject({ t: z.literal('leave') }),
]);

export type HelloMsg = z.infer<typeof helloSchema>;
export type ControlMsg = z.infer<typeof controlSchema>;

/** 高频输入消息手写校验（避免对象分配）。合法返回输入帧数组，否则返回 null。 */
export function parseInputs(msg: unknown): InputFrame[] | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.t !== 'in' || !Array.isArray(m.s) || m.s.length === 0 || m.s.length > 6) return null;
  if (Object.keys(m).length !== 2) return null;
  const out: InputFrame[] = [];
  for (const f of m.s as unknown[]) {
    if (!Array.isArray(f) || f.length !== 6) return null;
    for (const v of f) if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    const [seq, mx, mz, aim, dist, btn] = f as number[];
    if (seq < 1 || seq > 2 ** 31) return null;
    if (mx < -100 || mx > 100 || mz < -100 || mz > 100) return null;
    if (aim < 0 || aim >= AIM_STEPS) return null;
    if (dist < 0 || dist > 100) return null;
    if (btn < 0 || btn > 15) return null;
    out.push({ seq, mx, mz, aim, dist, btn });
  }
  return out;
}

/** 昵称清洗：去掉控制字符与首尾空白，限制长度。 */
export function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('') || '无名小墨';
}

// ===================== 服务器 → 客户端 =====================

export type Phase = 'lobby' | 'countdown' | 'playing' | 'results';
export type Role = 'player' | 'spectator';

export interface LobbyPlayer {
  id: number;
  name: string;
  team: number; // 观战者为 -1
  slot: number;
  ready: boolean;
  online: boolean;
  role: Role;
  again: boolean;
}

export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  room: string;
  me: number;
  tok: string;
  phase: Phase;
  grid: string; // Base64 完整地面
  tick: number;
  st: number;
  lan: string[];
}

export interface LobbyMsg {
  t: 'lobby';
  room: string;
  phase: Phase;
  host: number;
  roundSec: number;
  players: LobbyPlayer[];
  wins: [number, number];
  matchNo: number;
}

export interface CountdownMsg { t: 'cd'; startAt: number; endAt: number; roundSec: number; matchNo: number; grid: string }

/** 快照中每名玩家：[id, x, z, vx, vz, flags, hp, ink, gauge%, aim, fireCd, sinceShot, respawnTicks] */
export type SnapPlayer = [number, number, number, number, number, number, number, number, number, number, number, number, number];

export type GameEvent =
  | { e: 'shot'; id: number; o: number; x: number; z: number; a: number; sp: number; k: number; seq: number }
  | { e: 'hit'; id: number; v: number; o: number }
  | { e: 'bomb'; id: number; o: number; x: number; z: number; tx: number; tz: number; k: number; land: number; boom: number; seq: number }
  | { e: 'boom'; id: number; o: number; x: number; z: number }
  | { e: 'splat'; v: number; by: number; x: number; z: number }
  | { e: 'special'; o: number; x: number; z: number }
  | { e: 'respawn'; v: number; x: number; z: number };

export interface SnapshotMsg {
  t: 's';
  k: number; // tick
  st: number; // 服务器时间（毫秒）
  ph: Phase;
  left: number; // 剩余毫秒（对局中）
  ack: Record<string, number>;
  p: SnapPlayer[];
  d: number[];
  ev: GameEvent[];
}

export interface PlayerStat { id: number; name: string; team: number; paint: number; splats: number; deaths: number }

export interface ResultMsg {
  t: 'result';
  cells: [number, number];
  pct: [number, number];
  winner: number; // -1 平局
  reason: 'time' | 'forfeit';
  stats: PlayerStat[];
  wins: [number, number];
  until: number;
  matchNo: number;
}

export interface PongMsg { t: 'pong'; t0: number; ts: number }
export interface ErrMsg { t: 'err'; code: string; msg: string }

export type ServerMsg = WelcomeMsg | LobbyMsg | CountdownMsg | SnapshotMsg | ResultMsg | PongMsg | ErrMsg;

export interface RoomListing {
  code: string;
  host: string;
  players: number;
  spectators: number;
  phase: Phase;
}
