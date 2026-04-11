import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getBrowserKeepaliveStatusMock,
  getBrowserKeepalivePresetMock,
  setBrowserKeepalivePresetMock,
} = vi.hoisted(() => ({
  getBrowserKeepaliveStatusMock: vi.fn(),
  getBrowserKeepalivePresetMock: vi.fn(),
  setBrowserKeepalivePresetMock: vi.fn(),
}));

vi.mock('@/lib/browser-keepalive', () => ({
  getBrowserKeepaliveStatus: getBrowserKeepaliveStatusMock,
  getBrowserKeepalivePreset: getBrowserKeepalivePresetMock,
  setBrowserKeepalivePreset: setBrowserKeepalivePresetMock,
}));

import { GET, POST } from './route';

describe('GET /api/settings/browser-keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the persisted preset with derived display data', async () => {
    getBrowserKeepaliveStatusMock.mockReturnValue({
      preset: 'balanced',
      activeGraceLabel: '2 min',
      daemonKeepalive: true,
      browserPrewarm: false,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      preset: 'balanced',
      activeGraceLabel: '2 min',
      daemonKeepalive: true,
      browserPrewarm: false,
    });
  });
});

describe('POST /api/settings/browser-keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrowserKeepalivePresetMock.mockReturnValue('balanced');
    getBrowserKeepaliveStatusMock.mockReturnValue({
      preset: 'aggressive',
      activeGraceLabel: '5 min',
      daemonKeepalive: true,
      browserPrewarm: true,
    });
  });

  it('updates the preset without touching other settings', async () => {
    const request = new Request('http://localhost/api/settings/browser-keepalive', {
      method: 'POST',
      body: JSON.stringify({ preset: 'aggressive' }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    expect(setBrowserKeepalivePresetMock).toHaveBeenCalledWith('aggressive');
    await expect(response.json()).resolves.toEqual({
      preset: 'aggressive',
      activeGraceLabel: '5 min',
      daemonKeepalive: true,
      browserPrewarm: true,
    });
  });

  it('rejects invalid presets', async () => {
    const request = new Request('http://localhost/api/settings/browser-keepalive', {
      method: 'POST',
      body: JSON.stringify({ preset: 'turbo' }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid preset' });
    expect(setBrowserKeepalivePresetMock).not.toHaveBeenCalled();
  });
});
