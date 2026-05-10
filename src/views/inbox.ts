import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import {
  listInboxMock, listTicketsMock, listSiteUsersMock,
  createTicketMock, addCommentMock, markInboxProcessedMock,
} from '../api/mock';
import { ticketStatusList, priorityList } from '../api/sp';
import { setState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import type { InboxMail, TicketStatus, Priority } from '../types';

export function renderInbox(): HTMLElement {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  wrap.appendChild(renderToolbar());
  wrap.appendChild(renderList());
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

function renderList(): HTMLElement {
  const mails = listInboxMock({ unprocessedOnly: true });
  if (mails.length === 0) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['未処理メールはありません']),
        el('div', {}, ['新しいメールが届いたら自動で取り込まれます']),
      ]),
    ]);
  }

  return el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('div', { class: 'spira-inbox-list' }, mails.map(m => renderRow(m))),
  ]);
}

function renderRow(m: InboxMail): HTMLElement {
  return el('div', { class: 'spira-inbox-row' }, [
    el('div', { class: 'spira-inbox-subject' }, [m.subject]),
    el('div', { class: 'spira-inbox-from' }, [`${m.fromName ?? ''} <${m.fromEmail}>`]),
    el('div', { class: 'spira-inbox-date' }, [fmtDate(m.receivedAt)]),
    el('div', { class: 'spira-inbox-actions' }, [
      el('button', {
        class: 'spira-btn spira-btn--primary spira-btn--sm',
        onclick: () => openNewTicketModal(m),
      }, ['＋ 起票']),
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: () => openLinkModal(m),
      }, ['⌬ 紐付け']),
    ]),
  ]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.spira-root') ?? document.body;
}

export function openNewTicketModal(m: InboxMail): void {
  const users = listSiteUsersMock();

  const titleInput = el('input', { type: 'text', class: 'spira-input', value: m.subject }) as HTMLInputElement;
  const statusSel = el('select', { class: 'spira-select' }, ticketStatusList().map(v => el('option', { value: v, selected: v === '新規' }, [v]))) as HTMLSelectElement;
  const prioSel = el('select', { class: 'spira-select' }, priorityList().map(v => el('option', { value: v, selected: v === 'Medium' }, [v]))) as HTMLSelectElement;
  const assigneeSel = el('select', { class: 'spira-select' }, [
    el('option', { value: '' }, ['未割当']),
    ...users.map(u => el('option', { value: u.email }, [u.displayName])),
  ]) as HTMLSelectElement;
  const dueInput = el('input', { type: 'date', class: 'spira-input' }) as HTMLInputElement;

  const preview = el('div', { class: 'spira-th-card spira-th-card--received', style: 'max-height:240px;overflow:auto' }, [
    el('div', { class: 'spira-th-card-head' }, [
      el('span', { html: icon('mail') }),
      el('span', { class: 'spira-th-card-from' }, [m.fromName ?? m.fromEmail]),
      el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(m.receivedAt)]),
    ]),
    (() => {
      const body = el('div', { class: 'spira-th-card-body' });
      body.innerHTML = sanitizeMailHtml(m.bodyHtml);
      return body;
    })(),
  ]);

  const body = el('div', {}, [
    el('div', { class: 'spira-field' }, [el('label', { class: 'spira-field-label' }, ['メールプレビュー']), preview]),
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
    onPrimary: () => {
      const t = createTicketMock({
        title: titleInput.value.trim() || m.subject,
        status: statusSel.value as TicketStatus,
        priority: prioSel.value as Priority,
        assigneeEmail: assigneeSel.value || undefined,
        reporterEmail: m.fromEmail,
        reporterName: m.fromName,
        dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined,
        rawSubject: m.subject,
        initialConversationId: m.conversationId,
      });
      addCommentMock({
        ticketId: t.id, type: 'received',
        fromEmail: m.fromEmail, fromName: m.fromName,
        content: m.bodyHtml, isHtml: true,
        sentAt: m.receivedAt, sourceEmailId: m.id,
      });
      markInboxProcessedMock(m.id, { ticketId: t.id, result: 'created' });
      toast(getRoot(), `#${String(t.id).padStart(3, '0')} を起票しました`, 'ok');
      setState({ view: 'tickets', selectedTicketId: t.id });
    },
  });
}

export function openLinkModal(m: InboxMail): void {
  const tickets = listTicketsMock();
  const queryInput = el('input', {
    type: 'search',
    class: 'spira-input',
    placeholder: '#001 や 件名で検索',
  }) as HTMLInputElement;
  const resultList = el('div', { style: 'max-height:280px;overflow:auto;border:1px solid var(--paper-3);border-radius:var(--r-2)' });

  let selectedId: number | null = null;

  function refresh() {
    const q = queryInput.value.trim().toLowerCase();
    const filtered = q
      ? tickets.filter(t => String(t.id).includes(q.replace(/^#/, '')) || t.title.toLowerCase().includes(q))
      : tickets;
    resultList.innerHTML = '';
    if (filtered.length === 0) {
      resultList.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-7)' }, ['該当するチケットがありません']));
      return;
    }
    for (const t of filtered.slice(0, 50)) {
      const item = el('div', {
        class: 'spira-menu-item',
        style: `padding:var(--s-3) var(--s-5);${selectedId === t.id ? 'background:var(--accent-soft)' : ''}`,
        onclick: () => { selectedId = t.id; refresh(); },
      }, [
        el('span', { style: 'font-family:var(--font-mono);color:var(--ink-3);min-width:60px' }, [`#${String(t.id).padStart(3, '0')}`]),
        el('span', { style: 'flex:1' }, [t.title]),
        el('span', { class: 'spira-badge spira-badge--muted' }, [t.status]),
      ]);
      resultList.appendChild(item);
    }
  }

  queryInput.addEventListener('input', refresh);
  refresh();

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
    onPrimary: () => {
      if (selectedId == null) {
        toast(getRoot(), 'チケットを選択してください', 'warn');
        throw new Error('no selection');
      }
      addCommentMock({
        ticketId: selectedId, type: 'received',
        fromEmail: m.fromEmail, fromName: m.fromName,
        content: m.bodyHtml, isHtml: true,
        sentAt: m.receivedAt, sourceEmailId: m.id,
      });
      markInboxProcessedMock(m.id, { ticketId: selectedId, result: 'manual-linked' });
      toast(getRoot(), `#${String(selectedId).padStart(3, '0')} に紐付けました`, 'ok');
      setState({ view: 'tickets', selectedTicketId: selectedId });
    },
  });
}
