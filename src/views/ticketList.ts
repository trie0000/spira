import { el, fmtDate, isOverdue, initials, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { getState, setFilter, setState } from '../state';
import { confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import type { Ticket, TicketStatus, Priority } from '../types';

// multi-select state — module-level, persists across re-renders.
const selectedIds = new Set<number>();
function root(): HTMLElement { return document.querySelector<HTMLElement>('#spira-root') ?? document.body; }

export async function renderTicketList(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const tickets = await getRepo().listTickets();
  // prune selection of deleted IDs
  for (const id of Array.from(selectedIds)) if (!tickets.find(t => t.id === id)) selectedIds.delete(id);
  wrap.appendChild(renderToolbar());
  if (selectedIds.size > 0) wrap.appendChild(renderBulkBar(tickets));
  wrap.appendChild(renderTable(tickets));
  return wrap;
}

function renderBulkBar(allTickets: Ticket[]): HTMLElement {
  const count = selectedIds.size;
  return el('div', { class: 'spira-bulkbar' }, [
    el('span', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, [`${count} 件選択中`]),
    el('div', { style: 'flex:1' }),
    el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: () => { selectedIds.clear(); setState({}); },
    }, ['選択解除']),
    el('button', {
      class: 'spira-btn spira-btn--danger spira-btn--sm',
      onclick: () => {
        const ids = Array.from(selectedIds);
        confirmModal(root(), {
          title: 'まとめて削除',
          message: `${count} 件のチケットをゴミ箱に移動します。`,
          primaryLabel: '削除',
          primaryVariant: 'danger',
          onConfirm: async () => {
            try {
              for (const id of ids) await getRepo().softDeleteTicket(id);
              toast(root(), `${ids.length} 件をゴミ箱に移動しました`, 'ok');
              selectedIds.clear();
              setState({ trashCount: getState().trashCount + ids.length });
            } catch (e) {
              toast(root(), `削除失敗: ${(e as Error).message}`, 'error');
            }
          },
        });
        // suppress unused
        void allTickets;
      },
    }, [`${count} 件を削除`]),
  ]);
}

