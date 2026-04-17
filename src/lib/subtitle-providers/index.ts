import type { AiModelProtocol, AiSummaryModelConfig } from '@/types';
import { geminiTranscriber } from './gemini';
import { openAiChatTranscriber } from './openai-chat';
import { anthropicMessagesTranscriber } from './anthropic-messages';
import type { MultimodalTranscriber } from './types';

export type {
  MultimodalTranscriber,
  TranscribeAudioInput,
  TranscribeRemoteVideoInput,
  TranscribeResult,
  TranscribeUsage,
  TranscribePriority,
} from './types';

const registry: Record<AiModelProtocol, MultimodalTranscriber> = {
  gemini: geminiTranscriber,
  'openai-chat': openAiChatTranscriber,
  'anthropic-messages': anthropicMessagesTranscriber,
};

export function getTranscriber(
  model: AiSummaryModelConfig,
): MultimodalTranscriber {
  return registry[model.protocol] || geminiTranscriber;
}
