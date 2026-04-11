export interface SubtitleBackoffFlowStep {
  label: string;
  color: string;
  isCurrent: boolean;
}

function formatBackoffIntervalLabel(seconds: number): string {
  if (seconds <= 0) return '即时';

  const totalSeconds = Math.max(1, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);
  if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);

  return parts.join(' ');
}

function getBackoffStageIndex(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 1) return 0;
  return Math.max(0, Math.round(Math.log2(multiplier)));
}

/**
 * Builds the visible subtitle backoff flow for the settings panel.
 *
 * The UI only needs to show the first few exponential stages:
 * 10min -> 20min -> 40min.
 */
export function buildSubtitleBackoffFlow(
  baseIntervalSeconds: number,
  multiplier: number,
  stageCount: number,
): SubtitleBackoffFlowStep[] {
  const safeBaseIntervalSeconds = Math.max(0, Math.floor(baseIntervalSeconds));
  const safeStageCount = Math.max(1, Math.floor(stageCount));
  const currentStage = Math.min(
    safeStageCount - 1,
    getBackoffStageIndex(multiplier),
  );
  const isClear = !Number.isFinite(multiplier) || multiplier <= 1;

  return Array.from({ length: safeStageCount }, (_, index) => {
    const label = formatBackoffIntervalLabel(safeBaseIntervalSeconds * 2 ** index);

    let color = '#94a3b8';
    if (isClear && index === 0) {
      color = '#16a34a';
    } else if (index === currentStage) {
      color = '#f59e0b';
    }

    return {
      label,
      color,
      isCurrent: index === currentStage,
    };
  });
}
