import { el, fmtDate, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { openModal, confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { attachColumnResize, savedColWidth } from '../utils/colResize';
import { formatTicketIdShort } from '../utils/ticketTag';
import type { InboxMail, TicketStatus, Priority, Ticket } from '../types';

/** Find an existing (non-deleted) ticket whose source mail matches this
 *  inbox mail — used to block duplicate ticket creation when PA delivered
 *  the same email twice (or the user clicks 起票 on an already-imported
 *  mail).
 *
 *  Match priority:
 *    1. internetMessageId — strongest signal, set by Outlook per-message.
 *    2. (fromEmail, sentAt) — what the user explicitly asked us to dedupe
 *       on. Comparing ISO timestamps as strings is fine; PA always emits
 *       the same shape.
 *
 *  N+1 cost: one listComments() per ticket. List size is small in
 *  practice; if it gets slow we can push the lookup into the repo with
 *  a server-side $filter on the Comments list. */
async function findDuplicateTicketForMail(m: InboxMail): Promise<Ticket | null> {
  if (!m.fromEmail && !m.internetMessageId) return null; // nothing reliable to match on
  const repo = getRepo();
  const tickets = await repo.listTickets();
  for (const t of tickets) {
    let comments;
    try { comments = await repo.listComments(t.id); }
    catch { continue; }
    for (const c of comments) {
      if (c.type !== 'received') continue;
      if (m.internetMessageId && c.internetMessageId &&
          c.internetMessageId === m.internetMessageId) {
        return t;
      }
      if (m.fromEmail && m.receivedAt &&
          c.fromEmail === m.fromEmail && c.sentAt === m.receivedAt) {
        return t;
      }
    }
  }
  return null;
}

const expandedIds = new Set<number>();
const selectedInboxIds = new Set<number>();

// Inbox-local filter — separate from ticket filter.
type InboxAttachFilter = '' | 'yes' | 'no';
interface InboxFilter { query: string; fromEmail: string; hasAttachments: InboxAttachFilter; includeHidden: boolean }
const inboxFilter: InboxFilter = { query: '', fromEmail: '', hasAttachments: '', includeHidden: false };

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}

export async function renderInbox(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const allMails = await getRepo().listInbox({ unprocessedOnly: true, includeHidden: inboxFilter.includeHidden });
  const filtered = applyInboxFilters(allMails);

  for (const id of Array.from(selectedInboxIds)) if (!filtered.find(m => m.id === id)) selectedInboxIds.delete(id);

  wrap.appendChild(renderSubBar(filtered.length));
  wrap.appendChild(renderToolbar(allMails));
  wrap.appendChild(renderList(filtered));
  return wrap;
}

function applyInboxFilters(rows: InboxMail[]): InboxMail[] {
  let out = rows;
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
      el('span', { class: 'spira-subbar-name' }, ['受信メール']),
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
        setState({ inboxCount: fresh.length });
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
          setState({ inboxCount: fresh.length });
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

  const head = el('tr', {}, [
    el('th', { class: 'spira-tk-checkbox-cell', style: 'width:34px' }, [selectAll]),
    el('th', { style: 'width:24px' }),
    el('th', {}, ['件名']),
    el('th', { style: 'width:240px' }, ['送信者']),
    el('th', { style: 'width:140px' }, ['受信日時']),
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

  const subjectCell = el('td', { class: 'spira-tk-title', style: 'cursor:pointer' }, [
    isHidden ? el('span', {
      class: 'spira-badge spira-badge--muted',
      style: 'margin-right:var(--s-2);font-size:var(--fs-xs)',
    }, ['非表示']) : '',
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
          setState({ inboxCount: fresh.length });
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
          setState({ inboxCount: fresh.length });
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
  if (m.bodyHtml) previewBody.innerHTML = sanitizeMailHtml(m.bodyHtml);
  else if (m.bodyText) {
    previewBody.style.whiteSpace = 'pre-wrap';
    previewBody.textContent = m.bodyText;
  } else {
    previewBody.textContent = '(本文なし)';
  }

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

export function openNewTicketModal(m: InboxMail): void {
  const users = getState().users;

  const titleInput = el('input', { type: 'text', class: 'spira-input', value: m.subject || '' }) as HTMLInputElement;
  const statusSel = el('select', { class: 'spira-select' }, ticketStatusList().map(v => el('option', { value: v, selected: v === '新規' }, [v]))) as HTMLSelectElement;
  const prioSel = el('select', { class: 'spira-select' }, priorityList().map(v => el('option', { value: v, selected: v === 'Medium' }, [v]))) as HTMLSelectElement;
  const assigneeSel = el('select', { class: 'spira-select' }, [
    el('option', { value: '' }, ['未割当']),
    ...users.map(u => el('option', { value: u.email }, [u.displayName])),
  ]) as HTMLSelectElement;
  const dueInput = el('input', { type: 'date', class: 'spira-input' }) as HTMLInputElement;

  const previewBody = el('div', { class: 'spira-th-card-body' });
  if (m.bodyHtml) previewBody.innerHTML = sanitizeMailHtml(m.bodyHtml);
  else previewBody.textContent = m.bodyText || '(本文なし)';

  const preview = m.id > 0
    ? el('div', { class: 'spira-th-card spira-th-card--received', style: 'max-height:240px;overflow:auto' }, [
        el('div', { class: 'spira-th-card-head' }, [
          el('span', { html: icon('mail') }),
          el('span', { class: 'spira-th-card-from' }, [m.fromName ?? m.fromEmail]),
          el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(m.receivedAt)]),
        ]),
        previewBody,
      ])
    : null;

  const body = el('div', {}, [
    ...(preview ? [el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['メールプレビュー']), preview])] : []),
    el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['タイトル']), titleInput]),
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:var(--s-5)' }, [
      el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['ステータス']), statusSel]),
      el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['優先度']), prioSel]),
      el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['担当者']), assigneeSel]),
      el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['期限']), dueInput]),
    ]),
  ]);

  openModal(getRoot(), {
    title: '新規チケットを起票',
    body,
    primaryLabel: '起票',
    primaryVariant: 'primary',
    onPrimary: async () => {
      const title = titleInput.value.trim() || m.subject || '(無題)';
      try {
        const repo = getRepo();
        // Pre-flight: refuse to create a duplicate ticket for the same
        // source mail. Same sender + same sent time (or matching
        // internetMessageId) → jump to the existing ticket instead.
        if (m.id > 0) {
          const dup = await findDuplicateTicketForMail(m);
          if (dup) {
            const idShort = formatTicketIdShort(dup.id);
            toast(
              getRoot(),
              `${idShort} 「${dup.title}」 が同じメール (送信者・送信時刻一致) ですでに起票済みです。そのチケットを開きます`,
              'warn',
              7000,
            );
            // Optionally also flag this inbox row processed against the
            // existing ticket so it stops appearing as un-triaged.
            try {
              await repo.markInboxProcessed(m.id, { ticketId: dup.id, result: 'auto-linked' });
            } catch { /* non-fatal */ }
            const open = getState().openTicketIds;
            setState({
              view: 'tickets',
              selectedTicketId: dup.id,
              openTicketIds: open.includes(dup.id) ? open : [...open, dup.id],
              inboxCount: Math.max(0, getState().inboxCount - 1),
            });
            return;
          }
        }
        const t = await repo.createTicket({
          title,
          status: statusSel.value as TicketStatus,
          priority: prioSel.value as Priority,
          assigneeEmail: assigneeSel.value || undefined,
          reporterEmail: m.fromEmail || undefined,
          reporterName: m.fromName,
          dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined,
          rawSubject: m.subject || undefined,
          initialConversationId: m.conversationId,
        });
        if (m.id > 0) {
          await repo.addComment({
            ticketId: t.id, type: 'received',
            fromEmail: m.fromEmail, fromName: m.fromName,
            content: m.bodyHtml || m.bodyText, isHtml: !!m.bodyHtml,
            sentAt: m.receivedAt, sourceEmailId: m.id,
            hasAttachments: m.hasAttachments,
          internetMessageId: m.internetMessageId,
          });
          await repo.markInboxProcessed(m.id, { ticketId: t.id, result: 'created' });
        }
        toast(getRoot(), `${formatTicketIdShort(t.id)} を起票しました`, 'ok');
        const inboxCount = m.id > 0 ? Math.max(0, getState().inboxCount - 1) : getState().inboxCount;
        const open = getState().openTicketIds;
        setState({
          view: 'tickets',
          selectedTicketId: t.id,
          openTicketIds: open.includes(t.id) ? open : [...open, t.id],
          inboxCount,
        });
      } catch (e) {
        toast(getRoot(), `起票に失敗: ${(e as Error).message}`, 'error');
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
          sentAt: m.receivedAt, sourceEmailId: m.id,
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
