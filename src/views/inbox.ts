import { el, fmtDate, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { renderMailBody } from '../utils/sanitize';
import { openModal, confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { attachColumnResize, savedColWidth } from '../utils/colResize';
import { formatTicketIdShort, parseTicketTag } from '../utils/ticketTag';
import { createDateTime } from '../components/datetime';
import { parseTeamsPaste, resolveTeamsTimeToISO, detectLeadingOrphan } from '../lib/teams-paste';
import { parseEml, parseOutlookDragText, parseMsgFile, looksLikeEml, looksLikeOutlookDrag } from '../lib/eml-parser';
import { createAssigneePicker } from '../components/assigneePicker';
import { getDepartmentOptions, getInquiryCategoryOptions } from '../utils/optionLists';
import type { InboxMail, TicketStatus, Priority, Ticket } from '../types';

/** 同じ送信者 (fromEmail or fromName) かつ 同じ送信時刻 (分単位) の
 *  受信履歴を持つチケットを探す。受信箱由来でも手動入力でも使える汎用版。
 *
 *  比較ロジック:
 *    1. internetMessageId 一致 → 強シグナル (PA / Outlook の per-message ID)
 *    2. fromEmail + sentAt (分単位) 一致 → 通常のユースケース
 *    3. fromName + sentAt (分単位) 一致 → email が無い場合の代替
 *
 *  N+1 コスト: チケット数 × listComments。実用上は小さい (SP の Tickets は
 *  数百件以下が想定)。 */
async function findDuplicateTicket(opts: {
  fromEmail?: string;
  fromName?: string;
  sentISO?: string;        // ISO 8601 (秒/ミリ秒含んでよい、内部で分まで切り捨て)
  internetMessageId?: string;
}): Promise<{ ticket: Ticket; reason: string } | null> {
  const minuteKey = (iso?: string): string => {
    if (!iso) return '';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : iso;
  };
  const targetMin = minuteKey(opts.sentISO);
  const fromEmailLc = (opts.fromEmail ?? '').toLowerCase().trim();
  const fromNameLc  = (opts.fromName  ?? '').toLowerCase().trim();
  const messageId   = (opts.internetMessageId ?? '').trim();
  if (!fromEmailLc && !fromNameLc && !messageId) return null;

  const repo = getRepo();
  const tickets = await repo.listTickets();
  for (const t of tickets) {
    let comments;
    try { comments = await repo.listComments(t.id); }
    catch { continue; }
    for (const c of comments) {
      if (c.type !== 'received') continue;
      if (messageId && c.internetMessageId && c.internetMessageId === messageId) {
        return { ticket: t, reason: 'Message-ID 一致' };
      }
      const cMin = minuteKey(c.sentAt);
      if (!cMin || !targetMin || cMin !== targetMin) continue;
      const cEmail = (c.fromEmail ?? '').toLowerCase().trim();
      const cName  = (c.fromName  ?? '').toLowerCase().trim();
      if (fromEmailLc && cEmail && fromEmailLc === cEmail) {
        return { ticket: t, reason: '送信者 (メール) + 送信時刻一致' };
      }
      if (fromNameLc && cName && fromNameLc === cName) {
        return { ticket: t, reason: '送信者 (名前) + 送信時刻一致' };
      }
    }
  }
  return null;
}

// 旧 findDuplicateTicketForMail は findDuplicateTicket に統一済み。

const expandedIds = new Set<number>();
const selectedInboxIds = new Set<number>();

// Inbox-local filter — separate from ticket filter.
type InboxAttachFilter = '' | 'yes' | 'no';
interface InboxFilter { query: string; fromEmail: string; hasAttachments: InboxAttachFilter; includeHidden: boolean }
const inboxFilter: InboxFilter = { query: '', fromEmail: '', hasAttachments: '', includeHidden: false };

// Inbox-local sort. 既定は受信日時の降順 (最新が上)。
type InboxSortKey = 'subject' | 'from' | 'date';
const inboxSort: { by: InboxSortKey; dir: 'asc' | 'desc' } = { by: 'date', dir: 'desc' };

function applyInboxSort(rows: InboxMail[]): InboxMail[] {
  const { by, dir } = inboxSort;
  const sign = dir === 'asc' ? 1 : -1;
  const norm = (s: string | undefined): string => (s ?? '').toLowerCase();
  const out = [...rows];
  out.sort((a, b) => {
    let av: string; let bv: string;
    if (by === 'subject') { av = norm(a.subject); bv = norm(b.subject); }
    else if (by === 'from') {
      // 表示名 (fromName) を優先、無ければ email
      av = norm(a.fromName || a.fromEmail);
      bv = norm(b.fromName || b.fromEmail);
    }
    else { // date — receivedAt がプライマリ、無ければ sentAt
      av = String(a.receivedAt ?? a.sentAt ?? '');
      bv = String(b.receivedAt ?? b.sentAt ?? '');
    }
    if (av < bv) return -1 * sign;
    if (av > bv) return  1 * sign;
    return 0;
  });
  return out;
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}

/** HTML 本文を plain text に剥がす。Forms 経由など PA が BodyText を
 *  空のまま InboxMails 行を作るケース向けの fallback 用。<br>/<p>/<div>/<li>
 *  などのブロック境界を改行に置換してから全タグ削除し、よく使う HTML
 *  エンティティをデコードする。 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function renderInbox(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  // unprocessedOnly は外す。タグ付きメールは auto-sync で processed に
  // なるので、unprocessed フィルターを掛けると Inbox に何も残らない。
  // タグ付き = 既存チケット関連の履歴として常に閲覧できる方が便利。
  // B: 起票済み (IsProcessed=true) 行は一覧から自動的に消す。
  // 過去履歴を見たい場合は SP リストで直接確認可能 (UI には残さない)。
  const allMails = await getRepo().listInbox({
    includeHidden: inboxFilter.includeHidden,
    unprocessedOnly: true,
  });
  const filtered = applyInboxFilters(allMails);
  const sorted = applyInboxSort(filtered);

  for (const id of Array.from(selectedInboxIds)) if (!sorted.find(m => m.id === id)) selectedInboxIds.delete(id);

  wrap.appendChild(renderSubBar(sorted.length));
  wrap.appendChild(renderToolbar(allMails));
  wrap.appendChild(renderList(sorted));
  return wrap;
}

/** Forms 経由で取り込まれたメールかどうかを判定。PA フロー 1 が
 *  ConversationId を `forms-<formId>-<responseId>` 形式で埋め込む規約
 *  に従う。Forms はチケットタグを件名に持たないので、タグ判定とは
 *  別軸で受信ボックスに出し続ける必要がある。 */
export function isFormsSource(m: InboxMail): boolean {
  return !!m.conversationId && m.conversationId.startsWith('forms-');
}

/** Teams 返信経由で取り込まれた行かどうかを判定。PA フロー④ が
 *  ConversationId を `teams-<parentMessageId>` 形式で埋め込む規約に従う。
 *  syncInbox で internalThreadId / userThreadId と一致するチケットがあれば
 *  自動紐付けされて InboxMails から消えるので、ここに残っている Teams 行は
 *  「チャネル外の議論」や「完了済みチケットへの返信 (運用次第)」など。 */
export function isTeamsSource(m: InboxMail): boolean {
  return !!m.conversationId && m.conversationId.startsWith('teams-');
}

/** Inbox 表示・バッジカウントで共通して使う一次フィルター。
 *  以下のいずれかを満たすメールを表示:
 *    - 件名にチケットタグを含む (auto-link 待ちの返信メール)
 *    - Forms 経由 (新規問い合わせ、チケット起票判断待ち)
 *    - Teams 経由 (チケットに紐付かなかった返信 = 手動トリアージ対象)
 *  syncInbox 側でタグ無しメールは物理削除する運用なので、ここに
 *  残っているタグ無しメールはほぼ Forms / Teams 経由のはず。 */
export function inboxRowsWithTag(rows: InboxMail[]): InboxMail[] {
  return rows.filter(m =>
    parseTicketTag(m.subject) != null || isFormsSource(m) || isTeamsSource(m),
  );
}

function applyInboxFilters(rows: InboxMail[]): InboxMail[] {
  let out = inboxRowsWithTag(rows);
  if (inboxFilter.fromEmail) out = out.filter(m => m.fromEmail === inboxFilter.fromEmail);
  if (inboxFilter.hasAttachments === 'yes') out = out.filter(m => m.hasAttachments);
  if (inboxFilter.hasAttachments === 'no') out = out.filter(m => !m.hasAttachments);
  if (inboxFilter.query) {
    const q = inboxFilter.query.toLowerCase();
    out = out.filter(m =>
      m.subject.toLowerCase().includes(q) ||
      (m.fromEmail ?? '').toLowerCase().includes(q) ||
      (m.fromName ?? '').toLowerCase().includes(q),
    );
  }
  return out;
}

function activeInboxFilterCount(): number {
  return [inboxFilter.fromEmail, inboxFilter.hasAttachments].filter(Boolean).length;
}

function renderToolbar(allMails: InboxMail[]): HTMLElement {
  const filterBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: (e: Event) => { e.stopPropagation(); openInboxFilterPopover(filterBtn, allMails); },
  }, [
    el('span', { html: icon('filter'), style: 'display:inline-flex;width:14px;height:14px' }),
    `フィルター${activeInboxFilterCount() > 0 ? ` (${activeInboxFilterCount()})` : ''}`,
  ]);

  const searchInput = el('input', {
    type: 'search',
    class: 'spira-input spira-search-input',
    placeholder: '件名 / 送信者で検索',
    value: inboxFilter.query,
    'data-focus-key': 'inbox-search',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    inboxFilter.query = searchInput.value;
    setState({});
  });

  const showHiddenToggle = el('button', {
    class: `spira-btn spira-btn--sm ${inboxFilter.includeHidden ? 'spira-btn--secondary' : 'spira-btn--ghost'}`,
    title: inboxFilter.includeHidden ? '非表示メールを一覧から外す' : '非表示メールも一時的に表示',
    onclick: () => {
      inboxFilter.includeHidden = !inboxFilter.includeHidden;
      setState({});
    },
  }, [inboxFilter.includeHidden ? '✓ 非表示も表示' : '非表示も表示']);

  const toolbar = el('div', { class: 'spira-toolbar' }, [
    filterBtn,
    showHiddenToggle,
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

  return el('div', {}, [toolbar, renderInboxFilterChips()]);
}

function renderInboxFilterChips(): HTMLElement {
  const chips: HTMLElement[] = [];
  function chip(label: string, key: keyof InboxFilter) {
    chips.push(el('span', {
      class: 'spira-filter-chip',
      onclick: () => {
        (inboxFilter as unknown as Record<string, string>)[key] = '';
        setState({});
      },
    }, [label, el('span', { style: 'margin-left:4px;color:var(--ink-3)' }, ['×'])]));
  }
  if (inboxFilter.fromEmail) chip(`送信者: ${inboxFilter.fromEmail}`, 'fromEmail');
  if (inboxFilter.hasAttachments === 'yes') chip('添付: あり', 'hasAttachments');
  if (inboxFilter.hasAttachments === 'no') chip('添付: なし', 'hasAttachments');
  if (chips.length === 0) return el('div', { style: 'display:none' });
  chips.push(el('button', {
    class: 'spira-filter-chip-clear',
    onclick: () => {
      inboxFilter.fromEmail = '';
      inboxFilter.hasAttachments = '';
      setState({});
    },
  }, ['すべてクリア']));
  return el('div', { class: 'spira-filter-chipstrip' }, chips);
}

function openInboxFilterPopover(anchor: HTMLElement, allMails: InboxMail[]): void {
  document.querySelectorAll('.spira-filter-pop').forEach(n => n.remove());
  const root = getRoot();
  const f: InboxFilter = { ...inboxFilter };

  const senders = Array.from(new Set(allMails.map(m => m.fromEmail).filter(Boolean)));

  type FieldKey = 'fromEmail' | 'hasAttachments';
  const FIELDS: { key: FieldKey; label: string; values: { v: string; label: string }[] }[] = [
    { key: 'fromEmail', label: '送信者', values: senders.map(s => ({ v: s, label: s })) },
    { key: 'hasAttachments', label: '添付', values: [
      { v: 'yes', label: 'あり' },
      { v: 'no',  label: 'なし' },
    ] },
  ];

  const rowsWrap = el('div', { class: 'spira-fpop-body' });
  function paintRows() {
    clear(rowsWrap);
    const present = (['fromEmail', 'hasAttachments'] as FieldKey[]).filter(k => f[k]);
    if (present.length === 0) {
      rowsWrap.appendChild(el('div', { class: 'spira-fpop-empty' }, ['条件はまだありません']));
    } else {
      for (const key of present) {
        const fieldDef = FIELDS.find(F => F.key === key);
        if (!fieldDef) continue;
        const valSel = el('select', { class: 'spira-fpop-val' },
          fieldDef.values.map(o => el('option', { value: o.v, selected: o.v === f[key] }, [o.label])),
        ) as HTMLSelectElement;
        valSel.addEventListener('change', () => { (f as unknown as Record<string, string>)[key] = valSel.value; });

        const removeBtn = el('button', {
          class: 'spira-fpop-rm',
          onclick: () => { (f as unknown as Record<string, string>)[key] = ''; paintRows(); },
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

  const addSel = el('select', { class: 'spira-select', style: 'flex:1' }, [
    el('option', { value: '' }, ['＋ 条件を追加']),
    ...FIELDS.filter(F => !f[F.key]).map(F => el('option', { value: F.key }, [F.label])),
  ]) as HTMLSelectElement;
  addSel.addEventListener('change', () => {
    const key = addSel.value as FieldKey;
    if (!key) return;
    const def = FIELDS.find(F => F.key === key);
    if (def) (f as unknown as Record<string, string>)[key] = def.values[0]?.v ?? '';
    addSel.value = '';
    paintRows();
  });

  const apply = el('button', {
    class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => {
      Object.assign(inboxFilter, f);
      pop.remove();
      setState({});
    },
  }, ['適用']);

  const clearAll = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    onclick: () => { f.fromEmail = ''; f.hasAttachments = ''; paintRows(); },
  }, ['クリア']);

  const pop = el('div', { class: 'spira-filter-pop' }, [
    el('div', { class: 'spira-fpop-hd' }, [
      el('span', {}, ['フィルター']),
      el('button', { class: 'spira-fpop-close', onclick: () => pop.remove() }, ['×']),
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

function renderSubBar(visibleCount: number): HTMLElement {
  const selCount = selectedInboxIds.size;
  const right: (HTMLElement | string)[] = [];
  if (selCount > 0) {
    right.push(
      el('span', { style: 'font-size:var(--fs-sm);color:var(--ink);margin-right:var(--s-3)' }, [`${selCount} 件選択中`]),
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: () => { selectedInboxIds.clear(); setState({}); },
      }, ['選択解除']),
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: () => onBulkHide(),
      }, [`${selCount} 件を非表示`]),
    );
  }

  return el('div', { class: 'spira-subbar' + (selCount > 0 ? ' selected' : '') }, [
    el('div', { class: 'spira-subbar-title' }, [
      el('span', { class: 'spira-subbar-name' }, ['受信一覧']),
      el('span', { class: 'spira-subbar-count' }, [`${visibleCount} 件`]),
    ]),
    el('div', { style: 'flex:1' }),
    ...right,
  ]);
}

function onBulkHide(): void {
  const ids = Array.from(selectedInboxIds);
  if (ids.length === 0) return;
  confirmModal(getRoot(), {
    title: 'まとめて非表示',
    message: `${ids.length} 件を一覧から非表示にします。\n（チケット起票や紐付けは行いません。受信メールリスト上では IsHidden = true になります）`,
    primaryLabel: '非表示にする',
    primaryVariant: 'primary',
    onConfirm: async () => {
      try {
        await getRepo().hideInboxItems(ids);
        toast(getRoot(), `${ids.length} 件を非表示にしました`, 'ok');
        selectedInboxIds.clear();
        const fresh = await getRepo().listInbox({ unprocessedOnly: true });
        setState({ inboxCount: inboxRowsWithTag(fresh).length });
      } catch (e) {
        toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
      }
    },
  });
}

function renderList(mails: InboxMail[]): HTMLElement {
  if (mails.length === 0) {
    const sampleBtn = el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: async () => {
        sampleBtn.setAttribute('disabled', '');
        try {
          const r = await getRepo().addSampleInbox();
          toast(getRoot(), `サンプルメール ${r.count} 件を追加しました`, 'ok');
          const fresh = await getRepo().listInbox({ unprocessedOnly: true });
          setState({ inboxCount: inboxRowsWithTag(fresh).length });
        } catch (e) {
          toast(getRoot(), `追加失敗: ${(e as Error).message}`, 'error');
        } finally {
          sampleBtn.removeAttribute('disabled');
        }
      },
    }, ['サンプルメールを追加']);

    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['未処理メールはありません']),
        el('div', {}, ['Power Automate を設定すると新着メールが自動で取り込まれます。']),
        el('div', { style: 'margin-top:var(--s-3);font-size:var(--fs-sm)' }, ['PA 設定前のテスト用にサンプルメールを追加できます。']),
        sampleBtn,
      ]),
    ]);
  }

  // Same table style as Tickets — checkbox column + sortable headers (only date here).
  const allChecked = mails.every(m => selectedInboxIds.has(m.id));
  const someChecked = !allChecked && mails.some(m => selectedInboxIds.has(m.id));
  const selectAll = el('input', {
    type: 'checkbox',
    'aria-label': 'すべて選択',
    onclick: (e: Event) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) for (const m of mails) selectedInboxIds.add(m.id);
      else for (const m of mails) selectedInboxIds.delete(m.id);
      setState({});
    },
  }) as HTMLInputElement;
  selectAll.checked = allChecked;
  if (someChecked) selectAll.indeterminate = true;

  // ソート可能なヘッダセル。クリックで same key なら方向反転、他キーは
  // そのキーで desc に初期化。インジケータ ▲▼ を末尾に表示。
  const sortHead = (label: string, key: InboxSortKey, extraStyle = ''): HTMLElement => {
    const isActive = inboxSort.by === key;
    const arrow = isActive ? (inboxSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      style: `cursor:pointer;user-select:none;${extraStyle};${isActive ? 'color:var(--ink)' : ''}`,
      title: 'クリックでソート (再クリックで昇順/降順を切替)',
      onclick: () => {
        if (inboxSort.by === key) {
          inboxSort.dir = inboxSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          inboxSort.by = key;
          inboxSort.dir = key === 'date' ? 'desc' : 'asc';
        }
        setState({});
      },
    }, [label + arrow]);
  };
  const head = el('tr', {}, [
    el('th', { class: 'spira-tk-checkbox-cell', style: 'width:34px' }, [selectAll]),
    el('th', { style: 'width:24px' }),
    sortHead('件名', 'subject'),
    sortHead('送信者', 'from', 'width:240px'),
    sortHead('受信日時', 'date', 'width:140px'),
    el('th', { style: 'width:200px' }, ['操作']),
  ]);

  const tbody = el('tbody', {}, []);
  for (const m of mails) {
    tbody.appendChild(renderHeaderRow(m));
    if (expandedIds.has(m.id)) tbody.appendChild(renderExpandedRow(m));
  }

  const tableKey = 'inbox';
  const colKeys: (string | null)[] = [null, null, 'subject', 'from', 'date', null];
  const defaults = ['36px', '24px', '380px', '240px', '140px', '240px'];
  const widths = colKeys.map((k, i) => savedColWidth(tableKey, k, defaults[i]!));

  const table = el('table', { class: 'spira-tk-table spira-inbox-table', role: 'grid' }, [
    el('colgroup', {}, widths.map(w => el('col', { style: `width:${w}` }))),
    el('thead', {}, [head]),
    tbody,
  ]) as HTMLTableElement;

  setTimeout(() => attachColumnResize(table, { tableKey, colKeys }), 0);

  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('div', { class: 'spira-table-wrap' }, [table]),
  ]);
}

