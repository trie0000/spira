import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, subscribe } from '../state';
import { listInboxMock, listDeletedTicketsMock } from '../api/mock';
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

  const shell = el('div', { class: 'spira-shell' }, [
    topbar,
    el('div', { class: 'spira-body' }, [sideWrap, main]),
  ]);
  root.appendChild(shell);

  // initial paint
  paintMain(main);
  subscribe(() => {
    paintMain(main);
    clear(sideWrap);
    sideWrap.appendChild(renderSidebar());
  });
  return root;
}

function paintMain(main: HTMLElement): void {
  const s = getState();
  clear(main);
  if (s.view === 'tickets') {
    if (s.selectedTicketId != null) main.appendChild(renderTicketDetail(s.selectedTicketId));
    else main.appendChild(renderTicketList());
  } else if (s.view === 'inbox') {
    main.appendChild(renderInbox());
  } else if (s.view === 'trash') {
    main.appendChild(renderTrash());
  }
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
  const inboxCount = listInboxMock({ unprocessedOnly: true }).length;
  const trashCount = listDeletedTicketsMock().length;

  const item = (label: string, view: 'tickets' | 'inbox' | 'trash', iconName: string, count?: number) => {
    const isActive = getState().view === view;
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
      item('受信メール', 'inbox', 'inbox', inboxCount),
    ]),
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['その他']),
      item('ゴミ箱', 'trash', 'trash', trashCount),
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
