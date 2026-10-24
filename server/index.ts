import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  CLOSE, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, HELLO_TIMEOUT_MS, MAX_CONN_PER_IP, MAX_PAYLOAD_BYTES,
  MAX_VIOLATIONS, PROTOCOL_VERSION, RATE_BURST, RATE_MSGS_PER_S, ROOM_CODE_ALPHABET, ROOM_CODE_LEN,
} from '../shared/constants';
import { controlSchema, helloSchema, parseInputs, sanitizeName } from '../shared/protocol';
import { type Member, Room, type RoomOptions, serverNow } from './room';
import { log, setQuiet } from './log';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ServerOptions {
  port: number;
  host?: string;
  dev?: boolean;
  quiet?: boolean;
  room?: Partial<Omit<RoomOptions, 'lanUrls'>>;
}

export interface RunningServer {
  port: number;
  rooms: Map<string, Room>;
  close: () => Promise<void>;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  setQuiet(!!opts.quiet);
  const rooms = new Map<string, Room>();
  const connPerIp = new Map<string, number>();
  let actualPort = opts.port;
  const lanUrls = () => lanAddresses().map((ip) => `http://${ip}:${actualPort}`);

  const roomOpts: RoomOptions = { ...opts.room, lanUrls };

  function newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) c += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
  }

  // ---------------- HTTP ----------------
  let vite: any = null;
  const distDir = path.join(ROOT, 'dist', 'client');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname === '/api/rooms') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify([...rooms.values()].filter((r) => !r.destroyed).map((r) => r.listing())));
      return;
    }
    if (url.pathname === '/api/info') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ v: PROTOCOL_VERSION, lan: lanUrls() }));
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
      return;
    }
    // 生产模式：静态文件
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(distDir, rel));
    if (!file.startsWith(distDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rel === '/index.html' ? '尚未构建客户端，请先运行 npm run build' : 'not found');
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(data);
    });
  });

  if (opts.dev) {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
  }

  // ---------------- WebSocket ----------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return; // 交给 Vite HMR 等其他监听者
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch { /* invalid */ }
      if (!ok) {
        log('reject-origin', { origin });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const ip = req.socket.remoteAddress ?? '?';
    const n = connPerIp.get(ip) ?? 0;
    if (n >= MAX_CONN_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connPerIp.set(ip, (connPerIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const c = (connPerIp.get(ip) ?? 1) - 1;
        if (c <= 0) connPerIp.delete(ip);
        else connPerIp.set(ip, c);
      });
      onConnection(ws, ip);
    });
  });

  function onConnection(ws: WebSocket, ip: string) {
    let room: Room | null = null;
    let member: Member | null = null;
    let tokens = RATE_BURST;
    let lastRefill = serverNow();
    let violations = 0;
    let lastPong = serverNow();

    const helloTimer = setTimeout(() => {
      if (!member) ws.close(CLOSE.HELLO_TIMEOUT, 'hello-timeout');
    }, HELLO_TIMEOUT_MS);

    const hb = setInterval(() => {
      if (serverNow() - lastPong > HEARTBEAT_TIMEOUT_MS) {
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch { /* ignore */ }
    }, HEARTBEAT_MS);
    ws.on('pong', () => {
      lastPong = serverNow();
    });

    const violate = (why: string) => {
      violations++;
      log('violation', { ip, why, n: violations, room: room?.code, id: member?.id });
      if (violations >= MAX_VIOLATIONS) ws.close(CLOSE.INVALID, 'too-many-invalid');
    };

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      // 令牌桶限流
      const now = serverNow();
      tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_MSGS_PER_S);
      lastRefill = now;
      if (tokens < 1) {
        violate('rate');
        if (violations >= 3) ws.close(CLOSE.RATE, 'rate');
        return;
      }
      tokens -= 1;
      lastPong = now;
      if (isBinary) return violate('binary');
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return violate('json');
      }
      if (!member) {
        const h = helloSchema.safeParse(msg);
        if (!h.success) {
          violate('hello');
          ws.close(CLOSE.INVALID, 'bad-hello');
          return;
        }
        clearTimeout(helloTimer);
        if (h.data.v !== PROTOCOL_VERSION) {
          ws.close(CLOSE.VERSION, 'version');
          return;
        }
        const name = sanitizeName(h.data.name);
        if (h.data.act === 'create') {
          room = new Room(newCode(), roomOpts, (r) => rooms.delete(r.code));
          rooms.set(room.code, room);
          log('room-created', { room: room.code, ip });
          member = room.join(ws, name);
        } else {
          const r = h.data.room ? rooms.get(h.data.room) : undefined;
          if (!r || r.destroyed) {
            ws.close(CLOSE.NO_ROOM, 'no-room');
            return;
          }
          room = r;
          if (h.data.act === 'resume' && h.data.tok) {
            member = r.resume(ws, h.data.tok);
            if (!member) {
              ws.close(CLOSE.NO_ROOM, 'seat-expired');
              return;
            }
          } else {
            member = r.join(ws, name);
            if (!member) {
              ws.close(CLOSE.FULL, 'full');
              return;
            }
          }
        }
        return;
      }
      if (msg && msg.t === 'in') {
        const frames = parseInputs(msg);
        if (!frames) return violate('input');
        room!.handleInputs(member, frames);
        return;
      }
      const c = controlSchema.safeParse(msg);
      if (!c.success) return violate('control');
      room!.handleControl(member, c.data);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(hb);
      if (room && member) room.disconnected(member, ws);
    });
    ws.on('error', () => { /* close 事件会随后触发 */ });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') actualPort = addr.port;

  return {
    port: actualPort,
    rooms,
    close: async () => {
      for (const r of [...rooms.values()]) r.destroy();
      for (const c of wss.clients) c.terminate();
      wss.close();
      if (vite) await vite.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------- 命令行入口 ----------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dev = process.argv.includes('--dev');
  const port = Number(process.env.PORT ?? 8080);
  // 仅用于测试：SA_ROUND_SEC 可缩短对局时长
  const roundOverride = process.env.SA_ROUND_SEC ? Number(process.env.SA_ROUND_SEC) : undefined;
  startServer({ port, dev, room: roundOverride ? { roundSecOverride: roundOverride } : {} }).then((s) => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${s.port}`);
    console.log('');
    console.log(`  泼色竞技场服务器已启动（${dev ? '开发模式' : '正式模式'}）`);
    console.log(`  本机访问：   http://localhost:${s.port}`);
    for (const u of urls) console.log(`  局域网访问： ${u}`);
    console.log('');
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  端口 ${port} 已被占用：可能已经有一个游戏服务器在运行。`);
      console.error(`  请先关闭它，或换一个端口启动，例如：PORT=${port + 1} node server/index.mjs\n`);
    } else {
      console.error('\n  服务器启动失败：', err.message, '\n');
    }
    process.exit(1);
  });
  const shutdown = () => {
    console.log('正在关闭服务器…');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
