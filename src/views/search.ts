// Cross-ticket search — Notion-style modal.
//
// Opened from the sidebar "検索" item or via Cmd+K. Lets the user run
// a free-text query across tickets and comments. Results are grouped
// by ticket (accordion-style): each matched ticket shows a header, a
// count of matched comments, and an expandable list of matched
// comment snippets with highlighted query terms.
//
// Clicking a result closes the modal and navigates to the ticket
// detail, scrolling to the specific comment (via the
// `requestScrollToComment` API in ticketDetail.ts).

import { el, fmtDate, clear } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { setState } from '../state';
import { renderStatusBadge, renderPriorityLabel } from './ticketList';
import { formatTicketIdShort } from '../utils/ticketTag';
import { makeSnippet, normalizeForSearch } from '../utils/search';
import { requestScrollToComment } from './ticketDetail';
import type { Ticket, Comment } from '../types';

const QUERY_STORAGE_KEY = 'spira:search-last-query';
const DEBOUNCE_MS = 300;

let activeBackdrop: HTMLElement | null = null;

/** Open the cross-ticket search modal. Idempotent: if already open,
 *  just refocuses the input. */
export function openSearchModal(): void {
  if (activeBackdrop) {
    activeBackdrop.querySelector<HTMLInputElement>('.spira-search-modal-input')?.focus();
    return;
  }

  // ── Input + header
  const initialQuery = (() => {
    try { return localStorage.getItem(QUERY_STORAGE_KEY) ?? ''; } catch { return ''; }
  })();
  const input = el('input', {
    // type=search にすると Chrome/Edge が独自の × クリアボタンを描画する
    // ため、モーダルの閉じる × と二重になり見苦しい。type=text に変えて
    // 抑止。検索動作自体には影響なし。
    type: 'text',
    class: 'spira-search-modal-input',
    placeholder: 'タイトル・本文・コメント・送信者で検索...',
    value: initialQuery,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  const summary = el('div', { class: 'spira-search-modal-summary' }, []);

  const closeBtn = el('button', {
    type: 'button',
    class: 'spira-iconbtn spira-search-modal-close',
    'aria-label': '閉じる',
    html: icon('x'),
  });

  const head = el('div', { class: 'spira-search-modal-head' }, [
    el('span', { class: 'spira-search-modal-icon', html: icon('search') }),
    input,
    closeBtn,
  ]);

  // ── Results body
  const resultsHost = el('div', { class: 'spira-search-modal-body' });

  // ── Footer (summary text)
  const foot = el('div', { class: 'spira-search-modal-foot' }, [summary]);

  // ── Modal frame
  const modal = el('div', { class: 'spira-modal spira-search-modal', role: 'dialog', 'aria-modal': 'true' }, [
    head,
    resultsHost,
    foot,
  ]);

  const backdrop = el('div', { class: 'spira-modal-backdrop spira-search-modal-backdrop' }, [modal]);

  // ── Behaviour
  const close = (): void => {
    backdrop.remove();
    activeBackdrop = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // ── Mount
  const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;
  root.appendChild(backdrop);
  activeBackdrop = backdrop;

  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  // ── Search runner
  let debounceTimer: number | null = null;
  let lastQuery = '';
  let inflightToken = 0;

  const runSearch = async (q: string): Promise<void> => {
    const trimmed = q.trim();
    try { localStorage.setItem(QUERY_STORAGE_KEY, trimmed); } catch { /* ignore */ }

    if (trimmed === lastQuery) return;
    lastQuery = trimmed;

    if (!trimmed) {
      summary.textContent = '';
      clear(resultsHost);
      resultsHost.appendChild(hintBlock('検索ワードを入力してください', 'タイトル・本文・コメント (内部メモ含む) から一致するチケットを探します。'));
      return;
    }

    summary.textContent = '検索中...';
    clear(resultsHost);

    const myToken = ++inflightToken;
    try {
      const { tickets, commentsByTicket } = await getRepo().searchAll(trimmed);
      if (myToken !== inflightToken) return;

      const ticketCount = tickets.length;
      const commentCount = Array.from(commentsByTicket.values()).reduce((s, arr) => s + arr.length, 0);
      summary.textContent = ticketCount === 0
        ? '0 件'
        : `${ticketCount} チケット / ${commentCount} カード`;

      clear(resultsHost);
      if (ticketCount === 0) {
        resultsHost.appendChild(hintBlock(
          '結果なし',
          '別のキーワードで試してください。\n\n※ 内部メモは自動保存 (~1 秒) のあとに検索対象になります。直前に入力したメモがヒットしない場合は少し待ってから再検索してください。',
        ));
        return;
      }
      resultsHost.appendChild(renderResultsList(tickets, commentsByTicket, trimmed, close));
    } catch (e) {
      if (myToken !== inflightToken) return;
      summary.textContent = '';
      clear(resultsHost);
      resultsHost.appendChild(el('div', {
        class: 'spira-empty',
        style: 'padding:var(--s-7);color:var(--danger);background:var(--danger-soft);border-radius:var(--r-2)',
      }, [`検索エラー: ${(e as Error).message}`]));
    }
  };

  input.addEventListener('input', () => {
    if (debounceTimer != null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void runSearch(input.value);
    }, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (debounceTimer != null) { window.clearTimeout(debounceTimer); debounceTimer = null; }
      void runSearch(input.value);
    }
  });

  // Run with the restored query (if any), otherwise show the hint.
  if (initialQuery) {
    void runSearch(initialQuery);
  } else {
    resultsHost.appendChild(hintBlock('検索ワードを入力してください', 'タイトル・本文・コメント (内部メモ含む) から一致するチケットを探します。'));
  }
}

// ─── results rendering ───────────────────────────────────────────────

function renderResultsList(
  tickets: Ticket[],
  commentsByTicket: Map<number, Comment[]>,
  query: string,
  closeModal: () => void,
): HTMLElement {
  const sorted = [...tickets].sort((a, b) => {
    const aCount = commentsByTicket.get(a.id)?.length ?? 0;
    const bCount = commentsByTicket.get(b.id)?.length ?? 0;
    if (aCount !== bCount) return bCount - aCount;
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });

  return el('div', { class: 'spira-search-results' },
    sorted.map(t => renderTicketGroup(t, commentsByTicket.get(t.id) ?? [], query, closeModal)),
  );
}

function renderTicketGroup(
  t: Ticket,
  matches: Comment[],
  query: string,
  closeModal: () => void,
): HTMLElement {
  let isOpen = matches.length > 0;

  const titleMatched = isHit(t.title, query);
  const descMatched = isHit(t.description ?? '', query);
  const reporterMatched = isHit((t.reporterName ?? '') + ' ' + (t.reporterEmail ?? ''), query);

  const chevron = el('span', {
    class: 'spira-search-chevron',
    html: icon('chevronDown'),
  });

  const head = el('button', {
    type: 'button',
    class: 'spira-search-group-head',
    onclick: () => toggle(),
  }, [
    chevron,
    el('span', { style: 'font-family:ui-monospace,monospace;color:var(--ink-3);flex-shrink:0' }, [formatTicketIdShort(t.id)]),
    el('span', { style: 'flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
      [renderTitleWithHighlight(t.title, query)]),
    renderStatusBadge(t.status),
    renderPriorityLabel(t.priority),
    ...(titleMatched ? [el('span', { class: 'spira-badge spira-badge--muted', title: 'タイトルがマッチ' }, ['📋'])] : []),
    ...(descMatched ? [el('span', { class: 'spira-badge spira-badge--muted', title: '説明がマッチ' }, ['📝'])] : []),
    ...(reporterMatched ? [el('span', { class: 'spira-badge spira-badge--muted', title: '起票元がマッチ' }, ['👤'])] : []),
    matches.length > 0
      ? el('span', { class: 'spira-badge spira-badge--fill', title: 'マッチしたカード数' }, [`💬 ${matches.length}`])
      : '',
  ]);

  const body = el('div', { class: 'spira-search-group-body', style: 'display:none' });

  let bodyRendered = false;
  const ensureBody = (): void => {
    if (bodyRendered) return;
    bodyRendered = true;
    body.appendChild(el('div', { class: 'spira-search-group-meta' }, [
      `起票: ${fmtDate(t.createdAt)}`, ' · ',
      `担当: ${(t.assigneeNames && t.assigneeNames.length > 0) ? t.assigneeNames.join(' / ') : '未割当'}`, ' · ',
      `起票元: ${t.reporterName ?? '—'}`,
    ]));
    if (descMatched && t.description) {
      body.appendChild(el('div', { class: 'spira-search-match' }, [
        el('span', { class: 'spira-badge spira-badge--muted', style: 'margin-right:var(--s-2)' }, ['説明']),
        el('span', { html: makeSnippet(t.description, query, 80) }),
      ]));
    }
    body.appendChild(el('div', { style: 'margin-bottom:var(--s-3)' }, [
      el('button', {
        type: 'button',
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: (e: Event) => { e.stopPropagation(); openTicket(t.id, undefined, closeModal); },
      }, ['チケットを開く →']),
    ]));
    if (matches.length > 0) {
      body.appendChild(el('div', { class: 'spira-search-group-matchhdr' }, [`マッチしたカード ${matches.length} 件`]));
      const list = el('div', { class: 'spira-search-card-list' },
        matches.map(c => renderMatchCard(c, t.id, query, closeModal)),
      );
      body.appendChild(list);
    }
  };

  const toggle = (): void => {
    isOpen = !isOpen;
    if (isOpen) {
      ensureBody();
      body.style.display = 'block';
      chevron.classList.add('open');
    } else {
      body.style.display = 'none';
      chevron.classList.remove('open');
    }
  };

  if (isOpen) {
    ensureBody();
    body.style.display = 'block';
    chevron.classList.add('open');
  }

  return el('div', { class: 'spira-search-group' }, [head, body]);
}

function renderTitleWithHighlight(title: string, query: string): HTMLElement {
  return el('span', { html: makeSnippet(title, query, 200) || escapeHtml(title) });
}

function renderMatchCard(c: Comment, ticketId: number, query: string, closeModal: () => void): HTMLElement {
  const isNote = c.type === 'note';
  const iconName = isNote ? 'note'
    : c.source === 'teams' ? 'chat'
    : c.source === 'forms' ? 'inbox'
    : c.source === 'other' ? 'bookmark'
    : 'mail';
  const sourceLabel = isNote ? '内部メモ'
    : c.source === 'teams' ? 'Teams'
    : c.source === 'forms' ? 'Forms'
    : c.source === 'other' ? 'その他'
    : 'メール';
  // ソース別の色クラス (左ボーダー色を変えて視覚的に区別)
  const sourceClass = isNote ? 'spira-search-card--note'
    : c.source === 'teams' ? 'spira-search-card--teams'
    : c.source === 'forms' ? 'spira-search-card--forms'
    : c.source === 'other' ? 'spira-search-card--other'
    : 'spira-search-card--mail';

  return el('div', {
    class: `spira-search-card ${sourceClass}`,
    onclick: () => openTicket(ticketId, c.id, closeModal),
  }, [
    el('div', { class: 'spira-search-card-head' }, [
      el('span', { html: icon(iconName), class: 'spira-search-card-icon' }),
      el('span', { class: 'spira-search-card-src' }, [sourceLabel]),
      el('span', { class: 'spira-search-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
      el('span', { class: 'spira-search-card-time' }, [fmtDate(c.sentAt)]),
    ]),
    el('div', { class: 'spira-search-snippet', html: makeSnippet(c.content, query, 100) }),
  ]);
}

function openTicket(id: number, commentId: number | undefined, closeModal: () => void): void {
  if (commentId != null) requestScrollToComment(commentId);
  setState({ view: 'tickets', selectedTicketId: id });
  closeModal();
}

// ─── helpers ─────────────────────────────────────────────────────────

function isHit(text: string, query: string): boolean {
  return normalizeForSearch(text).includes(normalizeForSearch(query));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hintBlock(title: string, hint: string): HTMLElement {
  return el('div', { class: 'spira-empty spira-search-empty' }, [
    el('div', { class: 'spira-search-empty-title' }, [title]),
    el('div', { class: 'spira-search-empty-hint' }, [hint]),
  ]);
}
