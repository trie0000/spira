// Anthropic Claude API client (browser-direct). Mirrors shapion's
// `src/api/anthropic.ts` minus the agentic tool-use loop — Spira's first
// AI chat iteration is text-in / text-out (Q&A + draft generation).
//
// Streaming text deltas are surfaced via `opts.stream.onText`. AbortSignal
// support lets the UI cancel mid-flight.
//
// SECURITY NOTE: browser-direct Claude calls require
// `anthropic-dangerous-direct-browser-access: true`. In production-grade
// deployments this should be proxied through a server-side gateway so the
// API key never reaches end users. We mirror shapion's choice to direct-call
// for parity; tenants who care will use the 社内 AI (Azure OpenAI 互換) path.

import { getClaudeApiKey } from './aiSettings';

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export type TextBlock = { type: 'text'; text: string };
export type ContentBlock = TextBlock;
export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
}

export interface ClaudeOpts {
  messages: ApiMessage[];
  system?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  stream?: StreamHandlers;
}

export interface ClaudeResponse {
  content: ContentBlock[];
  stop_reason: string;
}

/** Returns the full structured response. When `opts.stream.onText` is set,
 *  the request streams SSE deltas as well. */
export async function callClaude(opts: ClaudeOpts): Promise<ClaudeResponse> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) throw new Error('Claude API キーが未設定です');

  const body: Record<string, unknown> = {
    model: opts.model || DEFAULT_MODEL,
    max_tokens: opts.maxTokens || 4096,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.stream) body.stream = true;

  // 429 → respect retry-after, capped at 3 attempts.
  let attempt = 0;
  while (true) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (r.ok) {
      if (opts.stream && r.body) return consumeStream(r.body, opts.stream);
      return await r.json() as ClaudeResponse;
    }

    if (r.status === 429 && attempt < 3) {
      const retryAfter = parseFloat(r.headers.get('retry-after') || '0');
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 1000 * Math.pow(2, attempt));
      await new Promise(res => setTimeout(res, waitMs));
      attempt++;
      continue;
    }

    let detail = '';
    try {
      const j = await r.json() as { error?: { message?: string } };
      if (j.error?.message) detail = ' — ' + j.error.message;
    } catch { /* ignore */ }
    throw new Error('Claude API失敗: ' + r.status + detail);
  }
}

/** Convenience: returns concatenated assistant text only. */
export async function callClaudeText(opts: ClaudeOpts): Promise<string> {
  const res = await callClaude(opts);
  return res.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<ClaudeResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const blocks: ContentBlock[] = [];
  let stopReason = 'end_turn';

  function flushEvent(name: string, data: string): void {
    if (!data) return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    const ev = payload as Record<string, unknown>;
    if (name === 'content_block_start') {
      const idx = ev.index as number;
      const cb = ev.content_block as ContentBlock;
      if (cb.type === 'text') blocks[idx] = { type: 'text', text: '' };
    } else if (name === 'content_block_delta') {
      const idx = ev.index as number;
      const delta = ev.delta as { type: string; text?: string };
      const block = blocks[idx];
      if (delta.type === 'text_delta' && block && block.type === 'text') {
        block.text += delta.text || '';
        handlers.onText?.(delta.text || '');
      }
    } else if (name === 'message_delta') {
      const delta = ev.delta as { stop_reason?: string };
      if (delta?.stop_reason) stopReason = delta.stop_reason;
    }
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      let evName = '';
      let evData = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) evName = line.slice(6).trim();
        else if (line.startsWith('data:')) evData += line.slice(5).trim();
      }
      flushEvent(evName, evData);
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}
