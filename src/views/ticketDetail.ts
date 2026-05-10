import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import {
  getTicketMock,
  listCommentsMock,
  listSiteUsersMock,
  updateTicketMock,
  addCommentMock,
  softDeleteTicketMock,
} from '../api/mock';
import { ticketStatusList, priorityList } from '../api/sp';
import { setState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { renderStatusBadge, renderPriorityDot } from './ticketList';
import { toast } from '../components/toast';
import { confirmModal } from '../components/modal';
import type { Ticket, Comment } from '../types';

export function renderTicketDetail(ticketId: number): HTMLElement {
  const t = getTicketMock(ticketId);
  if (!t) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['チケットが見つかりません']),
        el('button', { class: 'spira-btn spira-btn--secondary', onclick: () => setState({ selectedTicketId: null }) }, ['一覧に戻る']),
      ]),
    ]);
  }

  return el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' }, [
    renderToolbar(t),
    el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-detail' }, [
        renderMainPane(t),
        renderRail(t),
      ]),
    ]),
  ]);
}

function renderToolbar(t: Ticket): HTMLElement {
  const idTag = `[#${String(t.id).padStart(3, '0')}]`;
  const copyBtn = el('button', {
    class: 'spira-detail-id-tag',
    title: '件名タグをコピー（返信時に件名へ貼り付け）',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(idTag);
        toast(getRoot(), `${idTag} をコピーしました`, 'ok');
      } catch {
        toast(getRoot(), 'コピーできませんでした', 'error');
      }
    },
  }, [el('span', { html: icon('copy') }), idTag]);

  const backBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: () => setState({ selectedTicketId: null }),
  }, ['← 一覧']);

  const owaBtn = el('a', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    href: '#', target: '_blank', rel: 'noopener',
    title: '元メールを Outlook で開く（MVP では未連携）',
  }, [el('span', { html: icon('external'), style: 'display:inline-flex;width:14px;height:14px' }), 'OWA で開く']);

  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--danger spira-btn--sm',
    onclick: () => {
      confirmModal(getRoot(), {
        title: 'チケットを削除',
        message: `#${String(t.id).padStart(3, '0')} 「${t.title}」 をゴミ箱に移動します。`,
        primaryLabel: '削除',
        primaryVariant: 'danger',
        onConfirm: () => {
          softDeleteTicketMock(t.id);
          toast(getRoot(), 'チケットをゴミ箱に移動しました', 'ok');
          setState({ selectedTicketId: null });
        },
      });
    },
  }, ['削除']);

  return el('div', { class: 'spira-toolbar' }, [
    backBtn,
    copyBtn,
    el('div', { class: 'spira-toolbar-spacer' }),
    owaBtn,
    deleteBtn,
  ]);
}

function renderMainPane(t: Ticket): HTMLElement {
  return el('div', { class: 'spira-detail-main' }, [
    renderHeader(t),
    renderThread(t),
    renderNoteInput(t),
  ]);
}

function renderHeader(t: Ticket): HTMLElement {
  const titleInput = el('input', {
    class: 'spira-detail-title-input',
    value: t.title,
    'aria-label': 'タイトル',
  }) as HTMLInputElement;
  titleInput.addEventListener('change', () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = t.title; return; }
    updateTicketMock(t.id, { title: v });
    toast(getRoot(), 'タイトルを更新しました', 'ok');
  });

  return el('div', { class: 'spira-detail-hd' }, [
    el('div', { class: 'spira-detail-hd-meta' }, [
      `起票: ${fmtDate(t.createdAt)}`,
      ' · ',
      `更新: ${fmtDate(t.updatedAt)}`,
      t.reporterName ? ` · 起票元: ${t.reporterName}` : '',
    ]),
    titleInput,
  ]);
}

function renderThread(t: Ticket): HTMLElement {
  const comments = listCommentsMock(t.id);
  const list = el('div', { class: 'spira-th-list', 'aria-label': 'スレッド' });
  if (comments.length === 0) {
    list.appendChild(el('div', { class: 'spira-empty' }, ['まだやり取りがありません']));
  } else {
    for (const c of comments) list.appendChild(renderCommentCard(c));
  }
  return list;
}

