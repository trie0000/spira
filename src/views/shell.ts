import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, subscribe } from '../state';
import { renderTicketList } from './ticketList';
import { renderTicketDetail } from './ticketDetail';
import { renderInbox } from './inbox';
import { renderTrash } from './trash';

export function renderShell(): HTMLElement {
  const root = el('div', { class: 'spira-root', 'data-theme': 'light' });
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

  // Show skeleton immediately
  clear(main);
  main.appendChild(renderSkeleton());

  // Wait until repo + counts are ready before fetching view data.
  // Without this gate, the initial paint fires before initRepo() finishes.
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
  } catch (e) {
    if (myToken !== paintToken) return;
    clear(main);
    main.appendChild(renderError(e as Error));
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
  return el('div', { class: 'spira-content' }, [
    el('div', { class: 'spira-empty' }, [
      el('div', { class: 'spira-empty-title', style: 'color:var(--danger)' }, ['データの取得に失敗しました']),
      el('div', { style: 'max-width:480px;word-break:break-word' }, [e.message]),
      el('button', {
        class: 'spira-btn spira-btn--secondary',
        onclick: () => setState({}),
      }, ['再試行']),
    ]),
  ]);
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

  return el('header', { class: 'spira-topbar', role: 'banner' }, [
    el('div', { class: 'spira-topbar-brand' }, ['Spira']),
    el('div', { class: 'spira-topbar-spacer' }),
    el('div', { class: 'spira-topbar-actions' }, [
      syncBtn,
      themeBtn,
      el('button', {
        class: 'spira-iconbtn',
        'aria-label': '設定',
        title: '設定 (準備中)',
        html: icon('gear'),
      }),
      closeBtn,
    ]),
  ]);
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
