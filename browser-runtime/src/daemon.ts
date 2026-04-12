import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { DEFAULT_DAEMON_PORT } from './constants.js';
import { EXIT_CODES } from './errors.js';

const PORT = Number.parseInt(
  process.env.FOLO_BROWSER_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT),
  10,
);
const BIND_HOST = process.env.FOLO_BROWSER_DAEMON_BIND_HOST || '127.0.0.1';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

let extensionWs: WebSocket | null = null;
let extensionVersion: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const pending = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error('[needle-browser-daemon] Idle timeout, shutting down');
    process.exit(EXIT_CODES.SUCCESS);
  }, IDLE_TIMEOUT_MS);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!aborted) reject(error);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = req.headers.origin as string | undefined;
  if (origin && !origin.startsWith('chrome-extension://')) {
    jsonResponse(res, 403, {
      ok: false,
      error: 'Forbidden: cross-origin request blocked',
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  if (req.method === 'GET' && pathname === '/ping') {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (!req.headers['x-folo-browser']) {
    jsonResponse(res, 403, {
      ok: false,
      error: 'Forbidden: missing browser client header',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    jsonResponse(res, 200, {
      ok: true,
      extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
      extensionVersion,
      pending: pending.size,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/command') {
    resetIdleTimer();
    try {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        timeout?: number;
      };
      if (!body.id) {
        jsonResponse(res, 400, { ok: false, error: 'Missing command id' });
        return;
      }

      if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
        jsonResponse(res, 503, {
          id: body.id,
          ok: false,
          error:
            'Extension not connected. Please install the Needle Browser Bridge extension.',
        });
        return;
      }

      const timeoutMs =
        typeof body.timeout === 'number' && body.timeout > 0
          ? body.timeout * 1000
          : 120000;

      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(body.id!);
          reject(new Error(`Command timeout (${timeoutMs / 1000}s)`));
        }, timeoutMs);
        pending.set(body.id!, { resolve, reject, timer });
        extensionWs!.send(JSON.stringify(body));
      });

      jsonResponse(res, 200, result);
    } catch (error) {
      jsonResponse(
        res,
        error instanceof Error && error.message.includes('timeout') ? 408 : 400,
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid request',
        },
      );
    }
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    res.writeHead(500);
    res.end();
  });
});

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ext',
  verifyClient: ({ req }: { req: IncomingMessage }) => {
    const origin = req.headers.origin as string | undefined;
    return !origin || origin.startsWith('chrome-extension://');
  },
});

wss.on('connection', (ws: WebSocket) => {
  console.error('[needle-browser-daemon] Extension connected');
  extensionWs = ws;
  extensionVersion = null;

  let missedPongs = 0;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    if (missedPongs >= 2) {
      console.error(
        '[needle-browser-daemon] Extension heartbeat lost, closing connection',
      );
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    missedPongs += 1;
    ws.ping();
  }, 15000);

  ws.on('pong', () => {
    missedPongs = 0;
  });

  ws.on('message', (raw: RawData) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        version?: string;
        id?: string;
      };
      if (message.type === 'hello') {
        extensionVersion =
          typeof message.version === 'string' ? message.version : null;
        return;
      }

      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message);
    } catch {
      // Ignore malformed messages.
    }
  });

  const rejectPending = () => {
    if (extensionWs === ws) {
      extensionWs = null;
      extensionVersion = null;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Extension disconnected'));
      }
      pending.clear();
    }
  };

  ws.on('close', () => {
    console.error('[needle-browser-daemon] Extension disconnected');
    clearInterval(heartbeat);
    rejectPending();
  });

  ws.on('error', () => {
    clearInterval(heartbeat);
    rejectPending();
  });
});

httpServer.listen(PORT, BIND_HOST, () => {
  console.error(
    `[needle-browser-daemon] Listening on http://${BIND_HOST}:${PORT}`,
  );
  resetIdleTimer();
});

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[needle-browser-daemon] Port ${PORT} already in use. Exiting.`,
    );
    process.exit(EXIT_CODES.SERVICE_UNAVAIL);
  }
  console.error('[needle-browser-daemon] Server error:', error.message);
  process.exit(EXIT_CODES.GENERIC_ERROR);
});

function shutdown(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Daemon shutting down'));
  }
  pending.clear();
  if (extensionWs) extensionWs.close();
  httpServer.close();
  process.exit(EXIT_CODES.SUCCESS);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
