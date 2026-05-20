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
import { findTag, getTagDictionarySync } from '../utils/tagDictionary';
import { renderTagPill } from './shell';
import { getDepartmentOptionsSync, getInquiryCategoryOptionsSync } from '../utils/optionLists';
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

/** 2 つの ISO 時刻の日数差。第 2 引数省略時は「今」基準。
 *  完了チケットは updatedAt を基準にすることで日数を凍結する。 */
function daysBetween(fromIso: string | null | undefined, toIso?: string): number | null {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return null;
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function daysSince(iso: string | null | undefined): number | null {
  return daysBetween(iso);
}

function deriveTicketMeta(comments: Comment[], ticket: Ticket): TicketMeta {
  const received = comments
    .filter(c => c.type === 'received')
    .sort((a, b) => new Date(a.sentAt ?? '').getTime() - new Date(b.sentAt ?? '').getTime());
  const last = received[received.length - 1];
  const lastSeen = getLastSeen(ticket.id);
  // 完了チケットは updatedAt を基準時刻にして日数を凍結する。
  // (案 A: 完了 = 更新停止という近似。完了後に編集すると updatedAt が
  //  動くので厳密な closedAt ではないが、運用上ほぼ問題ない)
  // M3: updatedAt が欠落している場合は createdAt にフォールバック (Date.now()
  // に倒れて毎日経過日数が増える挙動を防ぐ)。
  const isClosed = ticket.status === '完了';
  const refIso = isClosed ? (ticket.updatedAt || ticket.createdAt) : undefined;
  return {
    elapsedDays: daysBetween(ticket.createdAt, refIso),
    stagnantDays: last ? daysBetween(last.sentAt ?? null, refIso) : null,
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

  // 本セッションのデータをそのまま使う再描画関数を closure に作る。
  // 検索ボックスのライブ更新やフィルタ popover の「適用」から呼ばれ、
  // paintMain (= スケルトン + 全再 fetch) を経由せずに subBar / toolbar /
  // table を in-place で差し替える。これでちらつきと余計な API call を回避。
  let subBarSlot: HTMLElement;
  let toolbarSlot: HTMLElement;
  let tableSlot: HTMLElement;
  const rerender = (): void => {
    const filtered = applyFilters(tickets, metaMap);
    const sorted = applySort(filtered);
    const nextSubBar = renderSubBar(sorted.length, sorted);
    const nextToolbar = renderToolbar(rerender);
    const nextTable = renderTable(sorted, metaMap);
    subBarSlot.replaceWith(nextSubBar); subBarSlot = nextSubBar;
    toolbarSlot.replaceWith(nextToolbar); toolbarSlot = nextToolbar;
    tableSlot.replaceWith(nextTable); tableSlot = nextTable;
  };

  const filtered = applyFilters(tickets, metaMap);
  const sorted = applySort(filtered);

  // ルール: タイトル(subbar) → コントロール(toolbar) → 本体 の順
  // sorted を渡しているのは CSV エクスポートで「表示中の (フィルタ済) 全件」
  // を対象にするため。
  subBarSlot = renderSubBar(sorted.length, sorted);
  toolbarSlot = renderToolbar(rerender);
  tableSlot = renderTable(sorted, metaMap);
  wrap.appendChild(subBarSlot);
  wrap.appendChild(toolbarSlot);
  wrap.appendChild(tableSlot);
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
          await onBulkUpdate({ priority: next }, `影響度を「${next}」に変更`);
        });
      },
    }, ['影響度 ▾']);

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
    'ID', 'タイトル', 'ステータス', '影響度', '担当者', '担当者メール',
    '部門', '問い合わせ種別', '起票者', '起票者メール',
    '期限', '作成日', '最終更新',
    'Teams 外部スレッド', 'Teams 内部スレッド',
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
    t.userDeepLink ?? '',
    t.internalDeepLink ?? '',
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

