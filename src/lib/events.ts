import { EventEmitter } from 'events';
import type { LogEntry, SchedulerTaskName } from '@/types';

// Use globalThis to survive Next.js HMR in dev
const globalKey = Symbol.for('folo-event-emitter');

function getEmitter(): EventEmitter {
  const g = globalThis as unknown as Record<symbol, EventEmitter>;
  if (!g[globalKey]) {
    g[globalKey] = new EventEmitter();
    g[globalKey].setMaxListeners(50);
  }
  return g[globalKey];
}

export const appEvents = getEmitter();

// Summary event types
export interface SummaryStartEvent {
  videoId: string;
  platform: string;
  taskId?: number;
}

export interface SummaryProgressEvent {
  videoId: string;
  stage: 'preparing_prompt' | 'calling_api' | 'streaming' | 'writing_file';
  message: string;
  receivedChars?: number;
  modelId?: string;
  modelName?: string;
  channelId?: string | null;
}

export interface SummaryCompleteEvent {
  videoId: string;
  platform: string;
  preview: string;
}

export interface SummaryErrorEvent {
  videoId: string;
  error: string;
  taskId?: number;
}

export interface SchedulerLifecycleEvent {
  enabled: boolean;
  at: string;
}

export interface SchedulerTickEvent {
  task: SchedulerTaskName;
  phase: 'start' | 'complete' | 'skip' | 'error';
  at: string;
  message?: string;
}

export interface CrawlerStatusChangedEvent {
  feed: import('@/types').CrawlerScopeStatus;
  paused: boolean;
  pauseUpdatedAt?: string;
  scheduler?: import('@/types').SchedulerStatus;
}

export interface LogEntryEvent extends LogEntry {}