function renderHeaderRow(m: InboxMail): HTMLElement {
  const checkbox = el('input', { type: 'checkbox', 'aria-label': '選択' }) as HTMLInputElement;
  checkbox.checked = selectedInboxIds.has(m.id);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (checkbox.checked) selectedInboxIds.add(m.id);
    else selectedInboxIds.delete(m.id);
    setState({});
  });

  const isOpen = expandedIds.has(m.id);
  const arrow = el('span', {
    style: 'display:inline-block;color:var(--ink-3);font-size:var(--fs-xs);transition:transform .1s;transform:rotate(' + (isOpen ? '90' : '0') + 'deg)',
  }, ['▶']);

  const isHidden = !!m.isHidden;

  // ソース別バッジ — Forms / Teams 由来は件名先頭に小さなチップで識別。
  const sourceBadge = isFormsSource(m) ? el('span', {
    class: 'spira-badge',
    style: 'margin-right:var(--s-2);font-size:var(--fs-xs);background:rgba(160,90,140,0.14);color:#7c3a64;border-color:#a05a8c',
    title: 'Microsoft Forms から取り込まれた問い合わせ',
  }, ['📋 Forms'])
    : isTeamsSource(m) ? el('span', {
      class: 'spira-badge',
      style: 'margin-right:var(--s-2);font-size:var(--fs-xs);background:rgba(91,103,168,0.14);color:#3b4789;border-color:#5b67a8',
      title: 'Teams スレッドの返信 (チケット紐付け先が見つからず保留中)',
    }, ['💬 Teams'])
    : null;

  const subjectCell = el('td', { class: 'spira-tk-title', style: 'cursor:pointer' }, [
    isHidden ? el('span', {
      class: 'spira-badge spira-badge--muted',
      style: 'margin-right:var(--s-2);font-size:var(--fs-xs)',
    }, ['非表示']) : '',
    ...(sourceBadge ? [sourceBadge] : []),
    m.subject,
  ]);

  const actionBtns: HTMLElement[] = [
    el('button', {
      class: 'spira-btn spira-btn--primary spira-btn--sm',
      onclick: (e: Event) => { e.stopPropagation(); openNewTicketModal(m); },
    }, ['＋ 起票']),
    el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: (e: Event) => { e.stopPropagation(); openLinkModal(m); },
    }, ['⌬ 紐付け']),
  ];
  if (isHidden) {
    actionBtns.push(el('button', {
      class: 'spira-btn spira-btn--ghost spira-btn--sm',
      title: '一覧に再表示',
      onclick: async (e: Event) => {
        e.stopPropagation();
        try {
          await getRepo().unhideInboxItems([m.id]);
          toast(getRoot(), '再表示しました', 'ok');
          const fresh = await getRepo().listInbox({ unprocessedOnly: true });
          setState({ inboxCount: inboxRowsWithTag(fresh).length });
        } catch (err) {
          toast(getRoot(), `失敗: ${(err as Error).message}`, 'error');
        }
      },
    }, ['再表示']));
  } else {
    actionBtns.push(el('button', {
      class: 'spira-btn spira-btn--ghost spira-btn--sm',
      title: '一覧から非表示',
      onclick: async (e: Event) => {
        e.stopPropagation();
        try {
          await getRepo().hideInboxItems([m.id]);
          toast(getRoot(), '非表示にしました', 'ok');
          const fresh = await getRepo().listInbox({ unprocessedOnly: true });
          setState({ inboxCount: inboxRowsWithTag(fresh).length });
        } catch (err) {
          toast(getRoot(), `失敗: ${(err as Error).message}`, 'error');
        }
      },
    }, ['非表示']));
  }

  const tr = el('tr', {
    class: 'spira-tk-row' + (selectedInboxIds.has(m.id) ? ' selected' : '') + (isHidden ? ' spira-row-hidden' : ''),
    onclick: (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest('.spira-tk-checkbox-cell')) return;
      if (target.closest('.spira-inbox-actions')) return;
      if (expandedIds.has(m.id)) expandedIds.delete(m.id);
      else expandedIds.add(m.id);
      setState({});
    },
  }, [
    el('td', { class: 'spira-tk-checkbox-cell', onclick: (e: Event) => e.stopPropagation() }, [checkbox]),
    el('td', {}, [arrow]),
    subjectCell,
    el('td', {}, [`${m.fromName ?? ''} <${m.fromEmail}>`]),
    el('td', {}, [fmtDate(m.receivedAt)]),
    el('td', { class: 'spira-inbox-actions', style: 'display:flex;gap:var(--s-2)' }, actionBtns),
  ]);
  return tr;
}

