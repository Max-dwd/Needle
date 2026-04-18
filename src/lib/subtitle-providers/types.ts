import type { AiModelProtocol, AiSummaryModelConfig } from '@/types';

export type TranscribePriority = 'manual-subtitle' | 'auto-subtitle';
export type JsonSchema = Record<string, unknown>;

export interface TranscribeAudioInput {
  audioPath: string;
  mediaType: 'audio/mpeg';
  prompt: string;
  systemPrompt?: string;
  responseSchema?: JsonSchema;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  priority: TranscribePriority;
  label: string;
  estimatedTokens: number;
}

export interface TranscribeRemoteVideoInput {
  url: string;
  mediaType: string;
  prompt: string;
  priority: TranscribePriority;
  label: string;
  estimatedTokens: number;
}

export interface TranscribeUsage {
  totalTokens?: number;
}

export interface TranscribeResult {
  text: string;
  usage?: TranscribeUsage;
  ttftSeconds?: number;
}

export interface MultimodalTranscriber {
  readonly protocol: AiModelProtocol;
  readonly maxAudioChunkSeconds: number;

  transcribeAudio(
    model: AiSummaryModelConfig,
    input: TranscribeAudioInput,
  ): Promise<TranscribeResult>;

  transcribeRemoteVideo?(
    model: AiSummaryModelConfig,
    input: TranscribeRemoteVideoInput,
  ): Promise<TranscribeResult>;
}