/** 日付 (ISO 文字列 or yyyy-mm-dd) を yyyy-mm-dd の文字列に正規化。比較用。 */
function ymd(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** フィルタ用に「チケットの全コラム」をまとめた検索対象文字列を組み立てる。
 *  クエリ検索は全列に対する部分一致なので、対象列を 1 本に連結して
 *  toLowerCase + includes で済ませる。ID は SP の Id (#5) と
 *  表記用 ID (例: #00005) の両方を含めるので「02」のような部分指定でもヒットする。 */
function buildSearchHaystack(t: Ticket, meta?: TicketMeta): string {
  const parts: string[] = [];
  parts.push(t.title ?? '');
  parts.push(String(t.id));
  parts.push(formatTicketIdShort(t.id));
  parts.push(t.status ?? '');
  parts.push(t.priority ?? '');
  parts.push(...(t.assigneeNames ?? []));
  parts.push(...(t.assigneeEmails ?? []));
  parts.push(t.department ?? '');
  parts.push(t.inquiryCategory ?? '');
  parts.push(...((t.tags ?? []) as string[]));
  parts.push(t.reporterName ?? '');
  parts.push(t.reporterEmail ?? '');
  if (t.dueDate)     parts.push(ymd(t.dueDate) ?? t.dueDate);
  if (t.createdAt)   parts.push(ymd(t.createdAt) ?? t.createdAt);
  if (t.updatedAt)   parts.push(ymd(t.updatedAt) ?? t.updatedAt);
  if (meta?.lastReplyDirection) parts.push(meta.lastReplyDirection === 'internal' ? '内部' : '外部');
  return parts.filter(Boolean).join('').toLowerCase();
}

function applyFilters(rows: Ticket[], metaMap?: Map<number, TicketMeta>): Ticket[] {
  const s = getState();
  const f = s.filter;
  let out = rows;
  if (f.status)   out = out.filter(r => r.status === (f.status as TicketStatus));
  if (f.assignee === '__unset__') out = out.filter(r => !r.assigneeEmails || r.assigneeEmails.length === 0);
  else if (f.assignee) out = out.filter(r => (r.assigneeEmails ?? []).includes(f.assignee));
  if (f.priority) out = out.filter(r => r.priority === (f.priority as Priority));
  if (f.department) out = out.filter(r => (r.department ?? '') === f.department);
  if (f.category)   out = out.filter(r => (r.inquiryCategory ?? '') === f.category);
  if (f.tag)        out = out.filter(r => (r.tags ?? []).includes(f.tag!));

  // 日付レンジ (yyyy-mm-dd 文字列比較で完結。タイムゾーンを意識せずに済む)。
  const rangeFilter = (
    val: string | undefined,
    from?: string,
    to?: string,
  ): boolean => {
    if (!from && !to) return true;
    const y = ymd(val);
    if (!y) return false; // 値が無いレコードはレンジ指定時に除外
    if (from && y < from) return false;
    if (to && y > to) return false;
    return true;
  };
  if (f.dueFrom || f.dueTo)         out = out.filter(r => rangeFilter(r.dueDate, f.dueFrom, f.dueTo));
  if (f.createdFrom || f.createdTo) out = out.filter(r => rangeFilter(r.createdAt, f.createdFrom, f.createdTo));
  if (f.updatedFrom || f.updatedTo) out = out.filter(r => rangeFilter(r.updatedAt, f.updatedFrom, f.updatedTo));

  if (f.query) {
    // クエリは空白区切りで AND 検索 (どれも haystack に含まれること)。
    const tokens = f.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      out = out.filter(r => {
        const hay = buildSearchHaystack(r, metaMap?.get(r.id));
        return tokens.every(t => hay.includes(t));
      });
    }
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

function renderToolbar(rerender: () => void): HTMLElement {
  const s = getState();

  const filterBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: (e: Event) => {
      e.stopPropagation();
      openFilterPopover(filterBtn, rerender);
    },
  }, [
    el('span', { html: icon('filter'), style: 'display:inline-flex;width:14px;height:14px' }),
    `フィルター${activeFilterCount() > 0 ? ` (${activeFilterCount()})` : ''}`,
  ]);

  const searchInput = el('input', {
    type: 'search',
    class: 'spira-input spira-search-input',
    placeholder: 'キーワード検索 (件名 / ID / 担当 / 種別 / 部門 / タグ ほか)',
    value: s.filter.query,
    'data-focus-key': 'ticket-search',
  }) as HTMLInputElement;
  // ライブ検索: paintMain を経由すると毎打鍵で全 fetch + スケルトンが走って
  // ちらつくため、(a) setFilter は silent=true で state だけ更新、(b) 150ms
  // デバウンスで rerender (= 表 / subBar / toolbar の in-place 差替え) を呼ぶ。
  let debounceTimer: number | null = null;
  searchInput.addEventListener('input', () => {
    setFilter({ query: searchInput.value }, { silent: true });
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      rerender();
    }, 150);
  });

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

  return el('div', {}, [toolbar, renderFilterChips(rerender)]);
}