function renderExpandedRow(m: InboxMail): HTMLElement {
  const previewBody = el('div', { class: 'spira-th-card-body', style: 'max-height:360px;overflow:auto' });
  renderMailBody(previewBody, m.bodyHtml, m.bodyText);

  const meta = (label: string, value: string | HTMLElement) =>
    el('div', { style: 'display:grid;grid-template-columns:120px 1fr;gap:var(--s-3);font-size:var(--fs-sm);padding:var(--s-1) 0' }, [
      el('span', { style: 'color:var(--ink-3)' }, [label]),
      typeof value === 'string' ? el('span', {}, [value]) : value,
    ]);

  const cell = el('td', { colspan: '6', style: 'background:var(--paper-2);padding:var(--s-5) var(--s-7)' }, [
    meta('差出人', `${m.fromName ?? ''} <${m.fromEmail}>`),
    meta('受信日時', fmtDate(m.receivedAt)),
    meta('件名', m.subject),
    meta('ConversationId', m.conversationId ?? '(なし)'),
    meta('添付', m.hasAttachments ? 'あり (OWA で確認)' : 'なし'),
    el('div', { style: 'margin-top:var(--s-3)' }, [previewBody]),
  ]);
  return el('tr', { class: 'spira-inbox-expanded' }, [cell]);
}

