import { NextRequest, NextResponse } from 'next/server';
import {
  getPlayerKeyboardModeSettings,
  mergePlayerKeyboardModeSettings,
  setPlayerKeyboardModeSettings,
  validatePlayerKeyboardModeSettings,
  type PlayerKeyboardModeSettingsInput,
} from '@/lib/player-keyboard-mode';

function createResponse() {
  return getPlayerKeyboardModeSettings();
}

export async function GET() {
  return NextResponse.json(createResponse());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Invalid settings body' },
      { status: 400 },
    );
  }

  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'Invalid enabled flag' },
      { status: 400 },
    );
  }

  if ('bindings' in body && !Array.isArray(body.bindings)) {
    return NextResponse.json({ error: 'Invalid bindings' }, { status: 400 });
  }

  const numericFields = [
    'rateTogglePreset',
    'rateStep',
    'seekSeconds',
    'rateMin',
    'rateMax',
  ] as const;
  for (const field of numericFields) {
    if (field in body && typeof body[field] !== 'number') {
      return NextResponse.json(
        { error: `${field} must be a number` },
        { status: 400 },
      );
    }
  }

  const nextSettings = mergePlayerKeyboardModeSettings(
    getPlayerKeyboardModeSettings(),
    body as PlayerKeyboardModeSettingsInput,
  );
  const validationError = validatePlayerKeyboardModeSettings(nextSettings);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  setPlayerKeyboardModeSettings(nextSettings);
  return NextResponse.json(createResponse());
}
