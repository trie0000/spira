// Azure OpenAI 互換クライアント — 社内 AI ゲートウェイ用。
//
// 仕様:
//   URL: {baseUrl}/openai/deployments/{deployment-id}/chat/completions
//        ?api-version={api-version}
//   ヘッダ: api-key: <key>, Content-Type: application/json
//   レスポンス: OpenAI 互換 (choices[].message.content)
//   ストリーミング: SSE — `data: {...}\n\n` 形式
//
// 入出力は OpenAI 形式 (role: 'system'|'user'|'assistant', content: string)。
// 呼出側 (aiChat.ts) で Claude 形式と相互変換する。

import { findCorpAiModel, getCorpAiKey, getCorpAiModel, resolveCorpAiEndpoint } from './aiSettings';

export interface OAMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CorpHandlers {
  onText?: (delta: string) => void;
}

export interface CorpOpts {
  messages: OAMessage[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  stream?: CorpHandlers;
}

function chatUrlFor(modelId: string): string {
  const m = findCorpAiModel(modelId);
  if (!m) throw new Error('未知のモデル: ' + modelId);
  const ep = resolveCorpAiEndpoint(modelId);
  if (!ep.baseUrl) throw new Error('社内 AI ベース URL が未設定です (設定で構成)');
  if (!ep.deploymentId) throw new Error('社内 AI デプロイ名が未設定です (設定でプレフィックスを構成)');
  return ep.baseUrl +
    '/openai/deployments/' + ep.deploymentId +
    '/chat/completions?api-version=' + ep.apiVersion;
}

export async function callCorpAi(opts: CorpOpts): Promise<string> {
  const apiKey = getCorpAiKey();
  if (!apiKey) throw new Error('社内 AI API キーが未設定です');
  const modelId = opts.model || getCorpAiModel();
  const m = findCorpAiModel(modelId);
  if (!m) throw new Error('未知のモデル: ' + modelId);

  const body: Record<string, unknown> = {
    messages: opts.messages,
  };
  if (opts.maxTokens) {
    if (m.reasoning) body.max_completion_tokens = opts.maxTokens;
    else body.max_tokens = opts.maxTokens;
  }

  if (opts.stream?.onText) {
    body.stream = true;
    return streamChat(chatUrlFor(modelId), apiKey, body, opts.stream.onText, opts.signal);
  }

  const r = await fetch(chatUrlFor(modelId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(formatCorpError(r.status, txt));
  }
  const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content || '';
}

async function streamChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => '');
    throw new Error(formatCorpError(r.status, txt));
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = j.choices?.[0]?.delta?.content;
          if (piece) {
            full += piece;
            onText(piece);
          }
        } catch { /* ignore */ }
      }
    }
  }
  return full;
}

function formatCorpError(status: number, body: string): string {
  // Try to extract OpenAI-style error message
  try {
    const j = JSON.parse(body) as { error?: { message?: string } };
    if (j.error?.message) return `社内 AI API失敗: ${status} — ${j.error.message}`;
  } catch { /* ignore */ }
  return `社内 AI API失敗: ${status}${body ? ' — ' + body.slice(0, 200) : ''}`;
}
