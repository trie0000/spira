import { el, fmtDate, isOverdue, initials, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { getState, setFilter, setState } from '../state';
import { confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { attachColumnResize, savedColWidth } from '../utils/colResize';
import { formatTicketIdShort } from '../utils/ticketTag';
import { isInternalAuthor } from '../utils/members';
import { getLastSeen, hasNewSince } from '../utils/seenState';
import type { Ticket, TicketStatus, Priority, Comment } from '../types';

// multi-select state — module-level, persists across re-renders.
const selectedIds = new Set<number>();
function root(): HTMLElement { return document.querySelector<HTMLElement>('#spira-root') ?? document.body; }

/** Per-ticket derived metadata used by the list view's "進捗系" columns.
 *  Computed from `listComments(ticketId)`. Kept on the TicketMeta map
 *  rather than the Ticket itself so the API contract stays untouched. */
interface TicketMeta {
  /** Whole days from the ticket's createdAt until now. */
  elapsedDays: number | null;
  /** Whole days since the most recent received mail. null if no received
   *  mail yet (e.g. ticket created manually). */
  stagnantDays: number | null;
  /** Direction of the LAST message in the mail thread:
   *    'internal' — last sender is an internal member
   *    'external' — last sender is external (= waiting on us… or the
   *                 customer responded last; caller decides meaning)
   *    null      — no received mail yet */
  lastReplyDirection: 'internal' | 'external' | null;
  /** True when at least one comment is newer than the current user's
   *  last visit to this ticket — drives the row-level NEW indicator. */
  hasNew: boolean;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function deriveTicketMeta(comments: Comment[], ticket: Ticket): TicketMeta {
  const received = comments
    .filter(c => c.type === 'received')
    .sort((a, b) => new Date(a.sentAt ?? '').getTime() - new Date(b.sentAt ?? '').getTime());
  const last = received[received.length - 1];
  const lastSeen = getLastSeen(ticket.id);
  return {
    elapsedDays: daysSince(ticket.createdAt),
    stagnantDays: last ? daysSince(last.sentAt ?? null) : null,
    lastReplyDirection: last
      ? (isInternalAuthor(last, getState().users) ? 'internal' : 'external')
      : null,
    hasNew: hasNewSince(comments, lastSeen),
  };
}

export async function renderTicketList(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const repo = getRepo();
  const tickets = await repo.listTickets();
  for (const id of Array.from(selectedIds)) if (!tickets.find(t => t.id === id)) selectedIds.delete(id);

  // Fetch comments for every ticket in parallel — needed to compute the
  // 経過日 / 最終返信者 / 滞留日 columns. N+1 is acceptable for the typical
  // list size (≤ 50). If this gets slow we can either cache per-render
  // or push the metadata into the Ticket repo (PA could maintain it).
  const metaArr = await Promise.all(tickets.map(async (t) => {
    try {
      const cs = await repo.listComments(t.id);
      return [t.id, deriveTicketMeta(cs, t)] as const;
    } catch {
      return [t.id, { elapsedDays: daysSince(t.createdAt), stagnantDays: null, lastReplyDirection: null, hasNew: false }] as const;
    }
  }));
  const metaMap = new Map<number, TicketMeta>(metaArr);

  const filtered = applyFilters(tickets);
  const sorted = applySort(filtered);

  // ルール: タイトル(subbar) → コントロール(toolbar) → 本体 の順
  // sorted を渡しているのは CSV エクスポートで「表示中の (フィルタ済) 全件」
  // を対象にするため。
  wrap.appendChild(renderSubBar(sorted.length, sorted));
  wrap.appendChild(renderToolbar());
  wrap.appendChild(renderTable(sorted, metaMap));
  return wrap;
}

function renderSubBar(visibleCount: number, visibleTickets: Ticket[]): HTMLElement {
  const selCount = selectedIds.size;
  const right: (HTMLElement | string)[] = [];

  // CSV エクスポート (常時表示) — フィルタ後の visibleTickets を全件 DL
  // 選択あり → 選択分のみ / なし → 全件
  const csvBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    title: selCount > 0
      ? `選択中 ${selCount} 件を CSV ダウンロード`
      : `表示中の ${visibleCount} 件を CSV ダウンロード`,
    onclick: () => {
      const target = selCount > 0
        ? visibleTickets.filter(t => selectedIds.has(t.id))
        : visibleTickets;
      exportTicketsCsv(target);
    },
  }, [
    el('span', { html: icon('external'), style: 'display:inline-flex;width:14px;height:14px' }),
    selCount > 0 ? `選択分 CSV (${selCount})` : `CSV (${visibleCount})`,
  ]);

  if (selCount > 0) {
    // 選択中のバルク操作ボタン群
    const statusBtn = el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineSelectMenu<TicketStatus>(statusBtn, ticketStatusList(), undefined, async (next) => {
          await onBulkUpdate({ status: next }, `ステータスを「${next}」に変更`);
        });
      },
    }, ['ステータス ▾']);

    const prioBtn = el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineSelectMenu<Priority>(prioBtn, priorityList(), undefined, async (next) => {
          await onBulkUpdate({ priority: next }, `優先度を「${next}」に変更`);
        });
      },
    }, ['優先度 ▾']);

    const assigneeBtn = el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineAssigneeMenu(assigneeBtn, [], async (emails, names) => {
          await onBulkUpdate(
            { assigneeEmails: emails, assigneeNames: names },
            emails.length > 0 ? `担当者を ${names.join(', ')} に変更` : '担当者をクリア',
          );
        });
      },
    }, ['担当者 ▾']);

    right.push(
      el('span', { style: 'font-size:var(--fs-sm);color:var(--ink);margin-right:var(--s-3)' }, [`${selCount} 件選択中`]),
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: () => { selectedIds.clear(); setState({}); },
      }, ['選択解除']),
      statusBtn,
      prioBtn,
      assigneeBtn,
      csvBtn,
      el('button', {
        class: 'spira-btn spira-btn--danger spira-btn--sm',
        onclick: () => onBulkDelete(),
      }, [`${selCount} 件を削除`]),
    );
  } else {
    // 選択なしのときは CSV だけ右に
    right.push(csvBtn);
  }

  return el('div', { class: 'spira-subbar' + (selCount > 0 ? ' selected' : '') }, [
    el('div', { class: 'spira-subbar-title' }, [
      el('span', { class: 'spira-subbar-name' }, ['チケット一覧']),
      el('span', { class: 'spira-subbar-count' }, [`${visibleCount} 件`]),
    ]),
    el('div', { style: 'flex:1' }),
    ...right,
  ]);
}

