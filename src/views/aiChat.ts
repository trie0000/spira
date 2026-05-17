// AI chat panel — right pane on the ticket detail view.
//
// Modeled after shapion's `src/ui/ai-chat.ts`. Layout (top → bottom):
//
//   ┌────────────────────────────────┐
//   │ ✨ AIチャット   [+] [🗑] [⚙] [×] │  header (44px)
//   ├────────────────────────────────┤
//   │ ▾ 会話タイトル              ▾  │  history dropdown
//   ├────────────────────────────────┤
//   │                                │
//   │   あなた                       │
//   │   ┌──────────────────────────┐ │
//   │   │ ユーザ発話 (全幅 beige)   │ │
//   │   └──────────────────────────┘ │
//   │   AI                           │
//   │   ┌──────────────────────────┐ │
//   │   │ AI 応答 (全幅 white)      │ │
//   │   └──────────────────────────┘ │
//   │                                │  scrollable messages
//   ├────────────────────────────────┤
//   │ [要約][返信案][メモ案][...]    │  quick chips
//   ├────────────────────────────────┤
//   │ ▾ Claude Sonnet 4.5            │  provider+model picker
//   │ ┌──────────────────────────┐ ▶ │  textarea + send
//   │ │ プロンプト入力…          │   │
//   │ └──────────────────────────┘   │
//   └────────────────────────────────┘
//
// Sessions are persisted per-ticket in localStorage, with history dropdown
// to switch between past conversations (max 20 per ticket).

import { el } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { setState } from '../state';
import { toast } from '../components/toast';
import { confirmModal } from '../components/modal';
import type { Ticket, Comment } from '../types';
import {
  getProvider, setProvider, getActiveModel,
  getClaudeModel, setClaudeModel, getClaudeApiKey,
  getCorpAiModel, setCorpAiModel, getCorpAiKey,
  CLAUDE_MODELS, CORP_AI_MODELS,
} from '../api/aiSettings';
import { callClaude, type ApiMessage } from '../api/aiClaude';
import { callCorpAi, type OAMessage } from '../api/aiCorp';
import { buildTicketContext, SPIRA_AI_SYSTEM_PROMPT } from '../lib/aiContext';
import { openAiSettingsModal } from './aiSettingsModal';

const MAX_SESSIONS_PER_TICKET = 20;
const MAX_TURNS_PER_SESSION = 50;

// ─── Per-ticket multi-session state ───────────────────────────────────────

interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}
interface AiSession {
  id: string;
  title: string;
  created: number;
  messages: AiTurn[];
  /** AI-generated title takes precedence over the fallback "first 24 chars". */
  aiTitled?: boolean;
}

function sessionsKey(ticketId: number): string {
  return `spira:ai:sessions:${ticketId}`;
}
function activeSessionKey(ticketId: number): string {
  return `spira:ai:active-session:${ticketId}`;
}

