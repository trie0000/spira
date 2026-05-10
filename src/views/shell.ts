import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, subscribe } from '../state';
import { renderTicketList } from './ticketList';
import { renderTicketDetail } from './ticketDetail';
import { renderInbox } from './inbox';
import { renderTrash } from './trash';
import { confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo, getRepoMode } from '../api/repo';

export function renderShell(): HTMLElement {
  // id + class — ID セレクタで host CSS の !important / ID rules を上書きできる
  const root = el('div', { id: 'spira-root', class: 'spira-root', 'data-theme': 'light' });
  const main = el('main', { class: 'spira-main' });
  const sideWrap = el('div', { style: 'display:contents' });
  sideWrap.appendChild(renderSidebar());
  const topbar = renderTopbar(root);
  const errorSlot = el('div');

  const shell = el('div', { class: 'spira-shell' }, [
    topbar,
    errorSlot,
    el('div', { class: 'spira-body' }, [sideWrap, main]),
  ]);
  root.appendChild(shell);

  // initial paint + on state change
  paintMain(main);
  subscribe(() => {
    paintMain(main);
    clear(sideWrap);
    sideWrap.appendChild(renderSidebar());
    paintErrorBanner(errorSlot);
  });
  return root;
}

let paintToken = 0;

async function paintMain(main: HTMLElement): Promise<void> {
  const myToken = ++paintToken;
  const s = getState();

  // Capture focus state before re-render so inputs marked with `data-focus-key`
  // can restore focus & cursor position after DOM replacement.
  const focusInfo = captureFocus(main);

  // Show skeleton immediately
  clear(main);
  main.appendChild(renderSkeleton());

  // Wait until repo + counts are ready before fetching view data.
  if (!s.ready) return;

  try {
    let view: HTMLElement;
    if (s.view === 'tickets') {
      view = s.selectedTicketId != null
        ? await renderTicketDetail(s.selectedTicketId)
        : await renderTicketList();
    } else if (s.view === 'inbox') {
      view = await renderInbox();
    } else {
      view = await renderTrash();
    }
    if (myToken !== paintToken) return; // stale
    clear(main);
    main.appendChild(view);
    restoreFocus(main, focusInfo);
  } catch (e) {
    if (myToken !== paintToken) return;
    clear(main);
    main.appendChild(renderError(e as Error));
  }
}

interface FocusInfo {
  key: string;
  selStart: number | null;
  selEnd: number | null;
}

function captureFocus(main: HTMLElement): FocusInfo | null {
  const ae = document.activeElement as (HTMLInputElement | HTMLTextAreaElement | HTMLElement) | null;
  if (!ae || !main.contains(ae)) return null;
  const key = (ae as HTMLElement).getAttribute('data-focus-key');
  if (!key) return null;
  const isText = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
  return {
    key,
    selStart: isText ? ae.selectionStart : null,
    selEnd: isText ? ae.selectionEnd : null,
  };
}

function restoreFocus(main: HTMLElement, info: FocusInfo | null): void {
  if (!info) return;
  const next = main.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${info.key}"]`);
  if (!next) return;
  next.focus();
  if (info.selStart != null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(info.selStart, info.selEnd ?? info.selStart);
    } catch { /* unsupported on number/email — ignore */ }
  }
}

function renderSkeleton(): HTMLElement {
  return el('div', { class: 'spira-content', style: 'display:flex;flex-direction:column;gap:var(--s-3)' }, [
    el('div', { class: 'spira-skeleton', style: 'height:38px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
  ]);
}

function renderError(e: Error): HTMLElement {
  const fullText = errorToText(e);
  const msgEl = el('pre', {
    style: 'max-width:560px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:var(--paper-2);border:1px solid var(--paper-3);border-radius:var(--r-2);padding:var(--s-4);font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);user-select:text',
  }, [fullText]);

  const copyBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(fullText);
        copyBtn.textContent = '✓ コピーしました';
        setTimeout(() => { copyBtn.replaceChildren(...copyLabel()); }, 1500);
      } catch {
        // fallback: select + execCommand
        const range = document.createRange();
        range.selectNodeContents(msgEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand('copy');
        copyBtn.textContent = '✓ コピーしました';
        setTimeout(() => { copyBtn.replaceChildren(...copyLabel()); }, 1500);
      }
    },
  }, copyLabel());

  return el('div', { class: 'spira-content' }, [
    el('div', { class: 'spira-empty', style: 'gap:var(--s-5)' }, [
      el('div', { class: 'spira-empty-title', style: 'color:var(--danger)' }, ['データの取得に失敗しました']),
      msgEl,
      el('div', { style: 'display:flex;gap:var(--s-3)' }, [
        copyBtn,
        el('button', {
          class: 'spira-btn spira-btn--secondary spira-btn--sm',
          onclick: () => setState({}),
        }, ['再試行']),
      ]),
    ]),
  ]);
}

function copyLabel(): (HTMLElement | string)[] {
  return [
    el('span', { html: icon('copy'), style: 'display:inline-flex;width:14px;height:14px' }),
    'エラーをコピー',
  ];
}

function errorToText(e: Error): string {
  // Compose a richer text payload than just e.message for copy/paste debugging.
  // For SpError we already include status/url/body in message; fall back to stack otherwise.
  const lines = [e.message];
  if (e.stack && e.stack !== e.message) lines.push('', '--- stack ---', e.stack);
  lines.push('', `(time: ${new Date().toISOString()})`, `(ua: ${navigator.userAgent})`);
  return lines.join('\n');
}

