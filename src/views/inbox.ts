import { el, fmtDate, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { openModal, confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import type { InboxMail, TicketStatus, Priority } from '../types';

const expandedIds = new Set<number>();
const selectedInboxIds = new Set<number>();

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}

export async function renderInbox(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const mails = await getRepo().listInbox({ unprocessedOnly: true });

  // prune selection of removed ids
  for (const id of Array.from(selectedInboxIds)) if (!mails.find(m => m.id === id)) selectedInboxIds.delete(id);

  wrap.appendChild(renderToolbar());
  if (selectedInboxIds.size > 0) wrap.appendChild(renderBulkBar(mails));
  wrap.appendChild(renderList(mails));
  return wrap;
}

function renderToolbar(): HTMLElement {
  return el('div', { class: 'spira-toolbar' }, [
    el('div', { style: 'font-weight:500;color:var(--ink);font-size:var(--fs-md)' }, ['未処理メール']),
    el('div', { class: 'spira-toolbar-spacer' }),
    el('button', {
      class: 'spira-iconbtn',
      'aria-label': '同期',
      title: '同期',
      'data-action': 'sync',
      html: icon('sync'),
    }),
  ]);
}

function renderBulkBar(allMails: InboxMail[]): HTMLElement {
  const count = selectedInboxIds.size;
  return el('div', { class: 'spira-bulkbar' }, [
    el('span', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, [`${count} 件選択中`]),
    el('div', { style: 'flex:1' }),
    el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: () => { selectedInboxIds.clear(); setState({}); },
    }, ['選択解除']),
    el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: () => {
        const ids = Array.from(selectedInboxIds);
        confirmModal(getRoot(), {
          title: 'まとめて非表示',
          message: `${count} 件を一覧から非表示にします。\n（チケット起票や紐付けは行いません。受信メールリスト上では IsHidden = true になります）`,
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
        void allMails;
      },
    }, [`${count} 件を非表示`]),
  ]);
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

  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('table', { class: 'spira-tk-table spira-inbox-table', role: 'grid' }, [
      el('thead', {}, [head]),
      tbody,
    ]),
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

  const tr = el('tr', {
    class: 'spira-tk-row' + (selectedInboxIds.has(m.id) ? ' selected' : ''),
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
    el('td', { class: 'spira-tk-title', style: 'cursor:pointer' }, [m.subject]),
    el('td', {}, [`${m.fromName ?? ''} <${m.fromEmail}>`]),
    el('td', {}, [fmtDate(m.receivedAt)]),
    el('td', { class: 'spira-inbox-actions', style: 'display:flex;gap:var(--s-2)' }, [
      el('button', {
        class: 'spira-btn spira-btn--primary spira-btn--sm',
        onclick: (e: Event) => { e.stopPropagation(); openNewTicketModal(m); },
      }, ['＋ 起票']),
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: (e: Event) => { e.stopPropagation(); openLinkModal(m); },
      }, ['⌬ 紐付け']),
      el('button', {
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
      }, ['非表示']),
    ]),
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
      el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['重要度']), prioSel]),
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
          });
          await repo.markInboxProcessed(m.id, { ticketId: t.id, result: 'created' });
        }
        toast(getRoot(), `#${String(t.id).padStart(3, '0')} を起票しました`, 'ok');
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
        el('span', { style: 'font-family:var(--font-mono);color:var(--ink-3);min-width:60px' }, [`#${String(t.id).padStart(3, '0')}`]),
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
        });
        await repo.markInboxProcessed(m.id, { ticketId: selectedId, result: 'manual-linked' });
        toast(getRoot(), `#${String(selectedId).padStart(3, '0')} に紐付けました`, 'ok');
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