function renderToolbar(): HTMLElement {
  const s = getState();

  const filterBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: (e: Event) => {
      e.stopPropagation();
      openFilterPopover(filterBtn);
    },
  }, [
    el('span', { html: icon('filter'), style: 'display:inline-flex;width:14px;height:14px' }),
    `フィルター${activeFilterCount() > 0 ? ` (${activeFilterCount()})` : ''}`,
  ]);

  const searchInput = el('input', {
    type: 'search',
    class: 'spira-input spira-search-input',
    placeholder: 'タイトル / ID で検索',
    value: s.filter.query,
    'data-focus-key': 'ticket-search',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => setFilter({ query: searchInput.value }));

  const toolbar = el('div', { class: 'spira-toolbar' }, [
    filterBtn,
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

  return el('div', {}, [toolbar, renderFilterChips()]);
}

function activeFilterCount(): number {
  const f = getState().filter;
  return [f.status, f.assignee, f.priority].filter(Boolean).length;
}

function renderFilterChips(): HTMLElement {
  const s = getState();
  const f = s.filter;
  const chips: HTMLElement[] = [];

  function chip(label: string, key: keyof typeof f) {
    chips.push(el('span', {
      class: 'spira-filter-chip',
      title: 'クリック で外す',
      onclick: () => setFilter({ [key]: '' } as never),
    }, [label, el('span', { style: 'margin-left:4px;color:var(--ink-3)' }, ['×'])]));
  }
  if (f.status) chip(`ステータス: ${f.status}`, 'status');
  if (f.assignee) {
    const u = s.users.find(x => x.email === f.assignee);
    chip(`担当者: ${f.assignee === '__unset__' ? '未割当' : (u?.displayName ?? f.assignee)}`, 'assignee');
  }
  if (f.priority) chip(`重要度: ${f.priority}`, 'priority');

  if (chips.length === 0) return el('div', { style: 'display:none' });

  chips.push(el('button', {
    class: 'spira-filter-chip-clear',
    onclick: () => setFilter({ status: '', assignee: '', priority: '' }),
  }, ['すべてクリア']));

  return el('div', { class: 'spira-filter-chipstrip' }, chips);
}

function openFilterPopover(anchor: HTMLElement): void {
  document.querySelectorAll('.spira-filter-pop').forEach(n => n.remove());

  const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;
  const f = { ...getState().filter };
  const users = getState().users;

  // Field rows. Each row: [field][operator (always 'は')][value].
  type FieldKey = 'status' | 'assignee' | 'priority';
  const FIELDS: { key: FieldKey; label: string; values: { v: string; label: string }[] }[] = [
    { key: 'status',   label: 'ステータス', values: ticketStatusList().map(v => ({ v, label: v })) },
    { key: 'assignee', label: '担当者',     values: [
        { v: '__unset__', label: '(未割当)' },
        ...users.map(u => ({ v: u.email, label: u.displayName })),
    ] },
    { key: 'priority', label: '重要度',     values: priorityList().map(v => ({ v, label: v })) },
  ];

  const rowsWrap = el('div', { class: 'spira-fpop-body' });

  function paintRows() {
    clear(rowsWrap);
    const present = (['status', 'assignee', 'priority'] as FieldKey[])
      .filter(k => (f as Record<string, string>)[k])
      .map(k => [k, (f as Record<string, string>)[k]!] as [FieldKey, string]);
    if (present.length === 0) {
      rowsWrap.appendChild(el('div', { class: 'spira-fpop-empty' }, ['条件はまだありません']));
    } else {
      for (const [key, val] of present) {
        const fieldDef = FIELDS.find(F => F.key === key);
        if (!fieldDef) continue;

        const valSel = el('select', { class: 'spira-fpop-val' }, [
          ...fieldDef.values.map(o => el('option', { value: o.v, selected: o.v === val }, [o.label])),
        ]) as HTMLSelectElement;
        valSel.addEventListener('change', () => { (f as Record<string, string>)[key] = valSel.value; });

        const removeBtn = el('button', {
          class: 'spira-fpop-rm',
          title: 'この条件を削除',
          onclick: () => { (f as Record<string, string>)[key] = ''; paintRows(); },
        }, ['×']);

        rowsWrap.appendChild(el('div', { class: 'spira-fpop-row' }, [
          el('span', { class: 'spira-fpop-field' }, [fieldDef.label]),
          el('span', { class: 'spira-fpop-op' }, ['は']),
          valSel,
          removeBtn,
        ]));
      }
    }
  }
  paintRows();

  // Add-row select: pick any field that doesn't already have a value.
  const addSel = el('select', { class: 'spira-select', style: 'flex:1' }, [
    el('option', { value: '' }, ['＋ 条件を追加']),
    ...FIELDS.filter(F => !(f as Record<string, string>)[F.key]).map(F => el('option', { value: F.key }, [F.label])),
  ]) as HTMLSelectElement;
  addSel.addEventListener('change', () => {
    const key = addSel.value as FieldKey;
    if (!key) return;
    const def = FIELDS.find(F => F.key === key);
    if (def) (f as Record<string, string>)[key] = def.values[0]?.v ?? '';
    addSel.value = '';
    paintRows();
  });

  const apply = el('button', {
    class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => {
      setFilter(f);
      pop.remove();
    },
  }, ['適用']);

  const clearAll = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    onclick: () => {
      Object.keys(f).forEach(k => { if (k !== 'query') (f as Record<string, string>)[k] = ''; });
      paintRows();
    },
  }, ['クリア']);

  const pop = el('div', { class: 'spira-filter-pop' }, [
    el('div', { class: 'spira-fpop-hd' }, [
      el('span', {}, ['フィルター']),
      el('button', {
        class: 'spira-fpop-close',
        onclick: () => pop.remove(),
      }, ['×']),
    ]),
    rowsWrap,
    el('div', { class: 'spira-fpop-add' }, [addSel]),
    el('div', { class: 'spira-fpop-ft' }, [
      clearAll,
      el('div', { style: 'flex:1' }),
      apply,
    ]),
  ]);

  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.left = `${rect.left}px`;
  // numeric literal — `style.zIndex = 'var(...)'` is rejected by CSSOM
  pop.style.zIndex = '2147483700';
  pop.style.width = '420px';
  root.appendChild(pop);

  setTimeout(() => {
    const closer = (e: Event) => {
      if (pop.contains(e.target as Node)) return;
      pop.remove();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
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
  const statusOrder: Record<TicketStatus, number> = { '新規': 0, '対応中': 1, '確認待ち': 2, '完了': 3 };
  const dir = s.sortDir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let cmp = 0;
    switch (s.sortBy) {
      case 'id':       cmp = a.id - b.id; break;
      case 'title':    cmp = a.title.localeCompare(b.title, 'ja'); break;
      case 'status':   cmp = statusOrder[a.status] - statusOrder[b.status]; break;
      case 'assignee': cmp = (a.assigneeName ?? a.assigneeEmail ?? '').localeCompare(b.assigneeName ?? b.assigneeEmail ?? '', 'ja'); break;
      case 'priority': cmp = prioOrder[a.priority] - prioOrder[b.priority]; break;
      case 'due': {
        const da = a.dueDate ? Date.parse(a.dueDate) : Number.MAX_SAFE_INTEGER;
        const db = b.dueDate ? Date.parse(b.dueDate) : Number.MAX_SAFE_INTEGER;
        cmp = da - db;
        break;
      }
      case 'updated':
      default:
        cmp = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    }
    return cmp * dir;
  });

  if (rows.length === 0) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, [allTickets.length === 0 ? 'チケットはありません' : '該当するチケットがありません']),
        el('div', {}, ['受信メールから起票するか、右上の「新規チケット」から作成してください']),
      ]),
    ]);
  }

  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('table', { class: 'spira-tk-table', role: 'grid' }, [
      el('thead', {}, [renderHeaderRow(rows)]),
      el('tbody', {}, rows.map(t => renderRow(t))),
    ]),
  ]);
}

