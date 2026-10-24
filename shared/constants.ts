// 所有玩法与网络参数的唯一来源。客户端与服务器共用。
// 时间单位：除特别注明外，*_TICKS 为模拟步数（60 步 = 1 秒），*_MS 为毫秒，*_S 为秒。

export const PROTOCOL_VERSION = 1;
export const GAME_TITLE = '泼色竞技场';

// ---------- 模拟与网络频率 ----------
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAPSHOT_EVERY = 2; // 30Hz 快照
export const MAX_CATCHUP_STEPS = 5;
export const INPUT_QUEUE_MAX = 6;
export const INPUT_QUEUE_KEEP = 2;
export const INPUT_SEND_INTERVAL_MS = 33;
export const PING_INTERVAL_MS = 1000;
export const HEARTBEAT_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 15000;
export const HELLO_TIMEOUT_MS = 3000;

// ---------- 场地 ----------
export const ARENA_W = 40; // x 方向
export const ARENA_H = 24; // z 方向
export const CELL = 0.25;
export const GRID_W = Math.round(ARENA_W / CELL); // 160
export const GRID_H = Math.round(ARENA_H / CELL); // 96
export const PAINT_NONE = 0;
export const PAINT_BLOCKED = 255;
// 地面格子值：0 = 无，1 = 队伍 0（橙），2 = 队伍 1（青），255 = 障碍
export const teamPaint = (team: number) => team + 1;

export const TEAM_COUNT = 2;
export const TEAM_NAMES = ['橙队', '青队'];
export const TEAM_COLORS = ['#FF7A1A', '#18C9B5'];
export const TEAM_COLORS_DARK = ['#C2470A', '#0B8C80'];

// ---------- 房间与人数 ----------
export const MAX_PLAYERS = 4;
export const TEAM_MAX = 2;
export const MAX_SPECTATORS = 4;
export const ROUND_SEC_OPTIONS = [180, 120];
export const DEFAULT_ROUND_SEC = 180;
export const LAST_MINUTE_SEC = 60;
export const COUNTDOWN_MS = 3000;
export const RESULTS_MS = 15000;
export const GRACE_MS = 60000;
export const FORFEIT_MS = 10000;
export const EMPTY_ROOM_MS = 60000;
export const NAME_MAX = 12;
export const ROOM_CODE_LEN = 5;
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// ---------- 角色 ----------
export const PLAYER_RADIUS = 0.42;
export const HP_MAX = 100;
export const HP_REGEN_DELAY_TICKS = 60; // 1 秒未受伤后回血
export const HP_REGEN_PER_S = 55;
export const HP_REGEN_SWIM_PER_S = 110;
export const ENEMY_INK_DPS = 14;
export const ENEMY_INK_MIN_HP = 30; // 敌方墨水不会把人直接击倒

export const WALK_SPEED = 5.2;
export const WALK_FIRE_SPEED = 3.8;
export const SWIM_SPEED = 9.6;
export const SQUID_DRY_SPEED = 2.8; // 潜游形态但脚下不是己方墨水
export const ENEMY_INK_SPEED = 2.2;
export const ACCEL = 42;
export const SWIM_ACCEL = 70;

// ---------- 墨水 ----------
export const INK_MAX = 100;
export const INK_REGEN_PER_S = 9; // 人形态，停火 0.5 秒后
export const INK_REGEN_DELAY_TICKS = 30;
export const INK_REGEN_SWIM_PER_S = 40; // 潜游在己方墨水中
export const HANDICAP_INK_MULT = 1.4; // 人少一方

// ---------- 主武器（喷墨枪） ----------
export const SHOT_INTERVAL_TICKS = 7; // ≈ 8.6 发/秒
export const SHOT_INTERVAL_SPECIAL_TICKS = 4;
export const SHOT_COST = 1.1;
export const SHOT_SPEED = 26;
export const SHOT_RANGE = 7.2;
export const SHOT_SPREAD_RAD = (6 * Math.PI) / 180;
export const SHOT_DAMAGE = 34;
export const SHOT_SPLAT_R = 0.85;
export const SHOT_SPECIAL_SPLAT_MULT = 1.45;
export const SHOT_TRAIL_R = 0.34;
export const SHOT_TRAIL_EVERY = 1.35;
export const SHOT_HIT_R = PLAYER_RADIUS + 0.14;
export const MUZZLE_OFFSET = 0.45;

// ---------- 副武器（墨水炸弹） ----------
export const BOMB_COST = 70;
export const BOMB_RANGE = 7.5;
export const BOMB_MIN_RANGE = 1.2;
export const BOMB_FLIGHT_TICKS = 30; // 0.5 秒
export const BOMB_FUSE_TICKS = 45; // 落地后 0.75 秒爆炸
export const BOMB_PAINT_R = 2.6;
export const BOMB_LETHAL_R = 1.3;
export const BOMB_LETHAL_DMG = 180;
export const BOMB_EDGE_DMG = 35;
export const BOMB_DMG_R = 2.6;

// ---------- 大招（墨潮） ----------
export const SPECIAL_COST = 2600; // 需要新涂的格子数
export const SPECIAL_DURATION_TICKS = 6 * TICK_HZ;
export const SPECIAL_BURST_PAINT_R = 3.3;
export const SPECIAL_BURST_DMG_R = 2.1;
export const SPECIAL_BURST_DMG = 45;
export const SPECIAL_DEATH_KEEP = 0.5; // 被击倒保留一半能量

// ---------- 击倒与复活 ----------
export const RESPAWN_TICKS = 3 * TICK_HZ;
export const HANDICAP_RESPAWN_TICKS = Math.round(2.2 * TICK_HZ);
export const SPAWN_PROTECT_TICKS = Math.round(1.5 * TICK_HZ);
export const DEATH_SPLAT_R = 1.7;
export const SPAWN_BARRIER_R = 2.6;
export const SPAWN_PREPAINT_R = 2.2;

// ---------- 安全与限流 ----------
export const MAX_PAYLOAD_BYTES = 4096;
export const RATE_MSGS_PER_S = 90;
export const RATE_BURST = 140;
export const MAX_VIOLATIONS = 5;
export const MAX_CONN_PER_IP = 10;

// ---------- 关闭码 ----------
export const CLOSE = {
  NORMAL: 4000,
  REPLACED: 4001,
  VERSION: 4002,
  FULL: 4003,
  NO_ROOM: 4004,
  RATE: 4005,
  INVALID: 4006,
  HELLO_TIMEOUT: 4007,
  SHUTDOWN: 4010,
} as const;

// ---------- 输入按键位 ----------
export const BTN_FIRE = 1;
export const BTN_SWIM = 2;
export const BTN_BOMB = 4; // 边沿触发
export const BTN_SPECIAL = 8; // 边沿触发

// ---------- 快照中的玩家状态位 ----------
export const F_SWIM = 1;
export const F_DEAD = 2;
export const F_PROTECT = 4;
export const F_SPECIAL = 8;
export const F_FIRING = 16;
export const F_OFFLINE = 32;
export const F_INKED = 64; // 潜游在己方墨水中（对敌方隐身）
export const F_HANDICAP = 128;

export const AIM_STEPS = 4096; // 瞄准角量化