function loadSessions(ticketId: number): AiSession[] {
  try {
    const raw = localStorage.getItem(sessionsKey(ticketId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as AiSession[];
    if (Array.isArray(arr)) return arr;
  } catch { /* ignore */ }
  return [];
}
function saveSessions(ticketId: number, sessions: AiSession[]): void {
  try {
    localStorage.setItem(sessionsKey(ticketId), JSON.stringify(sessions.slice(0, MAX_SESSIONS_PER_TICKET)));
  } catch { /* quota */ }
}
function loadActiveSessionId(ticketId: number): string | null {
  try { return localStorage.getItem(activeSessionKey(ticketId)); } catch { return null; }
}
function saveActiveSessionId(ticketId: number, id: string | null): void {
  try {
    if (id) localStorage.setItem(activeSessionKey(ticketId), id);
    else localStorage.removeItem(activeSessionKey(ticketId));
  } catch { /* ignore */ }
}

function firstUserText(messages: AiTurn[]): string {
  for (const m of messages) if (m.role === 'user' && m.content.trim()) return m.content;
  return '会話';
}

// ─── Mount + render ───────────────────────────────────────────────────────

interface MountCtx {
  ticket: Ticket;
  comments: Comment[];
}

let _activeAbort: AbortController | null = null;
let _loading = false;
let _streamingText = '';
const aiPanelOpenKey = 'spira:ai:panel-open';

interface PaneInternals {
  ticketId: number;
  ctx: MountCtx;
  sessions: AiSession[];
  activeId: string | null;
  /** Mutable handle to the currently-active session's messages array. */
  activeMessages: AiTurn[];
  messagesEl: HTMLElement;
  historySel: HTMLSelectElement;
  sendBtn: HTMLElement;
  input: HTMLTextAreaElement;
}

export function createAiChatPane(ctx: MountCtx): HTMLElement {
  const ticketId = ctx.ticket.id;
  const sessions = loadSessions(ticketId);
  const activeId = loadActiveSessionId(ticketId);
  const active = sessions.find(s => s.id === activeId) ?? null;
  const activeMessages: AiTurn[] = active ? [...active.messages] : [];

  // ── Header ──────────────────────────────────────────────────────────
  const newBtn = el('button', {
    type: 'button',
    class: 'spira-ai-iconbtn',
    title: '新しい会話',
  }, [el('span', { html: icon('plus'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const trashBtn = el('button', {
    type: 'button',
    class: 'spira-ai-iconbtn',
    title: 'この会話を削除',
  }, [el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const settingsBtn = el('button', {
    type: 'button',
    class: 'spira-ai-iconbtn',
    title: 'AI 設定',
    onclick: () => openAiSettingsModal(),
  }, [el('span', { html: icon('gear'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const closeBtn = el('button', {
    type: 'button',
    class: 'spira-ai-iconbtn',
    title: 'パネルを閉じる',
    onclick: () => closeAiPanel(),
  }, [el('span', { html: icon('x'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const header = el('div', { class: 'spira-ai-hd' }, [
    el('span', { class: 'spira-ai-title' }, [
      el('span', { html: icon('sparkles'), style: 'display:inline-flex;width:16px;height:16px;color:var(--accent)' }),
      'AI チャット',
    ]),
    el('span', { style: 'flex:1' }),
    newBtn, trashBtn, settingsBtn, closeBtn,
  ]);

  // ── History dropdown ────────────────────────────────────────────────
  const historySel = el('select', {
    class: 'spira-ai-hist',
    title: '過去の会話に切り替え',
  }) as HTMLSelectElement;
  const histRow = el('div', { class: 'spira-ai-hist-row' }, [historySel]);

  // ── Messages list ───────────────────────────────────────────────────
  const messagesEl = el('div', { class: 'spira-ai-messages' });

  // ── Quick prompt chips ──────────────────────────────────────────────
  const chips = el('div', { class: 'spira-ai-chips' },
    QUICK_PROMPTS.map(qp => el('button', {
      type: 'button',
      class: 'spira-ai-chip',
      onclick: () => {
        internals.input.value = qp.prompt;
        internals.input.dispatchEvent(new Event('input', { bubbles: true }));
        internals.input.focus();
      },
    }, [qp.label])),
  );

  // ── Input area ──────────────────────────────────────────────────────
  const modelPicker = el('select', {
    class: 'spira-ai-model-pick',
    title: 'プロバイダ / モデル',
    onchange: (e: Event) => applyModelPick((e.target as HTMLSelectElement).value, modelPicker),
  }) as HTMLSelectElement;
  syncModelPicker(modelPicker);

  const input = el('textarea', {
    class: 'spira-ai-input',
    rows: '2',
    placeholder: 'このチケットについて質問・要約・返信案など…',
  }) as HTMLTextAreaElement;
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(220, input.scrollHeight + 2) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void onSend();
    }
  });

  const sendBtn = el('button', {
    type: 'button',
    class: 'spira-ai-send',
    title: '送信 (⌘↵)',
    onclick: () => void onSend(),
  }, [el('span', { html: icon('send'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const inputArea = el('div', { class: 'spira-ai-inputarea' }, [
    modelPicker,
    el('div', { class: 'spira-ai-input-wrap' }, [input, sendBtn]),
  ]);

  // ── Pane root ───────────────────────────────────────────────────────
  const pane = el('div', { class: 'spira-ai-pane' }, [
    header,
    histRow,
    messagesEl,
    chips,
    inputArea,
  ]);

  const internals: PaneInternals = {
    ticketId,
    ctx,
    sessions,
    activeId: active?.id ?? null,
    activeMessages,
    messagesEl,
    historySel,
    sendBtn,
    input,
  };

  // wire up handlers that need internals
  newBtn.addEventListener('click', () => startNewSession(internals));
  trashBtn.addEventListener('click', () => deleteActiveSession(internals));
  historySel.addEventListener('change', () => onHistoryChange(internals));

  renderHistoryDropdown(internals);
  renderMessages(internals);

  async function onSend(): Promise<void> {
    if (_loading) { cancelInflight(); return; }
    const text = internals.input.value.trim();
    if (!text) return;
    if (!checkProviderConfig()) return;

    internals.activeMessages.push({ role: 'user', content: text });
    internals.input.value = '';
    internals.input.style.height = '';
    _loading = true;
    _streamingText = '';
    renderMessages(internals);
    updateSendButton(internals.sendBtn);

    const ctrl = new AbortController();
    _activeAbort = ctrl;

    const provider = getProvider();
    const model = getActiveModel();
    const ticketCtx = buildTicketContext(internals.ctx.ticket, internals.ctx.comments);
    const systemText = SPIRA_AI_SYSTEM_PROMPT + '\n\n' + ticketCtx;

    try {
      if (provider === 'claude') {
        const apiMsgs: ApiMessage[] = internals.activeMessages.map(m => ({ role: m.role, content: m.content }));
        const res = await callClaude({
          messages: apiMsgs,
          system: systemText,
          model,
          maxTokens: 4096,
          signal: ctrl.signal,
          stream: {
            onText: (delta) => {
              _streamingText += delta;
              updateStreamingBubble(internals.messagesEl, _streamingText);
            },
          },
        });
        const fullText = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        internals.activeMessages.push({ role: 'assistant', content: fullText });
      } else {
        const oaMsgs: OAMessage[] = [
          { role: 'system', content: systemText },
          ...internals.activeMessages.map(m => ({ role: m.role, content: m.content }) as OAMessage),
        ];
        const fullText = await callCorpAi({
          messages: oaMsgs,
          model,
          maxTokens: 4096,
          signal: ctrl.signal,
          stream: {
            onText: (delta) => {
              _streamingText += delta;
              updateStreamingBubble(internals.messagesEl, _streamingText);
            },
          },
        });
        internals.activeMessages.push({ role: 'assistant', content: fullText });
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' || /aborted/i.test(e.message)) {
        internals.activeMessages.push({ role: 'assistant', content: '(中断しました)' });
      } else {
        internals.activeMessages.push({ role: 'assistant', content: '⚠️ ' + e.message });
        toast(getRoot(), 'AI 失敗: ' + e.message, 'error');
      }
    } finally {
      _activeAbort = null;
      _loading = false;
      _streamingText = '';
      persistActiveSession(internals);
      renderMessages(internals);
      renderHistoryDropdown(internals);
      updateSendButton(internals.sendBtn);
    }
  }

  return pane;
}

function cancelInflight(): void {
  if (_activeAbort) { _activeAbort.abort(); _activeAbort = null; }
}

function checkProviderConfig(): boolean {
  const p = getProvider();
  if (p === 'claude') {
    if (!getClaudeApiKey()) {
      toast(getRoot(), 'Claude API キーが未設定です。AI 設定から登録してください', 'error');
      openAiSettingsModal();
      return false;
    }
  } else if (p === 'corp') {
    if (!getCorpAiKey()) {
      toast(getRoot(), '社内 AI API キーが未設定です。AI 設定から登録してください', 'error');
      openAiSettingsModal();
      return false;
    }
  }
  return true;
}

// ─── Sessions ─────────────────────────────────────────────────────────────

function persistActiveSession(internals: PaneInternals): void {
  if (internals.activeMessages.length === 0) return;
  const fallbackTitle = firstUserText(internals.activeMessages).slice(0, 24) || '会話';
  if (!internals.activeId) {
    internals.activeId = 'sess-' + Date.now();
    const newSess: AiSession = {
      id: internals.activeId,
      title: fallbackTitle,
      created: Date.now(),
      messages: [...internals.activeMessages].slice(-MAX_TURNS_PER_SESSION),
    };
    internals.sessions = [newSess, ...internals.sessions];
  } else {
    const existing = internals.sessions.find(s => s.id === internals.activeId);
    if (existing) {
      existing.messages = [...internals.activeMessages].slice(-MAX_TURNS_PER_SESSION);
      if (!existing.aiTitled) existing.title = fallbackTitle;
    } else {
      internals.sessions = [{
        id: internals.activeId,
        title: fallbackTitle,
        created: Date.now(),
        messages: [...internals.activeMessages].slice(-MAX_TURNS_PER_SESSION),
      }, ...internals.sessions];
    }
  }
  saveSessions(internals.ticketId, internals.sessions);
  saveActiveSessionId(internals.ticketId, internals.activeId);
}

function startNewSession(internals: PaneInternals): void {
  internals.activeId = null;
  internals.activeMessages = [];
  saveActiveSessionId(internals.ticketId, null);
  renderMessages(internals);
  renderHistoryDropdown(internals);
}

function deleteActiveSession(internals: PaneInternals): void {
  if (!internals.activeId && internals.activeMessages.length === 0) return;
  confirmModal(getRoot(), {
    title: '会話を削除',
    message: 'この AI 会話を削除します。元に戻せません。',
    primaryLabel: '削除',
    primaryVariant: 'danger',
    onConfirm: () => {
      if (internals.activeId) {
        internals.sessions = internals.sessions.filter(s => s.id !== internals.activeId);
        saveSessions(internals.ticketId, internals.sessions);
      }
      internals.activeId = null;
      internals.activeMessages = [];
      saveActiveSessionId(internals.ticketId, null);
      renderMessages(internals);
      renderHistoryDropdown(internals);
    },
  });
}

function onHistoryChange(internals: PaneInternals): void {
  const v = internals.historySel.value;
  if (v === '__new__') {
    startNewSession(internals);
    return;
  }
  const found = internals.sessions.find(s => s.id === v);
  if (!found) return;
  internals.activeId = found.id;
  internals.activeMessages = [...found.messages];
  saveActiveSessionId(internals.ticketId, found.id);
  renderMessages(internals);
}

function renderHistoryDropdown(internals: PaneInternals): void {
  const sel = internals.historySel;
  sel.innerHTML = '';
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ 新しい会話';
  if (internals.activeId === null) newOpt.selected = true;
  sel.appendChild(newOpt);
  for (const s of internals.sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.title || '会話';
    if (s.id === internals.activeId) o.selected = true;
    sel.appendChild(o);
  }
}

// ─── Model picker ─────────────────────────────────────────────────────────

function syncModelPicker(sel: HTMLSelectElement): void {
  const provider = getProvider();
  const claudeModel = getClaudeModel();
  const corpModel = getCorpAiModel();
  const cur = provider + ':' + (provider === 'corp' ? corpModel : claudeModel);
  sel.innerHTML = '';
  const claudeGroup = document.createElement('optgroup');
  claudeGroup.label = 'Claude';
  for (const m of CLAUDE_MODELS) {
    const o = document.createElement('option');
    o.value = 'claude:' + m.id;
    o.textContent = m.label;
    claudeGroup.appendChild(o);
  }
  sel.appendChild(claudeGroup);
  const corpGroup = document.createElement('optgroup');
  corpGroup.label = '社内 AI';
  for (const m of CORP_AI_MODELS) {
    const o = document.createElement('option');
    o.value = 'corp:' + m.id;
    o.textContent = m.id;
    corpGroup.appendChild(o);
  }
  sel.appendChild(corpGroup);
  sel.value = cur;
}

function applyModelPick(value: string, sel: HTMLSelectElement): void {
  const idx = value.indexOf(':');
  if (idx < 0) return;
  const provider = value.slice(0, idx);
  const modelId = value.slice(idx + 1);
  if (provider !== 'claude' && provider !== 'corp') return;
  setProvider(provider);
  if (provider === 'claude') setClaudeModel(modelId);
  else setCorpAiModel(modelId);
  syncModelPicker(sel);
}

// ─── Quick prompt chips ───────────────────────────────────────────────────

const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: '要約',     prompt: 'このチケットのスレッドと内部メモをまとめて、経緯・現状・残課題を 5〜10 行で要約してください。' },
  { label: '返信案',   prompt: '直近の顧客発言に対する返信文面案を作成してください。丁寧語・敬語で、```markdown ... ``` のコードブロックで囲んでください。' },
  { label: 'メモ案',   prompt:
    '現時点の対応状況を内部メモとしてまとめてください。\n' +
    '形式:\n' +
    '- 見出しは使わない (本文のみ)\n' +
    '- 太字で **現状** / **背景** / **次のアクション** の 3 項目を立てて、各 1〜3 行で記述\n' +
    '- 箇条書きはネストせず、フラットに 1 階層まで\n' +
    '- 全体で 15 行以内、簡潔で読みやすく\n' +
    '出力は ```markdown ... ``` のコードブロックで囲んでください。' },
  { label: 'アクション抽出', prompt: 'このチケットに関するアクション項目 / 未解決タスクを箇条書きで抽出してください。' },
];

// ─── Rendering ────────────────────────────────────────────────────────────

function renderMessages(internals: PaneInternals): void {
  const container = internals.messagesEl;
  container.innerHTML = '';
  if (internals.activeMessages.length === 0 && !_loading) {
    const empty = el('div', { class: 'spira-ai-empty' }, [
      el('div', { class: 'spira-ai-empty-title' }, ['このチケットについて聞けます']),
      el('div', { class: 'spira-ai-empty-sub' }, [
        'スレッド・内部メモを全て参照済み。下のチップから始めるか、自由に入力してください。',
      ]),
    ]);
    container.appendChild(empty);
    return;
  }
  for (let i = 0; i < internals.activeMessages.length; i++) {
    const m = internals.activeMessages[i]!;
    container.appendChild(renderTurn(m, i, internals));
  }
  if (_loading) {
    container.appendChild(el('div', { class: 'spira-ai-row' }, [
      el('div', { class: 'spira-ai-label' }, ['AI']),
      el('div', {
        class: 'spira-ai-msg spira-ai-assistant spira-ai-loading',
        id: 'spira-ai-streaming',
      }, ['考え中…']),
    ]));
  }
  container.scrollTop = container.scrollHeight;
}

function renderTurn(m: AiTurn, index: number, internals: PaneInternals): HTMLElement {
  const row = el('div', { class: 'spira-ai-row' }, [
    el('div', { class: 'spira-ai-label' }, [m.role === 'user' ? 'あなた' : 'AI']),
  ]);
  const card = el('div', {
    class: 'spira-ai-msg ' + (m.role === 'user' ? 'spira-ai-user' : 'spira-ai-assistant'),
  });
  card.innerHTML = renderBody(m.content);
  row.appendChild(card);

  if (m.role === 'assistant') {
    const blocks = extractCodeBlocks(m.content);
    if (blocks.length > 0) {
      const actions = el('div', { class: 'spira-ai-actions' });
      blocks.forEach((b) => {
        actions.appendChild(el('button', {
          type: 'button',
          class: 'spira-ai-action-btn',
          title: 'このブロックを内部メモとして保存',
          onclick: () => void saveAsNote(internals.ticketId, b.content),
        }, ['📌 メモとして保存']));
        actions.appendChild(el('button', {
          type: 'button',
          class: 'spira-ai-action-btn',
          title: 'クリップボードにコピー',
          onclick: () => { void navigator.clipboard.writeText(b.content); toast(getRoot(), 'コピーしました', 'ok'); },
        }, ['コピー']));
      });
      row.appendChild(actions);
    }
  }
  void index;
  return row;
}

function updateStreamingBubble(container: HTMLElement, text: string): void {
  let bubble = container.querySelector<HTMLElement>('#spira-ai-streaming');
  if (!bubble) {
    container.querySelectorAll('.spira-ai-loading').forEach(n => n.parentElement?.remove());
    const row = el('div', { class: 'spira-ai-row' }, [
      el('div', { class: 'spira-ai-label' }, ['AI']),
      el('div', { class: 'spira-ai-msg spira-ai-assistant', id: 'spira-ai-streaming' }, []),
    ]);
    container.appendChild(row);
    bubble = row.querySelector<HTMLElement>('#spira-ai-streaming');
  }
  if (bubble) {
    bubble.innerHTML = renderBody(text);
    container.scrollTop = container.scrollHeight;
  }
}

function updateSendButton(btn: HTMLElement): void {
  if (_loading) {
    btn.classList.add('spira-ai-send--stop');
    btn.title = '中断';
    btn.innerHTML = '';
    btn.appendChild(el('span', { html: icon('stop'), style: 'display:inline-flex;width:14px;height:14px' }));
  } else {
    btn.classList.remove('spira-ai-send--stop');
    btn.title = '送信 (⌘↵)';
    btn.innerHTML = '';
    btn.appendChild(el('span', { html: icon('send'), style: 'display:inline-flex;width:14px;height:14px' }));
  }
}

// ─── Save as note ─────────────────────────────────────────────────────────

async function saveAsNote(ticketId: number, content: string): Promise<void> {
  const root = getRoot();
  confirmModal(root, {
    title: '内部メモとして保存',
    message: 'この AI 生成テキストを新しい内部メモとして保存しますか？',
    primaryLabel: '保存',
    primaryVariant: 'primary',
    onConfirm: async () => {
      try {
        const ai = await import('../api/aiSettings');
        const modelLabel = ai.getActiveModel();
        await getRepo().addComment({
          ticketId,
          type: 'note',
          fromName: 'AI Assistant',
          fromEmail: undefined,
          content: content + `\n\n<!-- AI 生成 (${modelLabel}) -->`,
          isHtml: false,
          source: 'other',
        });
        toast(root, 'AI 出力をメモとして保存しました', 'ok');
        setState({});
      } catch (e) {
        toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      }
    },
  });
}

// ─── Markdown rendering (chat bubble subset) ──────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface CodeBlock { lang: string; content: string }
function extractCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ lang: m[1] ?? '', content: (m[2] ?? '').trim() });
  }
  return out;
}

function renderBody(text: string): string {
  const parts: string[] = [];
  let last = 0;
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(renderInline(text.slice(last, m.index)));
    parts.push(`<pre class="spira-ai-codeblock"><code>${escapeHtml((m[2] ?? '').trim())}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(renderInline(text.slice(last)));
  return parts.join('');
}

function renderInline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .split(/\r?\n/).join('<br>');
}

// ─── Panel open/close state (persisted) ──────────────────────────────────

export function isAiPanelOpen(): boolean {
  try { return localStorage.getItem(aiPanelOpenKey) === '1'; }
  catch { return false; }
}
export function setAiPanelOpen(open: boolean): void {
  try { localStorage.setItem(aiPanelOpenKey, open ? '1' : '0'); }
  catch { /* ignore */ }
}
export function openAiPanel(): void { setAiPanelOpen(true); setState({}); }
export function closeAiPanel(): void { setAiPanelOpen(false); setState({}); }
export function toggleAiPanel(): void { setAiPanelOpen(!isAiPanelOpen()); setState({}); }

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}