function activeFilterCount(): number {
  const f = getState().filter;
  // chip / popover 両方で「条件アリ」と数える項目を 1 箇所にまとめる。
  const single = [f.status, f.assignee, f.priority, f.department, f.category, f.tag];
  const ranges = [
    f.dueFrom, f.dueTo,
    f.createdFrom, f.createdTo,
    f.updatedFrom, f.updatedTo,
  ];
  // 各レンジは (from || to) で 1 つとしてカウントしたいので 2 軸ずつ OR
  const rangePairs = [
    f.dueFrom || f.dueTo,
    f.createdFrom || f.createdTo,
    f.updatedFrom || f.updatedTo,
  ];
  void ranges; // ranges は将来の拡張用に保持 (今は未使用)
  return [...single, ...rangePairs].filter(Boolean).length;
}

function renderFilterChips(rerender: () => void): HTMLElement {
  const s = getState();
  const f = s.filter;
  const chips: HTMLElement[] = [];

  function chip(label: string, clearPatch: Partial<typeof f>) {
    chips.push(el('span', {
      class: 'spira-filter-chip',
      title: 'クリック で外す',
      onclick: () => { setFilter(clearPatch, { silent: true }); rerender(); },
    }, [label, el('span', { style: 'margin-left:4px;color:var(--ink-3)' }, ['×'])]));
  }
  if (f.status) chip(`ステータス: ${f.status}`, { status: '' });
  if (f.assignee) {
    const u = s.users.find(x => x.email === f.assignee);
    chip(`担当者: ${f.assignee === '__unset__' ? '未割当' : (u?.displayName ?? f.assignee)}`, { assignee: '' });
  }
  if (f.priority) chip(`影響度: ${f.priority}`, { priority: '' });
  if (f.department) chip(`部門: ${f.department}`, { department: '' });
  if (f.category) chip(`種別: ${f.category}`, { category: '' });
  if (f.tag) chip(`タグ: ${f.tag}`, { tag: '' });
  const dateChip = (label: string, from: string | undefined, to: string | undefined, patch: Partial<typeof f>): void => {
    if (!from && !to) return;
    const range = `${from || '…'} ~ ${to || '…'}`;
    chip(`${label}: ${range}`, patch);
  };
  dateChip('期限', f.dueFrom, f.dueTo, { dueFrom: '', dueTo: '' });
  dateChip('作成日', f.createdFrom, f.createdTo, { createdFrom: '', createdTo: '' });
  dateChip('更新日', f.updatedFrom, f.updatedTo, { updatedFrom: '', updatedTo: '' });

  if (chips.length === 0) return el('div', { style: 'display:none' });

  chips.push(el('button', {
    class: 'spira-filter-chip-clear',
    onclick: () => {
      setFilter({
        status: '', assignee: '', priority: '',
        department: '', category: '', tag: '',
        dueFrom: '', dueTo: '',
        createdFrom: '', createdTo: '',
        updatedFrom: '', updatedTo: '',
      }, { silent: true });
      rerender();
    },
  }, ['すべてクリア']));

  return el('div', { class: 'spira-filter-chipstrip' }, chips);
}

