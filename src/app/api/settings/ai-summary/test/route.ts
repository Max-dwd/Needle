import { NextResponse } from 'next/server';
import { getAiSummarySettings } from '@/lib/ai-summary-settings';
import {
  createAiApiHeaders,
  createAiApiRequest,
  resolveAiApiUrl,
} from '@/lib/ai-summary-client';

export async function POST() {
  const settings = getAiSummarySettings();

  if (!settings.apiKey) {
    return NextResponse.json({ error: '未配置 API Key' }, { status: 400 });
  }

  let endpoint = settings.endpoint.trim();
  try {
    endpoint = resolveAiApiUrl(endpoint);
  } catch {
    return NextResponse.json(
      { error: 'API Endpoint 不是有效 URL' },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: createAiApiHeaders({
        id: settings.modelId,
        name: settings.modelName,
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        protocol: settings.selectedModel.protocol,
      }),
      body: JSON.stringify(
        createAiApiRequest(
          {
            system: '你是一个连接测试助手。',
            user: '请回复"连接成功"四个字。',
          },
          {
            id: settings.modelId,
            name: settings.modelName,
            endpoint: settings.endpoint,
            apiKey: settings.apiKey,
            model: settings.model,
            protocol: settings.selectedModel.protocol,
          },
        ),
      ),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = `HTTP ${response.status}`;
      try {
        const json = JSON.parse(text);
        detail = json?.error?.message || detail;
      } catch {
        if (text) detail = text.slice(0, 200);
      }
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
