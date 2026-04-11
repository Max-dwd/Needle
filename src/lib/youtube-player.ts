export interface YouTubePlayerTelemetry {
  currentTime?: number;
  duration?: number;
  playerReady?: boolean;
  playerState?: number;
}

export function createYouTubeListeningMessage(id = 1): string {
  return JSON.stringify({
    event: 'listening',
    id,
    channel: 'widget',
  });
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractTelemetryFromInfo(
  info: unknown,
): Pick<YouTubePlayerTelemetry, 'currentTime' | 'duration' | 'playerState'> {
  if (!info || typeof info !== 'object') {
    return {};
  }

  const record = info as Record<string, unknown>;
  return {
    currentTime: asFiniteNumber(record.currentTime),
    duration: asFiniteNumber(record.duration),
    playerState: asFiniteNumber(record.playerState),
  };
}

export function resolveYouTubeEmbedOrigin(src?: string | null): string {
  if (!src) return 'https://www.youtube.com';

  try {
    return new URL(src).origin;
  } catch {
    return 'https://www.youtube.com';
  }
}

export function isTrustedYouTubeOrigin(origin: string): boolean {
  if (!origin) return false;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'https:') return false;
    return (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'www.youtube-nocookie.com'
    );
  } catch {
    return false;
  }
}

export function parseYouTubePlayerMessage(
  payload: unknown,
): YouTubePlayerTelemetry | null {
  let parsedPayload = payload;

  if (typeof parsedPayload === 'string') {
    try {
      parsedPayload = JSON.parse(parsedPayload);
    } catch {
      return null;
    }
  }

  if (!parsedPayload || typeof parsedPayload !== 'object') {
    return null;
  }

  const record = parsedPayload as Record<string, unknown>;
  const telemetry: YouTubePlayerTelemetry = {};
  const event = typeof record.event === 'string' ? record.event : null;
  const func = typeof record.func === 'string' ? record.func : null;

  if (
    event === 'onReady' ||
    event === 'infoDelivery' ||
    event === 'initialDelivery' ||
    event === 'onStateChange'
  ) {
    Object.assign(telemetry, extractTelemetryFromInfo(record.info));
    if (event === 'onReady') {
      telemetry.playerReady = true;
    }
  }

  if (func === 'getCurrentTime') {
    telemetry.currentTime = asFiniteNumber(record.result);
  }

  if (func === 'getDuration') {
    telemetry.duration = asFiniteNumber(record.result);
  }

  if (
    telemetry.playerReady ||
    telemetry.currentTime !== undefined ||
    telemetry.duration !== undefined ||
    telemetry.playerState !== undefined
  ) {
    return telemetry;
  }

  return null;
}