function paintErrorBanner(slot: HTMLElement): void {
  clear(slot);
  const msg = getState().errorBanner;
  if (!msg) return;
  slot.appendChild(el('div', { class: 'spira-error-banner' }, [
    el('span', { html: icon('alert'), style: 'display:inline-flex;width:16px;height:16px' }),
    msg,
    el('div', { class: 'spira-error-banner-spacer' }),
    el('button', {
      class: 'spira-iconbtn',
      'aria-label': '閉じる',
      onclick: () => setState({ errorBanner: null }),
      html: icon('x'),
    }),
  ]));
}

function renderTopbar(root: HTMLElement): HTMLElement {
  const themeBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': 'テーマ切替',
    title: 'テーマ切替',
    onclick: () => {
      const cur = root.getAttribute('data-theme') ?? 'light';
      const next = cur === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('spira:theme', next); } catch { /* noop */ }
      themeBtn.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    },
    html: icon('moon'),
  });

  const syncBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '同期',
    title: '同期',
    'data-action': 'sync',
    html: icon('sync'),
  });

  const closeBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '閉じる',
    title: '閉じる',
    onclick: () => root.remove(),
    html: icon('x'),
  });

  const settingsBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '設定',
    title: '設定',
    html: icon('gear'),
  });
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsMenu(root, settingsBtn);
  });

  return el('header', { class: 'spira-topbar', role: 'banner' }, [
    el('div', { class: 'spira-topbar-brand' }, ['Spira']),
    el('div', { class: 'spira-topbar-spacer' }),
    el('div', { class: 'spira-topbar-actions' }, [
      syncBtn,
      themeBtn,
      settingsBtn,
      closeBtn,
    ]),
  ]);
}

function openSettingsMenu(root: HTMLElement, anchor: HTMLElement): void {
  const existing = document.querySelector('.spira-settings-menu');
  if (existing) { existing.remove(); return; }

  const resetItem = el('div', {
    class: 'spira-menu-item',
    style: 'color:var(--danger)',
    onclick: () => {
      menu.remove();
      onResetLists(root);
    },
  }, [
    el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' }),
    'SP リストをリセット',
  ]);

  const modeLabel = el('div', {
    class: 'spira-menu-item',
    style: 'cursor:default;color:var(--ink-3);font-size:var(--fs-xs);pointer-events:none',
  }, [`モード: ${getRepoMode()}`]);

  const menu = el('div', {
    class: 'spira-menu spira-settings-menu',
    style: 'position:fixed;z-index:var(--z-modal);min-width:220px',
  }, [
    modeLabel,
    el('div', { class: 'spira-menu-divider' }),
    resetItem,
  ]);

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  root.appendChild(menu);

  // close on outside click / Esc
  setTimeout(() => {
    const closer = (ev: Event) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closer);
        document.removeEventListener('keydown', keyCloser);
      }
    };
    const keyCloser = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('click', closer);
        document.removeEventListener('keydown', keyCloser);
      }
    };
    document.addEventListener('click', closer);
    document.addEventListener('keydown', keyCloser);
  }, 0);
}

function onResetLists(root: HTMLElement): void {
  const isMock = getRepoMode() === 'mock';
  const message = isMock
    ? 'mock データを初期化します。チケット / コメント / 受信メールがすべて消えてサンプルに戻ります。'
    : 'SP の Tickets / Comments / InboxMails リストを物理削除して再作成します。' +
      '\nこれら 3 リストの中身（チケット・コメント・受信メール）はすべて失われ、戻せません。' +
      '\n本当に実行しますか？';

  confirmModal(root, {
    title: 'SP リストをリセット',
    message,
    primaryLabel: 'リセット実行',
    primaryVariant: 'danger',
    onConfirm: async () => {
      try {
        const r = await getRepo().resetLists();
        const msg = isMock
          ? 'mock データをリセットしました'
          : `${r.deleted.length} リストを削除 → ${r.recreated.length} リストを再作成しました`;
        toast(root, msg, 'ok', 6000);
        // 再読み込みで完全なクリーン状態へ
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        toast(root, `リセット失敗: ${(e as Error).message}`, 'error');
      }
    },
  });
}

function renderSidebar(): HTMLElement {
  const s = getState();

  const item = (label: string, view: 'tickets' | 'inbox' | 'trash', iconName: string, count?: number) => {
    const isActive = s.view === view;
    const node = el('div', {
      class: `spira-side-item${isActive ? ' active' : ''}`,
      role: 'button',
      tabindex: '0',
      onclick: () => setState({ view, selectedTicketId: null }),
    }, [
      el('span', { class: 'spira-side-icon', html: icon(iconName), style: 'display:inline-flex;width:18px;height:18px;color:var(--ink-3)' }),
      label,
    ]);
    if (count != null && count > 0) {
      node.appendChild(el('span', { class: 'spira-side-count' }, [String(count)]));
    }
    return node;
  };

  return el('aside', { class: 'spira-side', 'aria-label': 'サイドバー' }, [
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['Tickets']),
      item('チケット一覧', 'tickets', 'list'),
      item('受信メール', 'inbox', 'inbox', s.inboxCount),
    ]),
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['その他']),
      item('ゴミ箱', 'trash', 'trash', s.trashCount),
    ]),
    el('div', { class: 'spira-side-bottom' }, [
      el('button', {
        class: 'spira-btn spira-btn--primary',
        style: 'width:100%',
        'data-action': 'new-ticket',
      }, [
        el('span', { html: icon('plus'), style: 'display:inline-flex;width:14px;height:14px' }),
        '新規チケット',
      ]),
    ]),
  ]);
}