function renderCommentCard(c: Comment): HTMLElement {
  const isReceived = c.type === 'received';
  const head = el('div', { class: 'spira-th-card-head' }, [
    el('span', { html: icon(isReceived ? 'mail' : 'note') }),
    el('span', { class: 'spira-th-card-from' }, [
      c.fromName ?? c.fromEmail ?? '(unknown)',
    ]),
    isReceived && c.fromEmail ? ` <${c.fromEmail}>` : '',
    el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(c.sentAt)]),
  ]);
  const body = el('div', { class: 'spira-th-card-body' });
  if (c.isHtml) {
    body.innerHTML = sanitizeMailHtml(c.content);
  } else {
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = c.content;
  }
  return el('div', { class: `spira-th-card spira-th-card--${c.type}` }, [head, body]);
}

function renderNoteInput(t: Ticket): HTMLElement {
  const ta = el('textarea', {
    class: 'spira-textarea',
    placeholder: '内部メモを入力（チームメンバーのみ閲覧可）  Cmd/Ctrl + Enter で保存',
    rows: '3',
  }) as HTMLTextAreaElement;
  const saveBtn = el('button', {
    class: 'spira-btn spira-btn--primary',
    onclick: () => save(),
  }, ['メモを保存']);

  function save() {
    const v = ta.value.trim();
    if (!v) return;
    addCommentMock({
      ticketId: t.id,
      type: 'note',
      fromEmail: 'me@example.com',
      fromName: '自分',
      content: v,
      isHtml: false,
    });
    ta.value = '';
    toast(getRoot(), 'メモを保存しました', 'ok');
    setState({ /* trigger rerender */ });
  }

  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });

  return el('div', { class: 'spira-th-note-input', style: 'display:flex;flex-direction:column;gap:var(--s-3)' }, [
    ta,
    el('div', { style: 'display:flex;justify-content:flex-end' }, [saveBtn]),
  ]);
}

function renderRail(t: Ticket): HTMLElement {
  const users = listSiteUsersMock();

  const statusSel = el('select', { class: 'spira-select' }, [
    ...ticketStatusList().map(v => el('option', { value: v, selected: t.status === v }, [v])),
  ]) as HTMLSelectElement;
  statusSel.addEventListener('change', () => {
    updateTicketMock(t.id, { status: statusSel.value as Ticket['status'] });
    toast(getRoot(), 'ステータスを更新しました', 'ok');
    setState({});
  });

  const prioSel = el('select', { class: 'spira-select' }, [
    ...priorityList().map(v => el('option', { value: v, selected: t.priority === v }, [v])),
  ]) as HTMLSelectElement;
  prioSel.addEventListener('change', () => {
    updateTicketMock(t.id, { priority: prioSel.value as Ticket['priority'] });
    toast(getRoot(), '重要度を更新しました', 'ok');
    setState({});
  });

  const assigneeSel = el('select', { class: 'spira-select' }, [
    el('option', { value: '' }, ['未割当']),
    ...users.map(u => el('option', { value: u.email, selected: t.assigneeEmail === u.email }, [u.displayName])),
  ]) as HTMLSelectElement;
  assigneeSel.addEventListener('change', () => {
    updateTicketMock(t.id, { assigneeEmail: assigneeSel.value || undefined });
    toast(getRoot(), '担当者を更新しました', 'ok');
    setState({});
  });

  const dueInput = el('input', {
    type: 'date',
    class: 'spira-input',
    value: t.dueDate ? t.dueDate.slice(0, 10) : '',
  }) as HTMLInputElement;
  dueInput.addEventListener('change', () => {
    updateTicketMock(t.id, { dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined });
    toast(getRoot(), '期限を更新しました', 'ok');
    setState({});
  });

  return el('aside', { class: 'spira-detail-rail', 'aria-label': 'プロパティ' }, [
    el('div', { class: 'spira-prop-row' }, [
      el('span', { class: 'spira-prop-label' }, ['Status']),
      statusSel,
    ]),
    el('div', { class: 'spira-prop-row' }, [
      el('span', { class: 'spira-prop-label' }, ['Priority']),
      prioSel,
    ]),
    el('div', { class: 'spira-prop-row' }, [
      el('span', { class: 'spira-prop-label' }, ['担当者']),
      assigneeSel,
    ]),
    el('div', { class: 'spira-prop-row' }, [
      el('span', { class: 'spira-prop-label' }, ['期限']),
      dueInput,
    ]),
    el('div', { class: 'spira-prop-row' }, [
      el('span', { class: 'spira-prop-label' }, ['現在']),
      el('span', { class: 'spira-prop-value', style: 'display:flex;gap:var(--s-2);align-items:center' }, [
        renderStatusBadge(t.status), renderPriorityDot(t.priority),
      ]),
    ]),
  ]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.spira-root') ?? document.body;
}
