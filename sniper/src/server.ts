import { createServer } from 'node:http';
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
  feed: unknown[];
  logs: string[];
  stats: { detected: number; passed: number; bought: number; errors: number };
}

export interface ServerHooks {
  getState: () => DashboardState;
  setArmed: (armed: boolean) => void;
  updateConfig: (patch: Record<string, number | boolean>) => void;
  closePosition: (mint: string) => Promise<void>;
  panicSell: () => Promise<void>;
}

export function startServer(port: number, hooks: ServerHooks) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(here, 'public')));

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

  wss.on('connection', (socket) => {
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
  server.listen(port, () => {
    console.log(`\n  dashboard: http://localhost:${port}\n`);
  });

  return { broadcast };
}
