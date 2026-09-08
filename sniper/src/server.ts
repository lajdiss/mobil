import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));

export interface DashboardState {
  wallet: string;
  balanceSol: number;
  dryRun: boolean;
  armed: boolean;
  spentTodaySol: number;
  config: Record<string, unknown>;
  positions: unknown[];
  performance: unknown;
  learning: unknown;
  wallets: unknown;
  metrics: unknown;
  risk: unknown;
  feed: unknown[];
  logs: string[];
  stats: { detected: number; passed: number; bought: number; errors: number; missed: number };
  /** Present only in graduate mode: health of the AMM stream. */
  graduates: unknown;
  /** Launches counting down to a delayed entry. */
  pendingEntries: number;
  /** Present only in consensus mode: how much agreement has been seen. */
  consensus: unknown;
  /** Present only in trending mode: scanner and pump.fun API health. */
  trending: unknown;
  stream: {
    alive: boolean;
    silentMs: number | null;
    resubscribes: number;
    trades: number;
    endpoint: string;
  };
}

export interface ServerHooks {
  getState: () => DashboardState;
  setArmed: (armed: boolean) => void;
  updateConfig: (patch: Record<string, number | boolean>) => void;
  closePosition: (mint: string) => Promise<void>;
  panicSell: () => Promise<void>;
}

export interface ServerOptions {
  port: number;
  host: string;
  token: string;
}

/** Length-safe comparison so a wrong token cannot be guessed byte by byte. */
function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function startServer(options: ServerOptions, hooks: ServerHooks) {
  const { port, host, token } = options;
  const app = express();
  app.use(express.json());

  /**
   * A bigint reaches JSON.stringify as a throw, not a value. That is a dashboard
   * concern, but it used to be a fatal one: the broadcast runs on a timer, so a single
   * unconverted field killed the process — while it was holding open positions with
   * nobody left to sell them. Nothing about rendering state is worth that, so the
   * conversion happens here as well as at the source.
   */
  const encode = (message: unknown) =>
    JSON.stringify(message, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );


  // The page itself carries no data, so it loads freely; everything that reads state
  // or moves money goes through the token.
  app.use(express.static(join(here, 'public')));

  app.use('/api', (req, res, next) => {
    if (!token) return next();
    const provided = req.get('x-dashboard-token') ?? req.query.token;
    if (!tokenMatches(token, provided)) {
      res.status(401).json({ error: 'invalid or missing dashboard token' });
      return;
    }
    next();
  });

  app.get('/api/state', (_req, res) => {
    res.type('application/json').send(encode(hooks.getState()));
  });

  app.post('/api/armed', (req, res) => {
    const armed = Boolean(req.body?.armed);
    hooks.setArmed(armed);
    res.json({ ok: true, armed });
  });

  app.post('/api/config', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'expected an object' });
      return;
    }
    try {
      hooks.updateConfig(body as Record<string, number | boolean>);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/positions/:mint/close', async (req, res) => {
    try {
      await hooks.closePosition(req.params.mint);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/panic', async (_req, res) => {
    hooks.setArmed(false);
    await hooks.panicSell();
    res.json({ ok: true });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, request) => {
    if (token) {
      const provided = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token');
      if (!tokenMatches(token, provided)) {
        socket.close(4001, 'invalid dashboard token');
        return;
      }
    }
    socket.send(encode({ type: 'state', payload: hooks.getState() }));
  });

  const broadcast = (message: unknown) => {
    const data = encode(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  // The dashboard is a mirror of backend state, so a periodic full push keeps every
  // open tab consistent without tracking per-client deltas.
  const interval = setInterval(() => {
    broadcast({ type: 'state', payload: hooks.getState() });
  }, 1000);

  server.on('close', () => clearInterval(interval));
  server.listen(port, host, () => {
    if (token) {
      console.log(`\n  dashboard: http://localhost:${port}/?token=${token}`);
      console.log('  reachable on your network — open the same URL on your phone,');
      console.log('  swapping localhost for this machine\'s LAN IP.\n');
    } else {
      console.log(`\n  dashboard: http://localhost:${port}`);
      console.log('  (localhost only — set DASHBOARD_TOKEN in .env to reach it from your phone)\n');
    }
  });

  return { broadcast };
}