/** バルク更新の共通実装。引数の patch を選択中の全チケットに適用。 */
async function onBulkUpdate(patch: Partial<Ticket>, label: string): Promise<void> {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  try {
    let failed = 0;
    for (const id of ids) {
      try { await getRepo().updateTicket(id, patch); }
      catch { failed++; }
    }
    if (failed > 0) {
      toast(root(), `${ids.length - failed} 件更新、${failed} 件失敗 (${label})`, 'warn');
    } else {
      toast(root(), `${ids.length} 件を更新しました (${label})`, 'ok');
    }
    selectedIds.clear();
    setState({});
  } catch (e) {
    toast(root(), `更新失敗: ${(e as Error).message}`, 'error');
  }
}

/** チケット一覧 (or 選択分) を CSV 形式でダウンロード。
 *  Excel が文字化けしないよう UTF-8 BOM を先頭に付与。 */
function exportTicketsCsv(tickets: Ticket[]): void {
  if (tickets.length === 0) {
    toast(root(), 'エクスポート対象がありません', 'warn');
    return;
  }
  const header = [
    'ID', 'タイトル', 'ステータス', '優先度', '担当者', '担当者メール',
    '部門', '問い合わせ種別', '起票者', '起票者メール',
    '期限', '作成日', '最終更新',
    'Teams 内部スレッド', 'Teams ユーザースレッド',
    '説明 (先頭 200 文字)',
  ];
  const rows = tickets.map(t => [
    formatTicketIdShort(t.id),
    t.title,
    t.status,
    t.priority,
    (t.assigneeNames ?? []).join(' / '),
    (t.assigneeEmails ?? []).join(' / '),
    t.department ?? '',
    t.inquiryCategory ?? '',
    t.reporterName ?? '',
    t.reporterEmail ?? '',
    t.dueDate ? fmtDate(t.dueDate, false) : '',
    fmtDate(t.createdAt),
    fmtDate(t.updatedAt),
    t.internalDeepLink ?? '',
    t.userDeepLink ?? '',
    (t.description ?? '').replace(/\s+/g, ' ').slice(0, 200),
  ]);
  const escape = (v: string): string => {
    // CSV 仕様: " を "" に。本体を " で囲む。
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const lines = [header, ...rows].map(r => r.map(escape).join(','));
  // BOM 付き UTF-8 で Excel 直開き対応
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spira-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(root(), `${tickets.length} 件を CSV でダウンロードしました`, 'ok');
}

function onBulkDelete(): void {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  confirmModal(root(), {
    title: 'まとめて削除',
    message: `${ids.length} 件のチケットをゴミ箱に移動します。`,
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
}

function applyFilters(rows: Ticket[]): Ticket[] {
  const s = getState();
  let out = rows;
  if (s.filter.status) out = out.filter(r => r.status === (s.filter.status as TicketStatus));
  if (s.filter.assignee === '__unset__') out = out.filter(r => !r.assigneeEmails || r.assigneeEmails.length === 0);
  else if (s.filter.assignee) out = out.filter(r => (r.assigneeEmails ?? []).includes(s.filter.assignee));
  if (s.filter.priority) out = out.filter(r => r.priority === (s.filter.priority as Priority));
  if (s.filter.query) {
    const q = s.filter.query.toLowerCase();
    out = out.filter(r => r.title.toLowerCase().includes(q) || String(r.id).includes(q));
  }
  return out;
}

function applySort(rows: Ticket[]): Ticket[] {
  const s = getState();
  const prioOrder: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };
  const statusOrder: Record<TicketStatus, number> = { '新規': 0, '対応中': 1, '確認待ち': 2, '完了': 3 };
  const dir = s.sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (s.sortBy) {
      case 'id':       cmp = a.id - b.id; break;
      case 'title':    cmp = a.title.localeCompare(b.title, 'ja'); break;
      case 'status':   cmp = statusOrder[a.status] - statusOrder[b.status]; break;
      case 'assignee': {
        // 複数担当者は最初の名前で比較。空配列なら空文字。
        const an = (a.assigneeNames ?? a.assigneeEmails ?? [])[0] ?? '';
        const bn = (b.assigneeNames ?? b.assigneeEmails ?? [])[0] ?? '';
        cmp = an.localeCompare(bn, 'ja');
        break;
      }
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
  if (f.priority) chip(`優先度: ${f.priority}`, 'priority');

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
    { key: 'priority', label: '優先度',     values: priorityList().map(v => ({ v, label: v })) },
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

function renderTable(rows: Ticket[], metaMap: Map<number, TicketMeta>): HTMLElement {
  if (rows.length === 0) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['該当するチケットがありません']),
        el('div', {}, ['受信メールから起票するか、右上の「新規チケット」から作成してください']),
      ]),
    ]);
  }

  const tableKey = 'tickets';
  // 列順 (renderHeaderRow と renderRow と必ず一致させること):
  //   ☐ / # / 件名 / ステータス / 担当 / 優先度 / 種別 / 部門 / 期限 /
  //   内部スレ / 外部スレ / 最終返信 / 滞留日 / 経過日 / 更新
  const colKeys: (string | null)[] = [
    null, 'id', 'title', 'status', 'assignee', 'priority', 'category', 'dept',
    'due', 'internal', 'external', 'lastDir', 'stagnant', 'elapsed', null,
  ];
  const defaults = [
    '36px', '64px', '280px', '96px', '120px', '80px', '140px', '120px',
    '110px', '70px', '70px', '100px', '80px', '80px', '140px',
  ];
  const widths = colKeys.map((k, i) => savedColWidth(tableKey, k, defaults[i]!));

  const table = el('table', { class: 'spira-tk-table', role: 'grid' }, [
    el('colgroup', {}, widths.map(w => el('col', { style: `width:${w}` }))),
    el('thead', {}, [renderHeaderRow(rows)]),
    el('tbody', {}, rows.map(t => renderRow(t, metaMap.get(t.id)))),
  ]) as HTMLTableElement;

  // Saved widths are applied synchronously above; resize handles still need DOM attach.
  setTimeout(() => attachColumnResize(table, { tableKey, colKeys }), 0);

  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('div', { class: 'spira-table-wrap' }, [table]),
  ]);
}

