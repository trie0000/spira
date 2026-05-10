import { el, fmtDate, isOverdue, initials } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { getState, setFilter, setState } from '../state';
import type { Ticket, TicketStatus, Priority } from '../types';

export async function renderTicketList(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const tickets = await getRepo().listTickets();
  wrap.appendChild(renderToolbar());
  wrap.appendChild(renderTable(tickets));
  return wrap;
}

function renderToolbar(): HTMLElement {
  const s = getState();
  const users = s.users;

  const statusSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:120px' }, [
    el('option', { value: '' }, ['ステータス: すべて']),
    ...ticketStatusList().map(v => el('option', { value: v, selected: s.filter.status === v }, [v])),
  ]) as HTMLSelectElement;
  statusSel.addEventListener('change', () => setFilter({ status: statusSel.value }));

  const assigneeSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:140px' }, [
    el('option', { value: '' }, ['担当者: すべて']),
    el('option', { value: '__unset__', selected: s.filter.assignee === '__unset__' }, ['未割当']),
    ...users.map(u => el('option', { value: u.email, selected: s.filter.assignee === u.email }, [u.displayName])),
  ]) as HTMLSelectElement;
  assigneeSel.addEventListener('change', () => setFilter({ assignee: assigneeSel.value }));

  const prioSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:120px' }, [
    el('option', { value: '' }, ['重要度: すべて']),
    ...priorityList().map(v => el('option', { value: v, selected: s.filter.priority === v }, [v])),
  ]) as HTMLSelectElement;
  prioSel.addEventListener('change', () => setFilter({ priority: prioSel.value }));

  const sortSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:120px' }, [
    el('option', { value: 'updated', selected: s.sortBy === 'updated' }, ['更新日順']),
    el('option', { value: 'priority', selected: s.sortBy === 'priority' }, ['重要度順']),
    el('option', { value: 'due', selected: s.sortBy === 'due' }, ['期限順']),
  ]) as HTMLSelectElement;
  sortSel.addEventListener('change', () => setState({ sortBy: sortSel.value as 'updated' | 'priority' | 'due' }));

  const searchInput = el('input', {
    type: 'search',
    class: 'spira-input spira-search-input',
    placeholder: 'タイトル / ID で検索',
    value: s.filter.query,
    'data-focus-key': 'ticket-search',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => setFilter({ query: searchInput.value }));

  return el('div', { class: 'spira-toolbar' }, [
    statusSel, assigneeSel, prioSel, sortSel,
    el('div', { class: 'spira-toolbar-spacer' }),
    el('div', { class: 'spira-search-wrap' }, [el('span', { html: icon('search') }), searchInput]),
    el('button', {
      class: 'spira-iconbtn',
      'aria-label': '同期',
      title: '同期',
      'data-action': 'sync',
      html: icon('sync'),
    }),
  ]);
}

function renderTable(allTickets: Ticket[]): HTMLElement {
  const s = getState();
  let rows = allTickets;

  if (s.filter.status) rows = rows.filter(r => r.status === (s.filter.status as TicketStatus));
  if (s.filter.assignee === '__unset__') rows = rows.filter(r => !r.assigneeEmail);
  else if (s.filter.assignee) rows = rows.filter(r => r.assigneeEmail === s.filter.assignee);
  if (s.filter.priority) rows = rows.filter(r => r.priority === (s.filter.priority as Priority));
  if (s.filter.query) {
    const q = s.filter.query.toLowerCase();
    rows = rows.filter(r => r.title.toLowerCase().includes(q) || String(r.id).includes(q));
  }

  const prioOrder: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };
  rows = [...rows].sort((a, b) => {
    if (s.sortBy === 'priority') return prioOrder[a.priority] - prioOrder[b.priority];
    if (s.sortBy === 'due') {
      const da = a.dueDate ? Date.parse(a.dueDate) : Number.MAX_SAFE_INTEGER;
      const db = b.dueDate ? Date.parse(b.dueDate) : Number.MAX_SAFE_INTEGER;
      return da - db;
    }
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  if (rows.length === 0) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, [allTickets.length === 0 ? 'チケットはありません' : '該当するチケットがありません']),
        el('div', {}, ['受信メールから起票するか、右上の「新規チケット」から作成してください']),
      ]),
    ]);
  }

  const headers = ['#', 'Title', 'Status', '担当', '優先度', '期限', '更新'];
  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('table', { class: 'spira-tk-table', role: 'grid' }, [
      el('thead', {}, [el('tr', {}, headers.map(h => el('th', {}, [h])))]),
      el('tbody', {}, rows.map(t => renderRow(t))),
    ]),
  ]);
}

function renderRow(t: Ticket): HTMLElement {
  const overdue = t.dueDate ? isOverdue(t.dueDate) && t.status !== '完了' : false;
  const dueCell = el('td', { class: overdue ? 'spira-tk-due--overdue' : '' }, [t.dueDate ? fmtDate(t.dueDate, false) : '—']);

  return el('tr', {
    class: 'spira-tk-row',
    onclick: () => setState({ selectedTicketId: t.id }),
  }, [
    el('td', { class: 'spira-tk-id' }, [`#${String(t.id).padStart(3, '0')}`]),
    el('td', { class: 'spira-tk-title' }, [t.title]),
    el('td', {}, [renderStatusBadge(t.status)]),
    el('td', {}, [renderAssignee(t.assigneeName, t.assigneeEmail)]),
    el('td', {}, [renderPriorityDot(t.priority)]),
    dueCell,
    el('td', {}, [fmtDate(t.updatedAt)]),
  ]);
}

export function renderStatusBadge(status: TicketStatus): HTMLElement {
  const map: Record<TicketStatus, string> = {
    新規: 'spira-badge--fill',
    対応中: '',
    確認待ち: 'spira-badge--warn',
    完了: 'spira-badge--ok',
  };
  return el('span', { class: `spira-badge ${map[status]}`.trim() }, [status]);
}

export function renderPriorityDot(p: Priority): HTMLElement {
  const cls = p === 'High' ? 'spira-prio-dot--high' : p === 'Medium' ? 'spira-prio-dot--medium' : 'spira-prio-dot--low';
  return el('span', { class: `spira-prio-dot ${cls}`, title: p });
}

export function renderAssignee(name?: string, email?: string): HTMLElement {
  if (!email) return el('span', { class: 'spira-avatar spira-avatar--unset', title: '未割当' }, ['?']);
  return el('span', {
    class: 'spira-avatar',
    title: name ? `${name} <${email}>` : email,
  }, [initials(name ?? email)]);
}
