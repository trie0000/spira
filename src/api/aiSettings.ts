// AI provider / model / API key settings — modeled after shapion's
// `src/api/ai-settings.ts`. Two back-ends are supported:
//   - Anthropic Claude API (direct browser call)
//   - Azure OpenAI 互換 (社内 AI ゲートウェイ) — base URL + deployment prefix
//     configured per tenant.
//
// All values persist in localStorage. The chat UI reads via `getProvider` etc.
// Switching providers retains each provider's key/model separately so the
// user doesn't lose state by toggling.
//
// Storage keys are intentionally prefixed `spira:ai:` so a future "reset
// settings" feature can scope the wipe.

export type Provider = 'claude' | 'corp';

export interface CorpAiModel {
  id: string;
  /** Reasoning model — uses `max_completion_tokens` instead of `max_tokens`. */
  reasoning: boolean;
}

export const CORP_AI_MODELS: CorpAiModel[] = [
  { id: 'gpt-5',           reasoning: true  },
  { id: 'gpt-5-mini',      reasoning: true  },
  { id: 'gpt-5-nano',      reasoning: true  },
  { id: 'o3',              reasoning: true  },
  { id: 'o4-mini',         reasoning: true  },
  { id: 'gpt-4.1',         reasoning: false },
  { id: 'gpt-4.1-mini',    reasoning: false },
  { id: 'gpt-4.1-nano',    reasoning: false },
  { id: 'gpt-4o',          reasoning: false },
  { id: 'gpt-4o-mini',     reasoning: false },
];

export const CLAUDE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-opus-4-5',          label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5',        label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5' },
];

const DEFAULT_PROVIDER: Provider = 'claude';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
const DEFAULT_CORP_MODEL = 'gpt-4.1-mini';

const KEY = {
  provider:        'spira:ai:provider',
  claudeModel:     'spira:ai:claude:model',
  claudeKey:       'spira:ai:claude:key',
  corpModel:       'spira:ai:corp:model',
  corpKey:         'spira:ai:corp:key',
  corpBaseUrl:     'spira:ai:corp:base-url',
  corpDeployPrefix:'spira:ai:corp:deploy-prefix',
  corpOverrides:   'spira:ai:corp:overrides',
} as const;

function lsGet(k: string): string {
  try { return localStorage.getItem(k) ?? ''; } catch { return ''; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* quota */ }
}

// ─── Provider ─────────────────────────────────────────────────────────────
export function getProvider(): Provider {
  const v = lsGet(KEY.provider);
  if (v === 'corp') return 'corp';
  return DEFAULT_PROVIDER;
}
export function setProvider(p: Provider): void { lsSet(KEY.provider, p); }

// ─── Claude ───────────────────────────────────────────────────────────────
export function getClaudeModel(): string {
  return lsGet(KEY.claudeModel) || DEFAULT_CLAUDE_MODEL;
}
export function setClaudeModel(m: string): void { lsSet(KEY.claudeModel, m); }
export function getClaudeApiKey(): string { return lsGet(KEY.claudeKey); }
export function setClaudeApiKey(k: string): void { lsSet(KEY.claudeKey, k.trim()); }

// ─── Azure OpenAI 互換 (社内 AI) ──────────────────────────────────────────
export function getCorpAiModel(): string {
  const stored = lsGet(KEY.corpModel);
  if (stored && CORP_AI_MODELS.some(m => m.id === stored)) return stored;
  return DEFAULT_CORP_MODEL;
}
export function setCorpAiModel(m: string): void { lsSet(KEY.corpModel, m); }
export function getCorpAiKey(): string { return lsGet(KEY.corpKey); }
export function setCorpAiKey(k: string): void { lsSet(KEY.corpKey, k.trim()); }

/** Base URL of the corporate AI gateway. The full chat URL is built as:
 *    {baseUrl}/openai/deployments/{deployment-id}/chat/completions?api-version=...
 *  Empty when not configured — request helpers throw a clear error. */
export function getCorpAiBaseUrl(): string {
  return lsGet(KEY.corpBaseUrl).replace(/\/$/, '');
}
export function setCorpAiBaseUrl(url: string): void { lsSet(KEY.corpBaseUrl, url.trim()); }

/** Prefix used to build the deployment id for each model: `<prefix><model>`
 *  (model name with dots stripped). E.g. prefix=`shapion-` + `gpt-4.1` →
 *  `shapion-gpt-41`. */
export function getCorpAiDeploymentPrefix(): string {
  return lsGet(KEY.corpDeployPrefix);
}
export function setCorpAiDeploymentPrefix(p: string): void { lsSet(KEY.corpDeployPrefix, p.trim()); }

export function deploymentIdFor(modelId: string): string {
  const prefix = getCorpAiDeploymentPrefix();
  const tail = modelId.replace(/\./g, '');
  return prefix + tail;
}

// Per-model overrides (JSON, optional). Allows different baseUrl / apiVersion
// per model family for tenants that split GPT-5 series onto a separate host.
export interface CorpAiOverride {
  baseUrl?: string;
  apiVersion?: string;
  deploymentId?: string;
}
export function getCorpAiOverridesRaw(): string { return lsGet(KEY.corpOverrides); }
export function setCorpAiOverridesRaw(json: string): void { lsSet(KEY.corpOverrides, json.trim()); }
export function getCorpAiOverrides(): Record<string, CorpAiOverride> {
  const raw = getCorpAiOverridesRaw();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return o as Record<string, CorpAiOverride>;
  } catch { /* ignore */ }
  return {};
}

export function findCorpAiModel(modelId: string): CorpAiModel | null {
  return CORP_AI_MODELS.find(m => m.id === modelId) ?? null;
}

export function resolveCorpAiEndpoint(modelId: string): {
  baseUrl: string;
  apiVersion: string;
  deploymentId: string;
} {
  const m = findCorpAiModel(modelId);
  const defaultApiVersion = m?.reasoning ? '2024-12-01-preview' : '2024-06-01';
  const ov = getCorpAiOverrides()[modelId] || {};
  return {
    baseUrl: (ov.baseUrl || getCorpAiBaseUrl() || '').replace(/\/$/, ''),
    apiVersion: ov.apiVersion || defaultApiVersion,
    deploymentId: ov.deploymentId || deploymentIdFor(modelId),
  };
}

export function getActiveModel(): string {
  return getProvider() === 'corp' ? getCorpAiModel() : getClaudeModel();
}