interface HeaderSpec {
  label: string;
  sortKey?: 'id' | 'title' | 'status' | 'assignee' | 'priority' | 'due' | 'updated';
}

function renderHeaderRow(visibleRows: Ticket[]): HTMLElement {
  const cols: HeaderSpec[] = [
    { label: '#',           sortKey: 'id' },
    { label: '件名',        sortKey: 'title' },
    { label: 'ステータス',  sortKey: 'status' },
    { label: '担当',        sortKey: 'assignee' },
    { label: '優先度',      sortKey: 'priority' },
    { label: '種別' },                                // 問い合わせ種別 (優先度の隣)
    { label: '部門' },
    { label: '期限',        sortKey: 'due' },
    { label: '内部スレ' },                             // 内部スレッド DeepLink
    { label: '外部スレ' },                             // 外部スレッド DeepLink
    { label: '最終返信' },
    { label: '滞留日' },
    { label: '経過日' },
    { label: '更新',        sortKey: 'updated' },
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

/** インライン編集用: アンカー要素の下にメニューを表示し、選択させる。 */
function openInlineSelectMenu<T extends string>(
  anchor: HTMLElement,
  options: T[],
  current: T | undefined,
  onSelect: (v: T) => void,
): void {
  document.querySelectorAll('.spira-inline-menu').forEach(n => n.remove());
  const menu = el('div', {
    class: 'spira-menu spira-inline-menu',
    style: 'position:fixed;z-index:2147483700;min-width:140px',
  }, options.map(opt => el('div', {
    class: 'spira-menu-item' + (opt === current ? ' spira-menu-item--current' : ''),
    onclick: (e: Event) => {
      e.stopPropagation();
      menu.remove();
      onSelect(opt);
    },
  }, [opt])));
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  root().appendChild(menu);
  setTimeout(() => {
    const closer = (e: Event) => {
      if (menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}

/** 担当者マルチ選択メニュー (チェックボックス式)。
 *  チケット一覧のインライン編集と詳細画面ヘッダで共有。 */
export function openInlineAssigneeMenu(
  anchor: HTMLElement,
  currentEmails: string[],
  onChange: (emails: string[], names: string[]) => void,
): void {
  document.querySelectorAll('.spira-inline-menu').forEach(n => n.remove());
  const users = getState().users;
  const selected = new Set(currentEmails);

  const list = el('div', { style: 'max-height:280px;overflow-y:auto' });
  const renderList = (filter: string): void => {
    list.replaceChildren();
    const q = filter.trim().toLowerCase();
    const candidates = q
      ? users.filter(u => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      : users;
    for (const u of candidates) {
      const cb = el('input', {
        type: 'checkbox',
        style: 'margin-right:6px',
      }) as HTMLInputElement;
      cb.checked = selected.has(u.email);
      const row = el('label', {
        style: 'display:flex;align-items:center;padding:4px 10px;cursor:pointer;font-size:var(--fs-sm)',
      }, [
        cb,
        el('span', { style: 'flex:1' }, [
          el('div', {}, [u.displayName]),
          el('div', { style: 'font-size:11px;color:var(--ink-3)' }, [u.email]),
        ]),
      ]);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(u.email);
        else selected.delete(u.email);
        const emails = Array.from(selected);
        const names = emails.map(e => users.find(u2 => u2.email === e)?.displayName ?? e);
        onChange(emails, names);
      });
      list.appendChild(row);
    }
    if (candidates.length === 0) {
      list.appendChild(el('div', { style: 'padding:8px;color:var(--ink-3);font-size:var(--fs-sm)' }, ['候補なし']));
    }
  };

  const filterInput = el('input', {
    type: 'text', placeholder: 'ユーザー検索',
    style: 'width:100%;padding:4px 8px;border:1px solid var(--line);border-radius:var(--r-2);font-size:var(--fs-sm);background:var(--paper);color:var(--ink)',
  }) as HTMLInputElement;
  filterInput.addEventListener('input', () => renderList(filterInput.value));

  const menu = el('div', {
    class: 'spira-menu spira-inline-menu',
    style: 'position:fixed;z-index:2147483700;min-width:240px;padding:8px;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-2);box-shadow:0 4px 12px rgba(0,0,0,0.12)',
    onclick: (e: Event) => e.stopPropagation(),
  }, [filterInput, list]);

  renderList('');

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  root().appendChild(menu);
  setTimeout(() => filterInput.focus(), 0);
  setTimeout(() => {
    const closer = (e: Event) => {
      if (menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}

/** インライン編集用: チケットを更新してトーストを出す。 */
async function inlineUpdate(t: Ticket, patch: Partial<Ticket>, fieldLabel: string): Promise<void> {
  try {
    await getRepo().updateTicket(t.id, patch);
    toast(root(), `${fieldLabel}を更新しました`, 'ok', 2000);
    setState({});
  } catch (e) {
    toast(root(), `${fieldLabel}の更新に失敗: ${(e as Error).message}`, 'error');
  }
}

function renderRow(t: Ticket, meta?: TicketMeta): HTMLElement {
  const overdue = t.dueDate ? isOverdue(t.dueDate) && t.status !== '完了' : false;

  const dayLabel = (n: number | null | undefined): string => (n == null ? '—' : `${n}日`);
  // Elapsed gets coloured warm if the ticket has been around a while AND
  // isn't completed yet — quick visual cue without sorting.
  const elapsedCls = (() => {
    if (t.status === '完了') return '';
    if (meta?.elapsedDays != null && meta.elapsedDays >= 7) return 'spira-tk-aged';
    return '';
  })();
  // Stagnation gets coloured similarly (≥3 days without a customer reply
  // is the fuzzy "needs follow-up" threshold). Tune later as needed.
  const stagnantCls = (() => {
    if (t.status === '完了') return '';
    if (meta?.stagnantDays != null && meta.stagnantDays >= 3) return 'spira-tk-aged';
    return '';
  })();
  const lastDirCell = (() => {
    if (!meta || meta.lastReplyDirection == null) {
      return el('span', { class: 'spira-badge' }, ['—']);
    }
    return meta.lastReplyDirection === 'internal'
      ? el('span', { class: 'spira-badge spira-badge--ok' }, ['内部'])
      : el('span', { class: 'spira-badge spira-badge--warn' }, ['外部']);
  })();

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

  // インライン編集セル: ラッパー td でクリックを止めて、内側で値表示 +
  // クリック時に編集メニューを開く。
  const statusCell = (() => {
    const badge = renderStatusBadge(t.status);
    badge.style.cursor = 'pointer';
    const td = el('td', {
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineSelectMenu<TicketStatus>(badge, ticketStatusList(), t.status, async (v) => {
          await inlineUpdate(t, { status: v }, 'ステータス');
        });
      },
    }, [badge]);
    return td;
  })();

  const assigneeCell = (() => {
    const view = renderAssignee(t.assigneeNames, t.assigneeEmails);
    view.style.cursor = 'pointer';
    return el('td', {
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineAssigneeMenu(view, t.assigneeEmails ?? [], async (emails, names) => {
          await inlineUpdate(t, {
            assigneeEmails: emails.length > 0 ? emails : undefined,
            assigneeNames: names.length > 0 ? names : undefined,
          }, '担当者');
        });
      },
    }, [view]);
  })();

  const priorityCell = (() => {
    const prio = renderPriorityDot(t.priority);
    prio.style.cursor = 'pointer';
    return el('td', {
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineSelectMenu<Priority>(prio, priorityList(), t.priority, async (v) => {
          await inlineUpdate(t, { priority: v }, '優先度');
        });
      },
    }, [prio]);
  })();

  // 期限はネイティブの <input type=date> でインライン編集
  const dueCellEditable = (() => {
    const input = el('input', {
      type: 'date',
      value: t.dueDate ? t.dueDate.slice(0, 10) : '',
      style: 'width:120px;padding:2px 4px;border:1px solid transparent;background:transparent;color:inherit;font:inherit',
    }) as HTMLInputElement;
    input.addEventListener('click', (e: Event) => e.stopPropagation());
    input.addEventListener('change', () => {
      const v = input.value ? new Date(input.value).toISOString() : undefined;
      void inlineUpdate(t, { dueDate: v }, '期限');
    });
    return el('td', { class: overdue ? 'spira-tk-due--overdue' : '' }, [input]);
  })();

  // Teams スレッド DeepLink セル (内部 / 外部)
  const threadLinkCell = (deepLink: string | undefined, emoji: string, label: string): HTMLElement => {
    if (!deepLink) return el('td', { style: 'color:var(--ink-4);text-align:center' }, ['—']);
    return el('td', { style: 'text-align:center' }, [
      el('a', {
        href: deepLink, target: '_blank', rel: 'noopener',
        title: label,
        style: 'text-decoration:none;font-size:16px',
        onclick: (e: Event) => e.stopPropagation(),
      }, [emoji]),
    ]);
  };
  const internalCell = threadLinkCell(t.internalDeepLink, '🏢', '内部スレッドを開く');
  const userCell = threadLinkCell(t.userDeepLink, '👥', 'ユーザースレッドを開く');

  // 部門 / 種別 セル (テキスト表示、未設定は灰色)
  const textCell = (val: string | undefined): HTMLElement =>
    val
      ? el('td', { style: 'font-size:var(--fs-sm);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis' }, [val])
      : el('td', { style: 'color:var(--ink-4);text-align:center' }, ['—']);
  const categoryCell = textCell(t.inquiryCategory);
  const deptCell = textCell(t.department);

  return el('tr', {
    class: 'spira-tk-row' + (selectedIds.has(t.id) ? ' selected' : ''),
    onclick: (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest('.spira-tk-checkbox-cell')) return;
      const open = getState().openTicketIds;
      const next = open.includes(t.id) ? open : [...open, t.id];
      setState({ selectedTicketId: t.id, openTicketIds: next });
    },
  }, [
    el('td', { class: 'spira-tk-checkbox-cell', onclick: (e: Event) => e.stopPropagation() }, [checkbox]),
    el('td', { class: 'spira-tk-id' }, [
      formatTicketIdShort(t.id),
      ...(meta?.hasNew
        ? [el('span', {
            class: 'spira-badge spira-badge--new',
            style: 'margin-left:var(--s-2)',
            title: '前回表示時以降の新着あり',
          }, ['NEW'])]
        : []),
    ]),
    el('td', { class: 'spira-tk-title' }, [t.title]),
    statusCell,
    assigneeCell,
    priorityCell,
    categoryCell,
    deptCell,
    dueCellEditable,
    internalCell,
    userCell,
    el('td', {}, [lastDirCell]),
    el('td', { class: stagnantCls }, [dayLabel(meta?.stagnantDays)]),
    el('td', { class: elapsedCls }, [dayLabel(meta?.elapsedDays)]),
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

export function renderAssignee(names?: string[], emails?: string[]): HTMLElement {
  const list = (emails ?? []).filter(Boolean);
  if (list.length === 0) {
    return el('span', { class: 'spira-avatar spira-avatar--unset', title: '未割当' }, ['?']);
  }
  // 1〜2 名はアバター並べ、3 名以上は「先頭 +N」表示でスペース節約。
  const MAX = 2;
  const visible = list.slice(0, MAX);
  const overflow = list.length - visible.length;
  const tooltip = list
    .map((email, i) => {
      const nm = (names ?? [])[i];
      return nm ? `${nm} <${email}>` : email;
    })
    .join('\n');
  const wrap = el('span', {
    class: 'spira-avatar-stack',
    title: tooltip,
    style: 'display:inline-flex;align-items:center;gap:-4px',
  });
  visible.forEach((email, i) => {
    const nm = (names ?? [])[i];
    wrap.appendChild(el('span', {
      class: 'spira-avatar',
      style: i > 0 ? 'margin-left:-6px' : '',
    }, [initials(nm ?? email)]));
  });
  if (overflow > 0) {
    wrap.appendChild(el('span', {
      class: 'spira-avatar spira-avatar--more',
      style: 'margin-left:-6px;background:var(--paper-2);color:var(--ink-3);font-size:10px',
    }, [`+${overflow}`]));
  }
  return wrap;
}
