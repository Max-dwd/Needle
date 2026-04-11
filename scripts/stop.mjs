import { execFileSync } from 'node:child_process';

const DEFAULT_PORT = 3000;
const rawPort = process.env.PORT ?? `${DEFAULT_PORT}`;
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port <= 0) {
  console.error(`[stop] Invalid PORT: ${rawPort}`);
  process.exit(1);
}

function listPidsListeningOnPort(targetPort) {
  try {
    const output = execFileSync(
      'lsof',
      ['-tiTCP:' + targetPort, '-sTCP:LISTEN'],
      { encoding: 'utf8' },
    ).trim();

    if (!output) {
      return [];
    }

    return [...new Set(output.split('\n').map((value) => value.trim()).filter(Boolean))];
  } catch (error) {
    if (typeof error?.status === 'number' && error.status === 1) {
      return [];
    }

    throw error;
  }
}

const pids = listPidsListeningOnPort(port);

if (pids.length === 0) {
  console.log(`[stop] No listening process found on port ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  process.kill(Number(pid), 'SIGTERM');
  console.log(`[stop] Sent SIGTERM to PID ${pid} on port ${port}.`);
}