interface HeaderSpec {
  label: string;
  sortKey?: 'id' | 'title' | 'status' | 'assignee' | 'priority' | 'due' | 'updated';
}

function renderHeaderRow(visibleRows: Ticket[]): HTMLElement {
  const cols: HeaderSpec[] = [
    { label: '#',       sortKey: 'id' },
    { label: 'Title',   sortKey: 'title' },
    { label: 'Status',  sortKey: 'status' },
    { label: '担当',    sortKey: 'assignee' },
    { label: '優先度',  sortKey: 'priority' },
    { label: '期限',    sortKey: 'due' },
    { label: '更新',    sortKey: 'updated' },
  ];
  const s = getState();
  const allChecked = visibleRows.length > 0 && visibleRows.every(t => selectedIds.has(t.id));
  const someChecked = !allChecked && visibleRows.some(t => selectedIds.has(t.id));

  const selectAll = el('input', {
    type: 'checkbox',
    'aria-label': 'すべて選択',
    onclick: (e: Event) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) for (const t of visibleRows) selectedIds.add(t.id);
      else for (const t of visibleRows) selectedIds.delete(t.id);
      setState({});
    },
  }) as HTMLInputElement;
  selectAll.checked = allChecked;
  if (someChecked) selectAll.indeterminate = true;

  const headerCells: HTMLElement[] = [
    el('th', { class: 'spira-tk-checkbox-cell', style: 'width:34px' }, [selectAll]),
    ...cols.map(c => {
      if (!c.sortKey) return el('th', {}, [c.label]);
      const isActive = s.sortBy === c.sortKey;
      const arrow = !isActive ? '' : (s.sortDir === 'asc' ? ' ▲' : ' ▼');
      return el('th', {
        class: 'spira-th-sort' + (isActive ? ' active' : ''),
        style: 'cursor:pointer;user-select:none',
        onclick: () => {
          if (s.sortBy === c.sortKey) {
            setState({ sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' });
          } else {
            setState({ sortBy: c.sortKey as typeof s.sortBy, sortDir: c.sortKey === 'title' ? 'asc' : 'desc' });
          }
        },
      }, [c.label + arrow]);
    }),
  ];
  return el('tr', {}, headerCells);
}

function renderRow(t: Ticket): HTMLElement {
  const overdue = t.dueDate ? isOverdue(t.dueDate) && t.status !== '完了' : false;
  const dueCell = el('td', { class: overdue ? 'spira-tk-due--overdue' : '' }, [t.dueDate ? fmtDate(t.dueDate, false) : '—']);

  const checkbox = el('input', {
    type: 'checkbox',
    'aria-label': '選択',
  }) as HTMLInputElement;
  checkbox.checked = selectedIds.has(t.id);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (checkbox.checked) selectedIds.add(t.id);
    else selectedIds.delete(t.id);
    setState({});
  });

  return el('tr', {
    class: 'spira-tk-row' + (selectedIds.has(t.id) ? ' selected' : ''),
    onclick: (e: Event) => {
      // ignore clicks originating from the checkbox cell
      const target = e.target as HTMLElement;
      if (target.closest('.spira-tk-checkbox-cell')) return;
      const open = getState().openTicketIds;
      const next = open.includes(t.id) ? open : [...open, t.id];
      setState({ selectedTicketId: t.id, openTicketIds: next });
    },
  }, [
    el('td', { class: 'spira-tk-checkbox-cell', onclick: (e: Event) => e.stopPropagation() }, [checkbox]),
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
  return renderPriorityLabel(p);
}

export function renderPriorityLabel(p: Priority): HTMLElement {
  const cls = p === 'High' ? 'spira-prio--high' : p === 'Medium' ? 'spira-prio--medium' : 'spira-prio--low';
  return el('span', { class: `spira-prio ${cls}`, title: `Priority: ${p}` }, [p]);
}

export function renderAssignee(name?: string, email?: string): HTMLElement {
  if (!email) return el('span', { class: 'spira-avatar spira-avatar--unset', title: '未割当' }, ['?']);
  return el('span', {
    class: 'spira-avatar',
    title: name ? `${name} <${email}>` : email,
  }, [initials(name ?? email)]);
}
