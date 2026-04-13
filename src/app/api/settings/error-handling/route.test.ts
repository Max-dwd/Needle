import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getVideoErrorHandlingSettings,
  setVideoErrorHandlingSettings,
} = vi.hoisted(() => ({
  getVideoErrorHandlingSettings: vi.fn(),
  setVideoErrorHandlingSettings: vi.fn(),
}));

vi.mock('@/lib/video-error-handling', () => ({
  getVideoErrorHandlingSettings,
  setVideoErrorHandlingSettings,
}));

import { GET, POST } from './route';

describe('GET /api/settings/error-handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVideoErrorHandlingSettings.mockReturnValue({
      hideUnavailableVideos: true,
      unavailableVideoBehavior: 'keep',
      updatedAt: null,
      counts: { unavailable: 2, abandoned: 1 },
    });
  });

  it('returns the persisted error handling settings', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.hideUnavailableVideos).toBe(true);
    expect(data.unavailableVideoBehavior).toBe('keep');
    expect(getVideoErrorHandlingSettings).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/settings/error-handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVideoErrorHandlingSettings.mockReturnValue({
      hideUnavailableVideos: true,
      unavailableVideoBehavior: 'abandon',
      updatedAt: '2026-04-13T00:00:00.000Z',
      counts: { unavailable: 0, abandoned: 3 },
    });
  });

  it('persists valid settings', async () => {
    const request = new Request('http://localhost/api/settings/error-handling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hideUnavailableVideos: true,
        unavailableVideoBehavior: 'abandon',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(setVideoErrorHandlingSettings).toHaveBeenCalledWith({
      hideUnavailableVideos: true,
      unavailableVideoBehavior: 'abandon',
    });
  });

  it('rejects invalid unavailable video behavior', async () => {
    const request = new Request('http://localhost/api/settings/error-handling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unavailableVideoBehavior: 'drop',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(setVideoErrorHandlingSettings).not.toHaveBeenCalled();
  });
});
