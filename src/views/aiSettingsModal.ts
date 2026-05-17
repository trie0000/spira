// AI 設定モーダル — プロバイダ (Claude / 社内 AI) と API キー、モデル、
// 社内 AI のベース URL / デプロイプレフィクスを編集する。レイアウトは
// 既存の設定モーダル群と同じ 2 列グリッド。

import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import {
  getProvider, setProvider,
  getClaudeApiKey, setClaudeApiKey,
  getClaudeModel, setClaudeModel,
  getCorpAiKey, setCorpAiKey,
  getCorpAiModel, setCorpAiModel,
  getCorpAiBaseUrl, setCorpAiBaseUrl,
  getCorpAiDeploymentPrefix, setCorpAiDeploymentPrefix,
  getCorpAiOverridesRaw, setCorpAiOverridesRaw,
  CLAUDE_MODELS, CORP_AI_MODELS,
  type Provider,
} from '../api/aiSettings';

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

const LABEL_STYLE =
  'color:var(--ink-3);font-size:var(--fs-sm);' +
  'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
const LABEL_TOP_STYLE = LABEL_STYLE + ';align-self:start;padding-top:8px';

export function openAiSettingsModal(): void {
  const initialProvider = getProvider();

  // Provider radio
  const providerSelect = el('select', { class: 'spira-input', style: 'width:200px' }, [
    el('option', { value: 'claude', ...(initialProvider === 'claude' ? { selected: 'selected' } : {}) }, ['Claude (Anthropic)']),
    el('option', { value: 'corp',   ...(initialProvider === 'corp'   ? { selected: 'selected' } : {}) }, ['社内 AI (Azure OpenAI 互換)']),
  ]) as HTMLSelectElement;

  // ── Claude block ─────────────────────────────────────────────────────
  const claudeKeyInput = el('input', {
    type: 'password',
    class: 'spira-input',
    placeholder: 'sk-ant-... (Anthropic API キー)',
    autocomplete: 'off',
    value: getClaudeApiKey(),
  }) as HTMLInputElement;
  const claudeModelSel = el('select', { class: 'spira-input', style: 'width:100%' },
    CLAUDE_MODELS.map(m => el('option', {
      value: m.id,
      ...(m.id === getClaudeModel() ? { selected: 'selected' } : {}),
    }, [m.label])),
  ) as HTMLSelectElement;

  const claudeBlock = el('div', { class: 'spira-ai-block', 'data-provider': 'claude' }, [
    el('div', { style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:var(--s-3) var(--s-4);align-items:center' }, [
      el('label', { style: LABEL_STYLE }, ['API キー']),
      claudeKeyInput,
      el('label', { style: LABEL_STYLE }, ['モデル']),
      claudeModelSel,
    ]),
    el('p', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin:var(--s-2) 0 0;line-height:1.6' }, [
      '※ ブラウザから直接 Anthropic API を呼び出します。API キーは localStorage に保存されます (',
      el('code', {}, ['spira:ai:claude:key']),
      ')。 本格運用ではゲートウェイ経由 (社内 AI 側) を推奨。',
    ]),
  ]);

  // ── Corp AI block ────────────────────────────────────────────────────
  const corpKeyInput = el('input', {
    type: 'password',
    class: 'spira-input',
    placeholder: 'Azure OpenAI 互換 API キー',
    autocomplete: 'off',
    value: getCorpAiKey(),
  }) as HTMLInputElement;
  const corpBaseUrlInput = el('input', {
    type: 'url',
    class: 'spira-input',
    placeholder: 'https://gateway.example.com/myapi',
    autocomplete: 'off',
    value: getCorpAiBaseUrl(),
  }) as HTMLInputElement;
  const corpPrefixInput = el('input', {
    type: 'text',
    class: 'spira-input',
    placeholder: 'spira- (deployment id プレフィクス)',
    autocomplete: 'off',
    value: getCorpAiDeploymentPrefix(),
  }) as HTMLInputElement;
  const corpModelSel = el('select', { class: 'spira-input', style: 'width:100%' },
    CORP_AI_MODELS.map(m => el('option', {
      value: m.id,
      ...(m.id === getCorpAiModel() ? { selected: 'selected' } : {}),
    }, [m.id])),
  ) as HTMLSelectElement;
  const corpOverrideTa = el('textarea', {
    class: 'spira-input',
    rows: '4',
    style: 'width:100%;font:12px/1.5 ui-monospace,Menlo,monospace',
    placeholder: '{"gpt-5":{"apiVersion":"2025-01-01-preview"}}',
  }) as HTMLTextAreaElement;
  corpOverrideTa.value = getCorpAiOverridesRaw();

  const corpBlock = el('div', { class: 'spira-ai-block', 'data-provider': 'corp' }, [
    el('div', { style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:var(--s-3) var(--s-4);align-items:center' }, [
      el('label', { style: LABEL_STYLE }, ['API キー']),
      corpKeyInput,
      el('label', { style: LABEL_STYLE }, ['ベース URL']),
      corpBaseUrlInput,
      el('label', { style: LABEL_STYLE }, ['デプロイ prefix']),
      corpPrefixInput,
      el('label', { style: LABEL_STYLE }, ['モデル']),
      corpModelSel,
      el('label', { style: LABEL_TOP_STYLE }, ['オーバーライド (JSON)']),
      corpOverrideTa,
    ]),
    el('p', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin:var(--s-2) 0 0;line-height:1.6' }, [
      '※ デプロイ ID は ',
      el('code', {}, ['<prefix><モデル名 (.除く)>']),
      ' で組み立てます。例: prefix=',
      el('code', {}, ['spira-']),
      ' + ',
      el('code', {}, ['gpt-4.1']),
      ' → ',
      el('code', {}, ['spira-gpt-41']),
      '。',
      el('br'),
      'モデル毎に baseUrl/apiVersion/deploymentId を上書きしたい場合のみ JSON で指定。',
    ]),
  ]);

  // Toggle visibility based on provider select
  const blockArea = el('div', { style: 'margin-top:var(--s-5)' }, [claudeBlock, corpBlock]);
  const syncVisibility = (): void => {
    const p = providerSelect.value;
    claudeBlock.style.display = (p === 'claude') ? '' : 'none';
    corpBlock.style.display = (p === 'corp') ? '' : 'none';
  };
  providerSelect.addEventListener('change', syncVisibility);
  syncVisibility();

  const body = el('div', { style: 'max-width:600px' }, [
    el('p', { style: 'margin:0 0 var(--s-4);font-size:var(--fs-sm);color:var(--ink-3);line-height:1.6' }, [
      'チケット詳細の右ペインで使う AI チャットの設定です。プロバイダ・モデル・API キーをここで管理します。',
    ]),
    el('div', { style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:var(--s-3) var(--s-4);align-items:center' }, [
      el('label', { style: LABEL_STYLE }, ['プロバイダ']),
      providerSelect,
    ]),
    blockArea,
  ]);

  openModal(getRoot(), {
    title: 'AI 設定',
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: async () => {
      try {
        // Validate corp JSON if user typed something
        const raw = corpOverrideTa.value.trim();
        if (raw) {
          try { JSON.parse(raw); }
          catch { throw new Error('オーバーライド JSON が不正です'); }
        }
        setProvider(providerSelect.value as Provider);
        setClaudeApiKey(claudeKeyInput.value);
        setClaudeModel(claudeModelSel.value);
        setCorpAiKey(corpKeyInput.value);
        setCorpAiBaseUrl(corpBaseUrlInput.value);
        setCorpAiDeploymentPrefix(corpPrefixInput.value);
        setCorpAiModel(corpModelSel.value);
        setCorpAiOverridesRaw(raw);
        toast(getRoot(), 'AI 設定を保存しました', 'ok');
      } catch (e) {
        toast(getRoot(), `保存失敗: ${(e as Error).message}`, 'error');
        throw e;
      }
    },
  });
}
