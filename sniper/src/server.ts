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
  feed: unknown[];
  logs: string[];
  stats: { detected: number; passed: number; bought: number; errors: number; missed: number };
  stream: { alive: boolean; silentMs: number | null; resubscribes: number; trades: number };
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
    res.json(hooks.getState());
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
    socket.send(JSON.stringify({ type: 'state', payload: hooks.getState() }));
  });

  const broadcast = (message: unknown) => {
    const data = JSON.stringify(message);
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