function openFilterPopover(anchor: HTMLElement, rerender: () => void): void {
  document.querySelectorAll('.spira-filter-pop').forEach(n => n.remove());

  const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;
  const f: Record<string, string> = { ...getState().filter } as Record<string, string>;
  const users = getState().users;
  const departments = getDepartmentOptionsSync();
  const categories = getInquiryCategoryOptionsSync();
  const tagDict = (() => {
    try { return getTagDictionarySync().map(t => t.name); }
    catch { return [] as string[]; }
  })();

  // Field rows. Single-value filters use a <select>; date ranges use 2 inputs.
  type FieldKey =
    | 'status' | 'assignee' | 'priority'
    | 'department' | 'category' | 'tag';
  type DateRangeKey = 'due' | 'created' | 'updated';
  interface SingleField {
    kind: 'single';
    key: FieldKey;
    label: string;
    values: { v: string; label: string }[];
  }
  interface RangeField {
    kind: 'range';
    key: DateRangeKey;
    label: string;
    fromKey: 'dueFrom' | 'createdFrom' | 'updatedFrom';
    toKey:   'dueTo'   | 'createdTo'   | 'updatedTo';
  }
  type Field = SingleField | RangeField;
  const FIELDS: Field[] = [
    { kind: 'single', key: 'status',   label: 'ステータス', values: ticketStatusList().map(v => ({ v, label: v })) },
    { kind: 'single', key: 'assignee', label: '担当者',     values: [
        { v: '__unset__', label: '(未割当)' },
        ...users.map(u => ({ v: u.email, label: u.displayName })),
    ] },
    { kind: 'single', key: 'priority', label: '影響度',     values: priorityList().map(v => ({ v, label: v })) },
    { kind: 'single', key: 'department', label: '部門',     values: departments.map(v => ({ v, label: v })) },
    { kind: 'single', key: 'category',   label: '種別',     values: categories.map(v => ({ v, label: v })) },
    { kind: 'single', key: 'tag',        label: 'タグ',     values: tagDict.map(v => ({ v, label: v })) },
    { kind: 'range', key: 'due',     label: '期限',   fromKey: 'dueFrom',     toKey: 'dueTo' },
    { kind: 'range', key: 'created', label: '作成日', fromKey: 'createdFrom', toKey: 'createdTo' },
    { kind: 'range', key: 'updated', label: '更新日', fromKey: 'updatedFrom', toKey: 'updatedTo' },
  ];

  const isActive = (F: Field): boolean => {
    if (F.kind === 'single') return !!f[F.key];
    return !!(f[F.fromKey] || f[F.toKey]);
  };

  const rowsWrap = el('div', { class: 'spira-fpop-body' });

  function paintRows() {
    clear(rowsWrap);
    const present = FIELDS.filter(isActive);
    if (present.length === 0) {
      rowsWrap.appendChild(el('div', { class: 'spira-fpop-empty' }, ['条件はまだありません']));
      return;
    }
    for (const F of present) {
      if (F.kind === 'single') {
        const valSel = el('select', { class: 'spira-fpop-val' }, [
          ...F.values.map(o => el('option', { value: o.v, selected: o.v === f[F.key] }, [o.label])),
        ]) as HTMLSelectElement;
        valSel.addEventListener('change', () => { f[F.key] = valSel.value; });

        const removeBtn = el('button', {
          class: 'spira-fpop-rm',
          title: 'この条件を削除',
          onclick: () => { f[F.key] = ''; paintRows(); },
        }, ['×']);

        rowsWrap.appendChild(el('div', { class: 'spira-fpop-row' }, [
          el('span', { class: 'spira-fpop-field' }, [F.label]),
          el('span', { class: 'spira-fpop-op' }, ['は']),
          valSel,
          removeBtn,
        ]));
      } else {
        // 日付レンジ: from / to (どちらか片方だけでも可)
        const fromInput = el('input', {
          type: 'date', class: 'spira-input', style: 'min-width:140px;flex:1',
          value: f[F.fromKey] ?? '',
        }) as HTMLInputElement;
        const toInput = el('input', {
          type: 'date', class: 'spira-input', style: 'min-width:140px;flex:1',
          value: f[F.toKey] ?? '',
        }) as HTMLInputElement;
        fromInput.addEventListener('change', () => { f[F.fromKey] = fromInput.value; });
        toInput  .addEventListener('change', () => { f[F.toKey]   = toInput.value; });

        const removeBtn = el('button', {
          class: 'spira-fpop-rm',
          title: 'この条件を削除',
          onclick: () => { f[F.fromKey] = ''; f[F.toKey] = ''; paintRows(); },
        }, ['×']);

        rowsWrap.appendChild(el('div', { class: 'spira-fpop-row' }, [
          el('span', { class: 'spira-fpop-field' }, [F.label]),
          el('span', { class: 'spira-fpop-op' }, ['が']),
          el('div', { style: 'display:flex;gap:6px;align-items:center;flex:1;flex-wrap:wrap' }, [
            fromInput,
            el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs)' }, ['〜']),
            toInput,
          ]),
          removeBtn,
        ]));
      }
    }
  }
  paintRows();

  // Add-row select: pick any field that doesn't already have a value.
  const addSel = el('select', { class: 'spira-select', style: 'flex:1' }, [
    el('option', { value: '' }, ['＋ 条件を追加']),
    ...FIELDS.filter(F => !isActive(F)).map(F => el('option', { value: F.kind === 'single' ? F.key : `range:${F.key}` }, [F.label])),
  ]) as HTMLSelectElement;
  addSel.addEventListener('change', () => {
    const v = addSel.value;
    if (!v) return;
    if (v.startsWith('range:')) {
      const rk = v.slice('range:'.length);
      const F = FIELDS.find(x => x.kind === 'range' && x.key === rk) as RangeField | undefined;
      if (F) { f[F.fromKey] = ''; f[F.toKey] = ''; /* render側でレンジを「条件あり」扱いするには */ }
      // レンジは from/to どちらかが入って初めて active になる仕様にすると、
      // 「追加した瞬間に行が出ない」UX になるので、見せかけの空値で active 化する。
      // ここで _placeholder を入れず、isActive 側を「from/to のキーが filter
      // オブジェクトに存在するか」基準にしてもいいが、シンプルに sentinel として
      // 空文字を入れて即 paintRows する (空のままなら apply 時に値は空文字 → 無効化)。
      if (F) { f[F.fromKey] = ' '; f[F.toKey] = ' '; }
    } else {
      const F = FIELDS.find(x => x.kind === 'single' && x.key === v) as SingleField | undefined;
      if (F) f[F.key] = F.values[0]?.v ?? '';
    }
    addSel.value = '';
    paintRows();
  });

  const apply = el('button', {
    class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => {
      // sentinel の半角空白 (' ') は無効値として空文字に倒す。
      for (const k of Object.keys(f)) {
        if (typeof f[k] === 'string' && f[k]!.trim() === '') f[k] = '';
      }
      // f は Record<string, string> なので setFilter の Partial<filter> シェイプに
      // 暗黙キャストできない。setFilter は Object.assign で部分マージするだけなので、
      // 型的にズレた未知のキーが混ざっても無視されるため as never で押し込む。
      setFilter(f as never, { silent: true });
      rerender();
      pop.remove();
    },
  }, ['適用']);

  const clearAll = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    onclick: () => {
      for (const k of Object.keys(f)) {
        if (k === 'query') continue;
        f[k] = '';
      }
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
  //   ☐ / # / 件名 / ステータス / 担当 / 影響度 / 種別 / 部門 / 期限 /
  //   外部スレ / 内部スレ / 最終返信 / 滞留日 / 経過日 / 更新
  // (UX 統一: 外部スレ → 内部スレ の順、ヘッダ / ボタン群と一致)
  const colKeys: (string | null)[] = [
    null, 'id', 'title', 'status', 'assignee', 'priority', 'category', 'dept',
    'due', 'external', 'internal', 'lastDir', 'stagnant', 'elapsed', null,
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
    { label: '影響度',      sortKey: 'priority' },
    { label: '種別' },                                // 問い合わせ種別 (影響度の隣)
    { label: '部門' },
    { label: '期限',        sortKey: 'due' },
    { label: '外部スレ' },                             // 外部スレッド DeepLink (UX 統一: 外部 → 内部)
    { label: '内部スレ' },                             // 内部スレッド DeepLink
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
  opts?: { clearLabel?: string; onClear?: () => void },
): void {
  document.querySelectorAll('.spira-inline-menu').forEach(n => n.remove());
  const items: HTMLElement[] = [];
  // 「未設定にする」項目を先頭に追加 (オプション扱い)。
  // 部門 / 種別など、空に戻したい列のために使う。
  if (opts?.clearLabel && opts?.onClear) {
    const cleared = current == null || current === '';
    items.push(el('div', {
      class: 'spira-menu-item' + (cleared ? ' spira-menu-item--current' : ''),
      style: 'color:var(--ink-3);font-style:italic',
      onclick: (e: Event) => {
        e.stopPropagation();
        menu.remove();
        opts.onClear?.();
      },
    }, [opts.clearLabel]));
  }
  for (const opt of options) {
    items.push(el('div', {
      class: 'spira-menu-item' + (opt === current ? ' spira-menu-item--current' : ''),
      onclick: (e: Event) => {
        e.stopPropagation();
        menu.remove();
        onSelect(opt);
      },
    }, [opt]));
  }
  // 候補が空のとき (= 設定で 1 件も登録されていない) のガイダンス。
  if (items.length === 0) {
    items.push(el('div', {
      style: 'padding:8px 12px;color:var(--ink-3);font-size:var(--fs-sm)',
    }, ['候補がありません。設定から追加してください。']));
  }
  const menu = el('div', {
    class: 'spira-menu spira-inline-menu',
    style: 'position:fixed;z-index:2147483700;min-width:140px;max-height:320px;overflow-y:auto',
  }, items);
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
          await inlineUpdate(t, { priority: v }, '影響度');
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
  const userCell = threadLinkCell(t.userDeepLink, '👥', '外部スレッドを開く');

  // 部門 / 種別 セル — インライン編集対応。クリックで選択肢メニューを開く。
  // 候補は設定 (utils/optionLists) から取得。未設定にも戻せる (clearLabel)。
  const inlineEditableCell = (
    val: string | undefined,
    options: string[],
    fieldLabel: string,
    fieldKey: 'department' | 'inquiryCategory',
  ): HTMLElement => {
    const display = val
      ? el('span', {
          style: 'display:inline-block;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle',
          title: val,
        }, [val])
      : el('span', { style: 'color:var(--ink-4)' }, ['—']);
    return el('td', {
      style: 'font-size:var(--fs-sm);cursor:pointer',
      title: `クリックで${fieldLabel}を変更`,
      onclick: (e: Event) => {
        e.stopPropagation();
        const anchor = e.currentTarget as HTMLElement;
        openInlineSelectMenu<string>(
          anchor,
          options,
          val,
          async (next) => {
            await inlineUpdate(t, { [fieldKey]: next } as Partial<Ticket>, fieldLabel);
          },
          {
            clearLabel: '— 未設定にする',
            onClear: async () => {
              await inlineUpdate(t, { [fieldKey]: undefined } as Partial<Ticket>, fieldLabel);
            },
          },
        );
      },
    }, [display]);
  };
  const categoryCell = inlineEditableCell(
    t.inquiryCategory, getInquiryCategoryOptionsSync(), '種別', 'inquiryCategory',
  );
  const deptCell = inlineEditableCell(
    t.department, getDepartmentOptionsSync(), '部門', 'department',
  );

  const isClosed = t.status === '完了';
  return el('tr', {
    class: 'spira-tk-row'
      + (selectedIds.has(t.id) ? ' selected' : '')
      + (isClosed ? ' spira-tk-row--closed' : ''),
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
    el('td', { class: 'spira-tk-title' }, [
      el('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:var(--s-2)' }, [
        el('span', {}, [t.title]),
        ...((t.tags ?? []).map(name => renderTagPill(findTag(name)))),
      ]),
    ]),
    statusCell,
    assigneeCell,
    priorityCell,
    categoryCell,
    deptCell,
    dueCellEditable,
    userCell,           // 外部スレッド (UX 統一: 外部 → 内部)
    internalCell,
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
