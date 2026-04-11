type ManualRefreshRun = {
  id: string;
  cancelRequested: boolean;
  startedAt: string;
};

const manualRefreshKey = Symbol.for('folo-manual-refresh-run');

function getStore(): { [manualRefreshKey]?: ManualRefreshRun | null } {
  return globalThis as typeof globalThis & {
    [manualRefreshKey]?: ManualRefreshRun | null;
  };
}

export function startManualRefreshRun(): ManualRefreshRun {
  const run: ManualRefreshRun = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
  };
  getStore()[manualRefreshKey] = run;
  return run;
}

export function getActiveManualRefreshRun(): ManualRefreshRun | null {
  return getStore()[manualRefreshKey] ?? null;
}

export function requestManualRefreshCancel(): ManualRefreshRun | null {
  const run = getActiveManualRefreshRun();
  if (!run) return null;
  run.cancelRequested = true;
  return run;
}

export function isManualRefreshCancelled(runId: string): boolean {
  const run = getActiveManualRefreshRun();
  return Boolean(run && run.id === runId && run.cancelRequested);
}

export function finishManualRefreshRun(runId: string) {
  const store = getStore();
  const current = store[manualRefreshKey];
  if (current?.id === runId) {
    store[manualRefreshKey] = null;
  }
}