/** 新規チケット起票モーダル (統一版)。
 *  受信箱の「起票」ボタンと、サイドバーの「+新規チケット」ボタンの
 *  両方から呼ばれる。フィールド構成は履歴を追加と揃え、ソース別の
 *  挙動も同じ:
 *    - mail   : Outlook の件名をタイトル欄にドラッグ&ドロップで初期値設定
 *    - teams  : Teams チャットを本文欄にコピペ → 自動パース → 複数カード化
 *    - other  : 単発の手入力
 *  受信箱由来 (m.id > 0) の場合は mail ソース固定で、件名・本文・送信者
 *  などが事前入力される。 */
export function openNewTicketModal(m: InboxMail): void {
  type Source = 'mail' | 'forms' | 'teams' | 'other';
  const users = getState().users;
  const fromInbox = m.id > 0;

  // ---- 共通フィールド ---------------------------------------------------
  // PA フローで Subject に余分な空白・タブ・改行が混入することがある
  // (`[Forms] ` + 動的値の組立てや、HTML 入力モードでの貼付けが原因)。
  // 連続する空白系文字は単一スペースに圧縮し、前後を trim して表示。
  const cleanedSubject = (m.subject || '').replace(/[\s　]+/g, ' ').trim();
  const titleInput = el('input', {
    type: 'text', class: 'spira-input', value: cleanedSubject,
    placeholder: 'チケットの件名',
  }) as HTMLInputElement;

  // Outlook drag&drop:
  //   - Outlook for Mac: 件名ドラッグ時、本体は .eml ファイルとして
  //     DataTransfer.files に乗ってくる (text/plain は空のことが多い)。
  //   - Outlook for Windows: 状況により text/plain で件名のみ、または
  //     .msg/.eml ファイル。
  //   - Outlook Web (OWA): text/plain で件名行。
  // どのケースでも反映できるよう、files を優先 → text/plain にフォールバック
  // する handleEmlDrop を共有し、件名欄だけでなくモーダル全体 (grid) に
  // dragover/drop を貼って受け取れる範囲を広げる。
  const applyParsedEml = (parsed: ReturnType<typeof parseEml>): void => {
    // .eml が落ちてきたら、現在のソース選択に関わらず "mail" 固定にする
    // (Teams / その他 を選択中に Outlook ファイルを落とした場合の事故防止)。
    // .eml / .msg ドロップ時はメールとして取り込むのが妥当なので、現在の
    // ソース選択が mail でなければ mail に切り替える。
    if (sourceSel.value !== 'mail') {
      sourceSel.value = 'mail';
      sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (parsed.subject) {
      titleInput.value = parsed.subject.replace(/[\s　]+/g, ' ').trim();
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (parsed.fromName && !authorInput.value.trim()) {
      authorInput.value = parsed.fromName;
      authorInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (parsed.fromEmail && !authorEmailInput.value.trim()) {
      authorEmailInput.value = parsed.fromEmail;
    }
    if (parsed.dateISO) {
      // ISO は UTC なので、ローカル時刻に変換してから yyyy-MM-ddTHH:mm
      const d = new Date(parsed.dateISO);
      const pad = (n: number): string => String(n).padStart(2, '0');
      const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      dateTimePicker.setValueQuiet(local);
    }
    if (parsed.body && !bodyArea.value.trim()) {
      bodyArea.value = parsed.body;
      bodyArea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  // メール (.eml / .msg / Outlook ドラッグテキスト) を取り込む統一ハンドラ。
  // 優先順 (各段階で取得できれば return):
  //   1. .eml ファイル — RFC 822 を parseEml で解析
  //   2. .msg ファイル — Outlook 専用バイナリ。ブラウザでは解析不能なので
  //      ユーザに代替手順を案内。
  //   3. text/plain が RFC 822 風 → parseEml で解析
  //   4. text/plain が Outlook ヘッダ風 → parseOutlookDragText で解析
  //   5. text/plain (素のテキスト) → 最初の非空行を件名扱い
  //
  // textarea 上のテキストドロップは標準挙動 (テキスト貼付け) を尊重して
  // preventDefault しない。ただし*ファイル*ドロップは textarea 上でも
  // ブラウザがファイルを開く挙動を抑止するため必ず preventDefault する。
  const handleEmlDrop = async (e: DragEvent): Promise<void> => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files ?? []);
    const types = Array.from(dt.types ?? []);
    // デバッグ用: 何が来たかを console に残す (本番でもユーザが devtools
    // を開けば確認可能、PII は含まない)。
    console.debug('[spira/drop]', {
      fileCount: files.length,
      fileNames: files.map(f => `${f.name} (${f.type || '?'}, ${f.size}B)`),
      types,
    });
    // .eml ファイル — Mac Outlook 主経路 & Outlook 「.eml で保存」した結果
    const emlFile = files.find(f =>
      /\.eml$/i.test(f.name) || f.type === 'message/rfc822',
    );
    if (emlFile) {
      e.preventDefault();
      try {
        const text = await emlFile.text();
        applyParsedEml(parseEml(text));
        toast(getRoot(), `「${emlFile.name}」を取り込みました`, 'ok');
      } catch (err) {
        toast(getRoot(), `EML 読み取り失敗: ${(err as Error).message}`, 'error');
      }
      return;
    }
    // .msg ファイル — Outlook for Windows 主経路。@kenjiuno/msgreader で
    // CFB バイナリをデコードして件名/送信者/メアド/送信日時/本文を抽出。
    const msgFile = files.find(f =>
      /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook',
    );
    if (msgFile) {
      e.preventDefault();
      try {
        const parsed = await parseMsgFile(msgFile);
        console.debug('[spira/drop] parseMsgFile result:', {
          subject: parsed.subject,
          fromName: parsed.fromName,
          fromEmail: parsed.fromEmail,
          dateISO: parsed.dateISO,
          bodyLen: parsed.body?.length ?? 0,
        });
        applyParsedEml(parsed);
        toast(getRoot(), `「${msgFile.name}」を取り込みました`, 'ok');
        return;
      } catch (err) {
        console.warn('[spira/drop] parseMsgFile threw:', err);
        toast(getRoot(), `.msg 読み取り失敗: ${(err as Error).message} — text/plain にフォールバックします`, 'warn', 8000);
        // 失敗時は text/plain 経路へ流す (フォールバック)
        const stem = msgFile.name.replace(/\.[^.]+$/, '').trim();
        if (stem && !titleInput.value.trim()) {
          titleInput.value = stem;
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (files.length > 0) {
      // その他のファイル (画像等) — 未対応として通知して終了
      e.preventDefault();
      toast(getRoot(), `未対応のファイル形式: ${files[0]!.name}`, 'warn', 5000);
      return;
    }
    // ファイル以外の場合、textarea 上のドロップは標準挙動 (テキスト貼付け) を尊重
    // ただし .msg がある場合は preventDefault 済みなので textarea でも処理続行
    if (!msgFile && e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    const txt = dt.getData('text/plain') ?? '';
    const htmlTxt = dt.getData('text/html') ?? '';
    // 受信内容の冒頭を console に残す。本文流出を防ぐため 500 文字まで。
    console.debug('[spira/drop] text/plain head (500ch):', txt.slice(0, 500));
    if (htmlTxt) console.debug('[spira/drop] text/html length:', htmlTxt.length);
    if (!txt) {
      console.warn('[spira/drop] no text/plain, no files matched. types:', types);
      toast(getRoot(), 'ドロップされた内容を取り込めませんでした (text/plain も空)', 'warn');
      return;
    }
    if (looksLikeEml(txt)) {
      try { applyParsedEml(parseEml(txt)); return; } catch { /* fall through */ }
    }
    // Outlook for Windows のドラッグ: .eml 本体ではなく、From/Subject 等の
    // ヘッダ付きテキストだけ来る。looksLikeOutlookDrag で判定してパース。
    if (looksLikeOutlookDrag(txt)) {
      try {
        const parsed = parseOutlookDragText(txt);
        console.debug('[spira/drop] parseOutlookDragText result:', {
          subject: parsed.subject,
          fromName: parsed.fromName,
          fromEmail: parsed.fromEmail,
          dateISO: parsed.dateISO,
          bodyLen: parsed.body?.length ?? 0,
        });
        if (parsed.subject || parsed.fromName || parsed.fromEmail || parsed.body) {
          applyParsedEml(parsed);
          toast(getRoot(), 'Outlook ヘッダから取り込みました', 'ok');
          return;
        }
      } catch (err) {
        console.warn('[spira/drop] parseOutlookDragText threw:', err);
      }
    }
    // text/plain が件名のみ (旧来動作)
    const firstLine = txt.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0) ?? txt.trim();
    titleInput.value = firstLine;
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // dragover は無条件で preventDefault (=「ここに drop 可能」のシグナル)。
  // - target を限定すると、Outlook for Mac の NSFilePromise ベースの
  //   ドラッグで `dataTransfer.types` に 'Files' が出ない / textarea
  //   フォーカス後に target が変わる、などのケースで accept が外れる。
  // - dragover の preventDefault は「ここに drop してよい」の合図だけで、
  //   実際の drop 時の標準挙動 (textarea へのテキスト挿入) には影響しない
  //   (それは drop イベントの preventDefault で個別に判断)。
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  // ソース選択 — 受信箱由来 (Forms / Teams / 通常メール) を判定して初期値を
  // 設定するが、ユーザは自由に変更可能 (誤判定や手動修正のため)。
  const inferInitialSource = (): 'mail' | 'forms' | 'teams' | 'other' => {
    if (!fromInbox) return 'other';
    if (isFormsSource(m)) return 'forms';
    if (isTeamsSource(m)) return 'teams';
    return 'mail';
  };
  const initialSrc = inferInitialSource();
  const sourceSel = el('select', { class: 'spira-input', style: 'width:200px;min-width:0' }, [
    el('option', { value: 'mail',  ...(initialSrc === 'mail'  ? { selected: 'selected' } : {}) }, ['メール']),
    el('option', { value: 'forms', ...(initialSrc === 'forms' ? { selected: 'selected' } : {}) }, ['Forms']),
    el('option', { value: 'teams', ...(initialSrc === 'teams' ? { selected: 'selected' } : {}) }, ['Teams']),
    el('option', { value: 'other', ...(initialSrc === 'other' ? { selected: 'selected' } : {}) }, ['その他']),
  ]) as HTMLSelectElement;

  // 送信者
  const authorInput = el('input', {
    type: 'text', class: 'spira-input',
    value: m.fromName ?? '',
    placeholder: '送信者名 (任意)',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const authorEmailInput = el('input', {
    type: 'email', class: 'spira-input',
    value: m.fromEmail ?? '',
    placeholder: 'メールアドレス (任意)',
    autocomplete: 'off',
  }) as HTMLInputElement;

  // 送信時間 — Date オブジェクトを渡すと createDateTime が local 時間 (JST 等)
  // の getter で各セグメントに展開してくれる。文字列で渡すと UTC のままに
  // なるので必ず Date 経由で。受信メールがあればその sentAt/receivedAt を
  // ベースに、なければ現在時刻 (JST) を初期値にする。
  const sentInitial = m.sentAt ?? m.receivedAt;
  const dateTimePicker = createDateTime({
    initial: sentInitial ? new Date(sentInitial) : new Date(),
  });

  // 本文 textarea (Teams/mail/other 共通)
  const bodyArea = el('textarea', {
    class: 'spira-input',
    rows: '10',
    style: 'width:100%;font:13px/1.55 ui-monospace,Menlo,monospace;resize:vertical',
    placeholder: 'メール本文 / Teams コピペ / 手入力',
  }) as HTMLTextAreaElement;
  if (fromInbox) {
    // PA が BodyHtml だけ書き込んで BodyText を空にしているケース
    // (特に Forms 経由) があるため、bodyText が空なら bodyHtml を
    // タグ剥がしして textarea に入れる。
    const initialText = (m.bodyText && m.bodyText.trim())
      ? m.bodyText
      : (m.bodyHtml ? htmlToPlainText(m.bodyHtml) : '');
    bodyArea.value = initialText;
  }

  // Teams ソース時のパース結果プレビュー
  const previewLine = el('div', {
    style: 'font-size:var(--fs-xs);color:var(--ink-3);min-height:1.4em',
  });
  const alertBanner = el('div', {
    style: [
      'display:none', 'background:#fef3c7', 'border:1px solid #f59e0b',
      'color:#78350f', 'border-radius:var(--r-2)', 'padding:var(--s-2) var(--s-3)',
      'font-size:var(--fs-sm)', 'line-height:1.6', 'white-space:pre-line',
    ].join(';'),
  });
  const showAlert = (s: string): void => { alertBanner.textContent = s; alertBanner.style.display = 'block'; };
  const hideAlert = (): void => { alertBanner.textContent = ''; alertBanner.style.display = 'none'; };

  const currentBaseDate = (): Date => {
    const v = dateTimePicker.getValue();
    const mm = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (mm) return new Date(Number(mm[1]), Number(mm[2]!) - 1, Number(mm[3]!), 0, 0, 0);
    return new Date();
  };
  const currentLeadingTime = (): string => {
    const v = dateTimePicker.getValue();
    const mm = v.match(/T(\d{2}):(\d{2})$/);
    return mm ? `${mm[1]}:${mm[2]}` : '';
  };

  const updatePreview = (): void => {
    const src = sourceSel.value as Source;
    if (src !== 'teams') { previewLine.textContent = ''; hideAlert(); return; }
    const raw = bodyArea.value.trim();
    if (!raw) { previewLine.textContent = ''; hideAlert(); return; }
    const leadingAuthor = authorInput.value.trim();
    const orphan = detectLeadingOrphan(bodyArea.value);
    const msgs = parseTeamsPaste(bodyArea.value, {
      leadingAuthor: orphan ? (leadingAuthor || '(不明)') : leadingAuthor,
      leadingTime: currentLeadingTime(),
    });
    if (msgs.length === 0) {
      previewLine.textContent = '';
      showAlert('送信者を検出できませんでした。\nコピー範囲に送信者名・時刻ヘッダが含まれているか確認してください。');
      return;
    }
    hideAlert();
    previewLine.textContent = `抽出: ${msgs.length} 件 (起票時に履歴として登録されます)`;
  };

  bodyArea.addEventListener('input', updatePreview);
  authorInput.addEventListener('input', updatePreview);
  sourceSel.addEventListener('change', () => {
    const src = sourceSel.value as Source;
    if (src === 'teams') {
      authorInput.placeholder = '先頭メッセージの送信者 (Teams の仕様で取得できないため手入力)';
      bodyArea.placeholder = 'Teams で右クリック→コピーしたチャットを貼り付け';
    } else {
      authorInput.placeholder = '送信者名 (任意)';
      bodyArea.placeholder =
        src === 'mail'  ? 'メール本文' :
        src === 'forms' ? 'Forms 応答の本文 (HTML or テキスト)' :
        '本文 / メモ';
    }
    updatePreview();
  });

  // ---- メタデータ -------------------------------------------------------
  const statusSel = el('select', { class: 'spira-input', style: 'width:100%' },
    ticketStatusList().map(v => el('option', { value: v, selected: v === '新規' }, [v]))) as HTMLSelectElement;
  // 優先度の初期値: Forms 経由なら応答値から抽出、それ以外は Medium。
  // (このセレクト要素の生成タイミングでは initialFormsPriority がまだ
  //  宣言されていないので、生成後に setTimeout で反映する流れにせず、
  //  Medium をデフォルトにしておき、後段で値を上書きする。)
  const prioSel = el('select', { class: 'spira-input', style: 'width:100%' },
    priorityList().map(v => el('option', { value: v, selected: v === 'Medium' }, [v]))) as HTMLSelectElement;
  const assigneePicker = createAssigneePicker({ users, initial: [] });
  const dueInput = el('input', { type: 'date', class: 'spira-input', style: 'width:100%' }) as HTMLInputElement;

  // 部門 / 問い合わせ種別の <select>。初期は空、非同期で選択肢を流し込む。
  // Forms 経由の場合は BodyHtml から「カテゴリ:」値を抽出して初期選択。
  const deptSel = el('select', { class: 'spira-input', style: 'width:100%' }, [
    el('option', { value: '' }, ['(未設定)']),
  ]) as HTMLSelectElement;
  const categorySel = el('select', { class: 'spira-input', style: 'width:100%' }, [
    el('option', { value: '' }, ['(未設定)']),
  ]) as HTMLSelectElement;

  // Forms 経由のメール本文から特定ラベル (カテゴリ / 優先度 等) の値を抽出。
  // BodyHtml の `<strong>カテゴリ:</strong> <value></p>` 形式と
  // BodyText の `カテゴリ: <value>` 形式の両方に対応。
  const extractFormsField = (mm: InboxMail, label: string): string | undefined => {
    if (!mm.conversationId?.startsWith('forms-')) return undefined;
    const candidates: string[] = [];
    if (mm.bodyText) candidates.push(mm.bodyText);
    if (mm.bodyHtml) {
      const stripped = mm.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      candidates.push(stripped);
    }
    const re = new RegExp(`${label}\\s*[::]\\s*([^\\n<]+?)(?:\\s{2,}|<|\\n|$)`);
    for (const txt of candidates) {
      const mm2 = txt.match(re);
      if (mm2 && mm2[1]) return mm2[1].trim();
    }
    return undefined;
  };
  const initialFormsCategory = extractFormsField(m, 'カテゴリ');

  // 優先度の自動マッピング:
  //   Forms 応答は "High（業務が停止している / 緊急対応が必要）" のような
  //   長い文字列で返ってくる場合がある。先頭の High / Medium / Low を
  //   切り出して Spira の Priority enum に揃える。
  const extractFormsPriority = (mm: InboxMail): Priority | undefined => {
    const raw = extractFormsField(mm, '優先度');
    if (!raw) return undefined;
    const head = raw.match(/^\s*(High|Medium|Low)/i);
    if (!head) return undefined;
    const norm = head[1]!.charAt(0).toUpperCase() + head[1]!.slice(1).toLowerCase();
    if (norm === 'High' || norm === 'Medium' || norm === 'Low') return norm as Priority;
    return undefined;
  };
  const initialFormsPriority = extractFormsPriority(m);
  if (initialFormsPriority) prioSel.value = initialFormsPriority;

  // 非同期で選択肢を取得 → select に追加
  void Promise.all([getDepartmentOptions(), getInquiryCategoryOptions()])
    .then(([depts, cats]) => {
      for (const d of depts) deptSel.appendChild(el('option', { value: d }, [d]));
      for (const c of cats) categorySel.appendChild(el('option', { value: c }, [c]));
      // Forms カテゴリ自動マッピング
      if (initialFormsCategory) {
        if (cats.includes(initialFormsCategory)) {
          categorySel.value = initialFormsCategory;
        } else {
          // 一致しない場合は応答値をそのまま追加して選択
          categorySel.appendChild(el('option', { value: initialFormsCategory, selected: true }, [`${initialFormsCategory} (フォーム値)`]));
          categorySel.value = initialFormsCategory;
        }
      }
    });

  // 受信箱由来 → メール HTML プレビューを参考表示 (textarea とは独立)
  const previewBody = el('div', { class: 'spira-th-card-body' });
  if (fromInbox) renderMailBody(previewBody, m.bodyHtml, m.bodyText);

  // ---- 2 列グリッドレイアウト (履歴追加と同形式) -----------------------
  const LABEL_STYLE =
    'color:var(--ink-3);font-size:var(--fs-sm);' +
    'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
  const LABEL_TOP_STYLE = LABEL_STYLE + ';align-self:start;padding-top:8px';

  const bodyCell = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2)' }, [
    alertBanner,
    bodyArea,
    previewLine,
  ]);

  const authorCell = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3)' }, [
    authorInput,
    authorEmailInput,
  ]);

  const grid = el('div', {
    style:
      'display:grid;grid-template-columns:96px minmax(0,1fr);' +
      'gap:var(--s-3) var(--s-4);align-items:center;max-height:70vh;overflow-y:auto',
  }, [
    // 件名
    el('label', { style: LABEL_STYLE }, ['件名']),
    titleInput,
    // ソース
    el('label', { style: LABEL_STYLE }, ['ソース']),
    sourceSel,
    // 送信時間
    el('label', { style: LABEL_STYLE }, ['送信時間']),
    dateTimePicker.el,
    // 送信者 (名前 + メール)
    el('label', { style: LABEL_STYLE }, ['送信者']),
    authorCell,
    // 本文
    el('label', { style: LABEL_TOP_STYLE }, ['本文']),
    bodyCell,
    // メタ情報セクション区切り
    el('div', {
      style: 'grid-column:1 / -1;font-size:var(--fs-sm);font-weight:600;color:var(--ink);' +
             'border-top:1px solid var(--line);padding-top:var(--s-3);margin-top:var(--s-2)',
    }, ['チケット属性']),
    el('label', { style: LABEL_STYLE }, ['ステータス']), statusSel,
    el('label', { style: LABEL_STYLE }, ['優先度']),    prioSel,
    el('label', { style: LABEL_STYLE }, ['担当者']),    assigneePicker.el,
    el('label', { style: LABEL_STYLE }, ['期限']),      dueInput,
    el('label', { style: LABEL_STYLE }, ['部門']),      deptSel,
    el('label', { style: LABEL_STYLE }, ['種別']),      categorySel,
    // プレビュー (受信箱由来の HTML 本文)
    ...(fromInbox ? [
      el('div', {
        style: 'grid-column:1 / -1;font-size:var(--fs-sm);font-weight:600;color:var(--ink);' +
               'border-top:1px solid var(--line);padding-top:var(--s-3);margin-top:var(--s-2)',
      }, ['メールプレビュー (HTML 本文)']),
      el('div', {
        style: 'grid-column:1 / -1;max-height:200px;overflow:auto;border:1px solid var(--line);' +
               'border-radius:var(--r-2);padding:var(--s-3);background:var(--paper)',
      }, [previewBody]),
    ] : []),
    // フッターヒント (ソース別)
    el('div', {
      style: 'grid-column:1 / -1;font-size:var(--fs-xs);color:var(--ink-3);' +
             'background:var(--paper-2);padding:var(--s-3);border-radius:var(--r-2);' +
             'line-height:1.6;margin-top:var(--s-2)',
    }, [
      '※ ',
      el('b', {}, ['メール']),
      ': Outlook のメールをこのモーダルにドラッグ&ドロップすると、件名・送信者・送信日時・本文を自動取り込みします (.eml ファイル / 件名行のどちらも対応)。',
      el('br'),
      '※ ',
      el('b', {}, ['Teams']),
      ': チャット範囲選択 → 右クリック → コピー → 本文欄に貼り付けで複数メッセージを履歴として一括登録。',
      el('br'),
      '※ 起票後、本文は「履歴」カードとしてチケットに紐付きます。',
    ]),
  ]);

  // モーダル全体で .eml ファイル / 件名テキストのドロップを受け取れるよう、
  // grid レベルに dragover/drop を貼る。capture フェーズで登録して、textarea
  // など子要素の intrinsic な処理より先に preventDefault できるようにする。
  grid.addEventListener('dragover', handleDragOver, { capture: true });
  grid.addEventListener('drop', (e) => { void handleEmlDrop(e); }, { capture: true });

  // 初期 placeholder
  sourceSel.dispatchEvent(new Event('change'));

  // 重複起票チェックの 2-click 確認フラグ。ユーザが確認モーダルで
  // 「重複しても起票」を押した後、もう一度「起票」をクリックすると
  // dup チェックを skip して登録が進む。
  let pendingDupOk = false;

  openModal(getRoot(), {
    title: '新規チケットを起票',
    body: grid,
    size: 'lg',
    primaryLabel: '起票',
    primaryVariant: 'primary',
    onPrimary: async () => {
      const repo = getRepo();
      const src = sourceSel.value as Source;

      // A: 受信箱由来の起票では、保存直前に IsProcessed を再フェッチ。
      // 他ユーザー / 同一ユーザーの並行操作で先に起票済みになっていれば、
      // 二重起票を防いでチケットへ誘導する。
      if (fromInbox) {
        try {
          const fresh = await repo.getInboxItem(m.id);
          if (fresh == null) {
            toast(getRoot(), 'この受信メールはすでに削除されています', 'warn', 6000);
            throw new Error('inbox-already-removed');
          }
          if (fresh.isProcessed && fresh.ticketId) {
            toast(getRoot(),
              `他のユーザーが既に起票しています (チケット #${fresh.ticketId})`,
              'warn', 6000);
            // チケット詳細へ誘導
            setState({ selectedTicketId: fresh.ticketId });
            throw new Error('inbox-already-processed');
          }
        } catch (e) {
          // 再チェック自体が失敗した場合 (ネットワーク等) は警告だけ出して継続。
          // 重大なエラーは throw して保存をブロック。
          const msg = (e as Error).message;
          if (msg === 'inbox-already-processed' || msg === 'inbox-already-removed') throw e;
          console.warn('[spira] IsProcessed 再チェック失敗 (起票継続):', msg);
        }
      }

      const title = titleInput.value.trim() || m.subject || '(無題)';
      const fromName = authorInput.value.trim() || undefined;
      const fromEmail = authorEmailInput.value.trim() || undefined;
      const baseDate = currentBaseDate();
      const baseISO = (() => {
        const v = dateTimePicker.getValue();
        if (v.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)) return new Date(v).toISOString();
        return new Date().toISOString();
      })();

      try {
        // 受信箱由来 / 手動入力どちらでも、同じ送信者・送信時刻の既存
        // チケットがあれば確認モーダルを出す。pendingDupOk フラグでもう
        // 一度「起票」を押せば重複してもそのまま登録される 2-click 確認。
        // pendingDupOk フラグはこの try ブロックの外 (modal 全体) で持つ
        // ためにクロージャの外で定義済み。
        if (!pendingDupOk) {
          const dupQuery = fromInbox
            ? {
                fromEmail: m.fromEmail,
                fromName: m.fromName,
                sentISO: m.sentAt ?? m.receivedAt,
                internetMessageId: m.internetMessageId,
              }
            : {
                fromEmail,
                fromName,
                sentISO: baseISO,
              };
          const dup = await findDuplicateTicket(dupQuery);
          if (dup) {
            const idShort = formatTicketIdShort(dup.ticket.id);
            confirmModal(getRoot(), {
              title: '同じ送信者・送信時刻のチケットが存在します',
              message:
                `${idShort} 「${dup.ticket.title}」\n` +
                `(${dup.reason})\n\n` +
                'すでに同じ送信者・送信時刻で登録済みです。\n' +
                '「重複しても起票」を押すと、もう一度「起票」ボタンを\n' +
                'クリックすることで重複登録できます。',
              primaryLabel: '重複しても起票',
              primaryVariant: 'danger',
              onConfirm: () => {
                pendingDupOk = true; // 次の「起票」クリックで dup チェックを skip
                toast(getRoot(),
                  '重複登録モードに切り替えました。もう一度「起票」をクリックしてください',
                  'warn', 6000);
              },
            });
            // outer modal は開いたまま。ユーザは確認 modal で OK → 再度「起票」
            // ボタンを押して登録、または直接モーダル閉じて中止。
            throw new Error('pending-duplicate-confirm');
          }
        }
        pendingDupOk = false; // 通常パスに戻すリセット (再利用時のため)

        // チケット作成 — Description には初期本文の plain text 版を入れる。
        // 一覧の Description 列が空にならないように。HTML メール (fromInbox の
        // bodyHtml) は plain text 部分 (bodyText) を優先。長文は安全のため
        // 4000 文字でクリップ (SP の Note 列は問題ないが、リスト表示の
        // パフォーマンスを考慮)。
        const descriptionRaw = (fromInbox && m.bodyText)
          ? m.bodyText
          : bodyArea.value;
        const description = descriptionRaw.trim().slice(0, 4000) || undefined;
        const t = await repo.createTicket({
          title,
          description,
          status: statusSel.value as TicketStatus,
          priority: prioSel.value as Priority,
          assigneeEmails: assigneePicker.getValue().emails.length > 0 ? assigneePicker.getValue().emails : undefined,
          department: deptSel.value || undefined,
          inquiryCategory: categorySel.value || undefined,
          reporterEmail: fromEmail,
          reporterName: fromName,
          dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined,
          rawSubject: m.subject || undefined,
          initialConversationId: m.conversationId,
          source: src,
        });

        // ソース別: 初期履歴コメントを追加
        if (src === 'teams') {
          const leadingAuthor = authorInput.value.trim();
          const leadingTime = currentLeadingTime();
          const orphan = detectLeadingOrphan(bodyArea.value);
          const msgs = parseTeamsPaste(bodyArea.value, {
            leadingAuthor: orphan ? (leadingAuthor || ' UNKNOWN') : leadingAuthor,
            leadingTime,
          });
          for (const mm of msgs) if (mm.author === ' UNKNOWN') mm.author = '';
          for (let i = 0; i < msgs.length; i++) {
            const mm = msgs[i]!;
            try {
              await repo.addComment({
                ticketId: t.id, type: 'received',
                fromName: mm.author,
                content: mm.body, isHtml: false,
                sentAt: resolveTeamsTimeToISO(mm.time, baseDate, i),
                source: 'teams',
              });
            } catch (e) {
              console.warn('[spira] addComment failed for teams message:', e);
            }
          }
        } else if (src === 'mail' || src === 'forms') {
          // mail / forms どちらも HTML 本文をそのまま履歴として登録する流れ。
          // 受信箱由来 (PA 経由) なら m.bodyHtml をそのまま、手動入力時は textarea を採用。
          // Forms は顧客からの不具合問い合わせ専用 (内部 Forms 運用は無し) なので
          // 明示的に外部スレッドへ振り分ける。mail も同じく外部扱い。
          const content = fromInbox ? (m.bodyHtml || m.bodyText) : bodyArea.value;
          const isHtml = fromInbox ? !!m.bodyHtml : false;
          if (content.trim()) {
            await repo.addComment({
              ticketId: t.id, type: 'received',
              fromEmail, fromName,
              content, isHtml,
              sentAt: fromInbox ? (m.sentAt ?? m.receivedAt) : baseISO,
              sourceEmailId: fromInbox ? m.id : undefined,
              hasAttachments: fromInbox ? m.hasAttachments : undefined,
              internetMessageId: fromInbox ? m.internetMessageId : undefined,
              source: src,
              threadKind: 'external',
            });
          }
        } else {
          // other: 本文があれば 1 件登録
          const content = bodyArea.value.trim();
          if (content) {
            await repo.addComment({
              ticketId: t.id, type: 'received',
              fromEmail, fromName: fromName ?? '(履歴)',
              content, isHtml: false,
              sentAt: baseISO,
              source: 'other',
            });
          }
        }

        if (fromInbox) {
          await repo.markInboxProcessed(m.id, { ticketId: t.id, result: 'created' });
        }
        toast(getRoot(), `${formatTicketIdShort(t.id)} を起票しました`, 'ok');
        const inboxCount = fromInbox ? Math.max(0, getState().inboxCount - 1) : getState().inboxCount;
        const open = getState().openTicketIds;
        setState({
          view: 'tickets',
          selectedTicketId: t.id,
          openTicketIds: open.includes(t.id) ? open : [...open, t.id],
          inboxCount,
        });
      } catch (e) {
        const msg = (e as Error).message;
        // pending-duplicate-confirm は確認モーダル表示用の意図的な throw。
        // toast は出さず、外側 modal を開いたまま再 throw する。
        if (msg === 'pending-duplicate-confirm') throw e;
        toast(getRoot(), `起票に失敗: ${msg}`, 'error');
        throw e;
      }
    },
  });
}

export function openLinkModal(m: InboxMail): void {
  const queryInput = el('input', {
    type: 'search',
    class: 'spira-input',
    placeholder: '#001 や 件名で検索',
  }) as HTMLInputElement;
  const resultList = el('div', { style: 'max-height:280px;overflow:auto;border:1px solid var(--paper-3);border-radius:var(--r-2);min-height:120px' });

  let selectedId: number | null = null;
  let allTickets: { id: number; title: string; status: string }[] = [];

  function paint() {
    const q = queryInput.value.trim().toLowerCase();
    const filtered = q
      ? allTickets.filter(t => String(t.id).includes(q.replace(/^#/, '')) || t.title.toLowerCase().includes(q))
      : allTickets;
    clear(resultList);
    if (filtered.length === 0) {
      resultList.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-7)' }, ['該当するチケットがありません']));
      return;
    }
    for (const t of filtered.slice(0, 50)) {
      const item = el('div', {
        class: 'spira-menu-item',
        style: `padding:var(--s-3) var(--s-5);${selectedId === t.id ? 'background:var(--accent-soft)' : ''}`,
        onclick: () => { selectedId = t.id; paint(); },
      }, [
        el('span', { style: 'font-family:var(--font-mono);color:var(--ink-3);min-width:60px' }, [formatTicketIdShort(t.id)]),
        el('span', { style: 'flex:1' }, [t.title]),
        el('span', { class: 'spira-badge spira-badge--muted' }, [t.status]),
      ]);
      resultList.appendChild(item);
    }
  }

  resultList.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-7)' }, ['読み込み中...']));
  getRepo().listTickets().then(ts => {
    allTickets = ts.map(t => ({ id: t.id, title: t.title, status: t.status }));
    paint();
  }).catch(e => {
    clear(resultList);
    resultList.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-7);color:var(--danger)' }, [`読み込み失敗: ${e.message}`]));
  });

  queryInput.addEventListener('input', paint);

  const body = el('div', {}, [
    el('div', { class: 'spira-field' }, [
      el('label', { class: 'spira-field-label' }, [`${m.subject} を既存チケットに紐付け`]),
      queryInput,
    ]),
    resultList,
  ]);

  openModal(getRoot(), {
    title: '既存チケットに紐付け',
    body,
    primaryLabel: '紐付ける',
    onPrimary: async () => {
      if (selectedId == null) {
        toast(getRoot(), 'チケットを選択してください', 'warn');
        throw new Error('no selection');
      }
      try {
        const repo = getRepo();
        await repo.addComment({
          ticketId: selectedId, type: 'received',
          fromEmail: m.fromEmail, fromName: m.fromName,
          content: m.bodyHtml || m.bodyText, isHtml: !!m.bodyHtml,
          // Use sent time (with received-time fallback) to match the key
          // findDuplicateTicketForMail() compares against — otherwise a
          // later `+ 起票` on the same message can miss this ticket.
          sentAt: m.sentAt ?? m.receivedAt, sourceEmailId: m.id,
          hasAttachments: m.hasAttachments,
          internetMessageId: m.internetMessageId,
        });
        await repo.markInboxProcessed(m.id, { ticketId: selectedId, result: 'manual-linked' });
        toast(getRoot(), `${formatTicketIdShort(selectedId)} に紐付けました`, 'ok');
        const open = getState().openTicketIds;
        setState({
          view: 'tickets',
          selectedTicketId: selectedId,
          openTicketIds: open.includes(selectedId) ? open : [...open, selectedId],
          inboxCount: Math.max(0, getState().inboxCount - 1),
        });
      } catch (e) {
        toast(getRoot(), `紐付け失敗: ${(e as Error).message}`, 'error');
        throw e;
      }
    },
  });
}
