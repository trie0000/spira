import { el, fmtDate, clear } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { buildOwaReplyUrl, bodyWouldBeTruncated } from '../utils/owa';
import { isInternalMember, colorForAuthor } from '../utils/members';
import { renderStatusBadge, renderPriorityDot } from './ticketList';
import { toast } from '../components/toast';
import { confirmModal } from '../components/modal';
import type { Ticket, Comment } from '../types';

export async function renderTicketDetail(ticketId: number): Promise<HTMLElement> {
  const repo = getRepo();
  const [t, comments] = await Promise.all([
    repo.getTicket(ticketId),
    repo.listComments(ticketId),
  ]);
  if (!t) {
    return el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['チケットが見つかりません']),
        el('button', {
          class: 'spira-btn spira-btn--secondary',
          onclick: () => setState({ selectedTicketId: null }),
        }, ['一覧に戻る']),
      ]),
    ]);
  }

  const latestReceived = comments.filter(c => c.type === 'received').slice(-1)[0];

  return el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' }, [
    await renderTabStrip(t, latestReceived),
    renderTicketHeader(t),
    renderSplitPanes(t, comments),
  ]);
}

async function renderTabStrip(activeT: Ticket, latestReceived: Comment | undefined): Promise<HTMLElement> {
  const ids = getState().openTicketIds;
  const tickets = await Promise.all(ids.map(id => getRepo().getTicket(id)));

  const tabs: HTMLElement[] = [];
  ids.forEach((id, i) => {
    const t = tickets[i];
    if (!t) return;
    const isActive = id === activeT.id;
    const tab = el('div', {
      class: 'spira-tab' + (isActive ? ' active' : ''),
      onclick: () => setState({ selectedTicketId: id }),
      title: t.title,
    }, [
      el('span', { style: 'font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink-3);margin-right:6px' }, [`#${String(id).padStart(3, '0')}`]),
      el('span', { style: 'max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [t.title]),
      el('button', {
        type: 'button',
        class: 'spira-tab-close',
        'aria-label': '閉じる',
        onclick: (e: Event) => {
          e.stopPropagation();
          const remaining = getState().openTicketIds.filter(x => x !== id);
          let nextSelected: number | null = getState().selectedTicketId;
          if (id === nextSelected) {
            nextSelected = remaining.length > 0 ? remaining[remaining.length - 1] ?? null : null;
          }
          setState({ openTicketIds: remaining, selectedTicketId: nextSelected });
        },
      }, ['×']),
    ]);
    tabs.push(tab);
  });

  // Left zone: back to list — styled to match tab height
  const backBtn = el('div', {
    class: 'spira-tab spira-tab--back',
    role: 'button',
    tabindex: '0',
    onclick: () => setState({ selectedTicketId: null }),
  }, ['← 一覧']);

  // Right zone: actions (OWA で開く は削除済み — 返信時は OWA で返信 から)
  const replyBtn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    title: latestReceived
      ? 'OWA で返信ドラフトを開く（最新の受信メールを引用）'
      : '受信メールがないため返信を作成できません',
    disabled: !latestReceived,
    onclick: () => {
      if (!latestReceived) return;
      const url = buildOwaReplyUrl({ ticket: activeT, comment: latestReceived });
      if (bodyWouldBeTruncated({ ticket: activeT, comment: latestReceived })) {
        toast(getRoot(), '本文が長いため引用は省略されました', 'warn');
      }
      window.open(url, '_blank', 'noopener');
    },
  }, [
    el('span', { html: icon('mail'), style: 'display:inline-flex;width:14px;height:14px' }),
    'OWA で返信',
  ]);

  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--danger spira-btn--sm',
    onclick: () => {
      confirmModal(getRoot(), {
        title: 'チケットを削除',
        message: `#${String(activeT.id).padStart(3, '0')} 「${activeT.title}」 をゴミ箱に移動します。`,
        primaryLabel: '削除',
        primaryVariant: 'danger',
        onConfirm: async () => {
          try {
            await getRepo().softDeleteTicket(activeT.id);
            toast(getRoot(), 'チケットをゴミ箱に移動しました', 'ok');
            const remaining = getState().openTicketIds.filter(x => x !== activeT.id);
            const next = remaining.length > 0 ? remaining[remaining.length - 1] ?? null : null;
            setState({
              selectedTicketId: next,
              openTicketIds: remaining,
              trashCount: getState().trashCount + 1,
            });
          } catch (e) {
            toast(getRoot(), `削除に失敗: ${(e as Error).message}`, 'error');
          }
        },
      });
    },
  }, ['削除']);

  return el('div', { class: 'spira-tab-strip' }, [
    el('div', { class: 'spira-tab-left' }, [backBtn]),
    el('div', { class: 'spira-tab-middle' }, tabs),
    el('div', { class: 'spira-tab-right' }, [replyBtn, deleteBtn]),
  ]);
}

// (toolbar moved into the tab strip — see renderTabStrip above)

// ============================================================ ticket header (title + properties)

function renderTicketHeader(t: Ticket): HTMLElement {
  const users = getState().users;
  const idTag = `[#${String(t.id).padStart(3, '0')}]`;
  const idDisplay = `#${String(t.id).padStart(3, '0')}`;

  const idLabel = el('span', {
    class: 'spira-detail-id',
    title: 'クリックで件名タグをコピー (返信時に件名へ貼り付け)',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(idTag);
        toast(getRoot(), `${idTag} をコピーしました`, 'ok');
      } catch {
        toast(getRoot(), 'コピーできませんでした', 'error');
      }
    },
  }, [idDisplay]);

  const titleInput = el('input', {
    class: 'spira-detail-title-input',
    value: t.title,
    'aria-label': 'タイトル',
  }) as HTMLInputElement;
  titleInput.addEventListener('change', async () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = t.title; return; }
    try {
      await getRepo().updateTicket(t.id, { title: v });
      toast(getRoot(), 'タイトルを更新しました', 'ok');
    } catch (e) {
      titleInput.value = t.title;
      toast(getRoot(), `更新失敗: ${(e as Error).message}`, 'error');
    }
  });

  const statusSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:120px' },
    ticketStatusList().map(v => el('option', { value: v, selected: t.status === v }, [v]))
  ) as HTMLSelectElement;
  statusSel.addEventListener('change', () => updateField(t, { status: statusSel.value as Ticket['status'] }, 'ステータス'));

  const prioSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:120px' },
    priorityList().map(v => el('option', { value: v, selected: t.priority === v }, [v]))
  ) as HTMLSelectElement;
  prioSel.addEventListener('change', () => updateField(t, { priority: prioSel.value as Ticket['priority'] }, '重要度'));

  const assigneeSel = el('select', { class: 'spira-select', style: 'width:auto;min-width:160px' }, [
    el('option', { value: '' }, ['未割当']),
    ...users.map(u => el('option', { value: u.email, selected: t.assigneeEmail === u.email }, [u.displayName])),
  ]) as HTMLSelectElement;
  assigneeSel.addEventListener('change', () => updateField(t, {
    assigneeEmail: assigneeSel.value || undefined,
    assigneeName: users.find(u => u.email === assigneeSel.value)?.displayName,
  }, '担当者'));

  const dueInput = el('input', {
    type: 'date', class: 'spira-input',
    style: 'width:auto;min-width:140px',
    value: t.dueDate ? t.dueDate.slice(0, 10) : '',
  }) as HTMLInputElement;
  dueInput.addEventListener('change', () => updateField(t, {
    dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined,
  }, '期限'));

  return el('div', { class: 'spira-detail-hd-wrap' }, [
    el('div', { class: 'spira-detail-hd-meta', style: 'margin-bottom:var(--s-1)' }, [
      `起票: ${fmtDate(t.createdAt)}`, ' · ', `更新: ${fmtDate(t.updatedAt)}`,
      t.reporterName ? ` · 起票元: ${t.reporterName}` : '',
    ]),
    el('div', { class: 'spira-detail-title-row' }, [idLabel, titleInput]),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s-3);align-items:center;margin-top:var(--s-3)' }, [
      label('ステータス'), statusSel,
      label('重要度'), prioSel,
      label('担当者'), assigneeSel,
      label('期限'), dueInput,
      el('span', { style: 'margin-left:auto;display:inline-flex;gap:var(--s-2);align-items:center' }, [
        renderStatusBadge(t.status), renderPriorityDot(t.priority),
      ]),
    ]),
  ]);
}

function label(text: string): HTMLElement {
  return el('span', { class: 'spira-prop-label', style: 'font-size:var(--fs-sm)' }, [text]);
}

async function updateField(t: Ticket, patch: Partial<Ticket>, fieldLabel: string): Promise<void> {
  try {
    await getRepo().updateTicket(t.id, patch);
    toast(getRoot(), `${fieldLabel}を更新しました`, 'ok');
    setState({});
  } catch (e) {
    toast(getRoot(), `${fieldLabel}の更新に失敗: ${(e as Error).message}`, 'error');
  }
}

// ============================================================ split panes

const SPLIT_STORAGE_KEY = 'spira:split-left-w';
const SPLIT_DEFAULT = 0.5;
const SPLIT_MIN_PX = 280;

function renderSplitPanes(t: Ticket, comments: Comment[]): HTMLElement {
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');

  const leftPane = el('div', {
    class: 'spira-split-pane',
    'data-bg': 'paper',
    style: 'flex:1 1 50%;min-width:0;overflow:auto;padding:0 var(--s-7) var(--s-7);background:var(--paper)',
  }, [
    paneTitle('📧 メールスレッド', `${received.length} 件`),
    renderReceivedThread(t, received),
  ]);

  const rightPane = el('div', {
    class: 'spira-split-pane',
    'data-bg': 'paper-2',
    style: 'flex:1 1 50%;min-width:0;overflow:auto;padding:0 var(--s-7) var(--s-7);background:var(--paper-2)',
  }, [
    paneTitle('📝 内部メモ', `${notes.length} 件`),
    renderNotesPane(t, notes),
  ]);

  const resizer = el('div', {
    class: 'spira-split-resizer',
    'aria-label': '分割線をドラッグして幅変更',
    style: 'flex:0 0 6px;cursor:col-resize;background:var(--paper-3);transition:background 0.1s',
  });

  attachResizer(resizer, leftPane, rightPane);

  // restore stored split width (px). Apply after mount via initial flex-basis.
  try {
    const saved = parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY) ?? '');
    if (Number.isFinite(saved) && saved > 0 && saved < 1) {
      leftPane.style.flex = `0 0 ${(saved * 100).toFixed(2)}%`;
      rightPane.style.flex = '1 1 0';
    }
  } catch { /* ignore */ }

  const wrap = el('div', {
    class: 'spira-split',
    style: 'display:flex;flex:1;min-height:0;overflow:hidden;border-top:1px solid var(--line)',
  }, [leftPane, resizer, rightPane]);

  return wrap;
}

function paneTitle(title: string, sub: string): HTMLElement {
  return el('div', { class: 'spira-pane-title' }, [
    el('h3', { style: 'font-size:var(--fs-md);font-weight:600;color:var(--ink);margin:0' }, [title]),
    el('span', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' }, [sub]),
  ]);
}

// ============================================================ helpers

const expandedReceived = new Set<number>();
const expandedNotes = new Set<number>();

/** Attach a "詳細を表示 / 折りたたむ" toggle to a card body if needed.
 *  Uses inline styles so SP host CSS can never override the collapse height.
 *  Toggling happens in place — no setState round-trip. */
function attachCollapseToggle(
  card: HTMLElement,
  body: HTMLElement,
  id: number,
  expandedSet: Set<number>,
): void {
  const COLLAPSED_HEIGHT = '6em';

  const apply = () => {
    if (expandedSet.has(id)) {
      body.style.maxHeight = '';
      body.style.overflow = '';
    } else {
      body.style.maxHeight = COLLAPSED_HEIGHT;
      body.style.overflow = 'hidden';
    }
  };

  const toggle = el('button', {
    type: 'button',
    class: 'spira-th-toggle',
    onclick: (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (expandedSet.has(id)) expandedSet.delete(id);
      else expandedSet.add(id);
      apply();
      toggle.innerHTML = '';
      toggle.appendChild(toggleLabel(expandedSet.has(id)));
    },
  }, [toggleLabel(expandedSet.has(id))]);
  card.appendChild(toggle);

  // Apply collapse before mounting so the user never sees a flash of full height.
  apply();

  // After mount, hide the toggle if the body fits within the collapsed height.
  setTimeout(() => {
    if (!card.isConnected) return;
    const wasExpanded = expandedSet.has(id);
    body.style.maxHeight = '';
    body.style.overflow = '';
    const collapsedPx = parseFloat(getComputedStyle(body).fontSize) * 6;
    const realHeight = body.scrollHeight;
    if (realHeight <= collapsedPx + 8) {
      toggle.remove();
      return;
    }
    if (!wasExpanded) {
      body.style.maxHeight = COLLAPSED_HEIGHT;
      body.style.overflow = 'hidden';
    }
  }, 0);
}

function toggleLabel(isExpanded: boolean): HTMLElement {
  return el('span', {}, [
    el('span', { style: 'display:inline-block;width:10px;color:inherit;font-size:10px;margin-right:4px' }, [isExpanded ? '▲' : '▼']),
    isExpanded ? '折りたたむ' : '詳細を表示',
  ]);
}

/** Auto-grow a textarea with content, capped at maxRatio of viewport.
 *  Padding (including bottom-margin for the cursor) is controlled by CSS,
 *  not inline — so per-class overrides like .spira-note-input win. */
function autoSizeTextarea(ta: HTMLTextAreaElement, maxRatio = 0.55): void {
  const adjust = () => {
    ta.style.height = 'auto';
    const max = Math.max(120, Math.floor(window.innerHeight * maxRatio));
    const desired = Math.min(ta.scrollHeight, max);
    ta.style.height = `${desired}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', adjust);
  setTimeout(adjust, 0);
}

function attachResizer(resizer: HTMLElement, left: HTMLElement, right: HTMLElement): void {
  resizer.addEventListener('mouseenter', () => { resizer.style.background = 'var(--accent-soft)'; });
  resizer.addEventListener('mouseleave', () => { resizer.style.background = 'var(--paper-3)'; });
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const parent = resizer.parentElement!;
    const totalW = parent.clientWidth;
    const startLeftW = left.getBoundingClientRect().width;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.style.background = 'var(--accent)';

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      let newW = startLeftW + dx;
      newW = Math.max(SPLIT_MIN_PX, Math.min(newW, totalW - SPLIT_MIN_PX - 6));
      const ratio = newW / totalW;
      left.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
      right.style.flex = '1 1 0';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      resizer.style.background = 'var(--paper-3)';
      // persist ratio
      const w = left.getBoundingClientRect().width;
      const total = parent.clientWidth || 1;
      const ratio = w / total;
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(ratio)); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  // double-click to reset
  resizer.addEventListener('dblclick', () => {
    left.style.flex = `1 1 ${SPLIT_DEFAULT * 100}%`;
    right.style.flex = `1 1 ${(1 - SPLIT_DEFAULT) * 100}%`;
    try { localStorage.setItem(SPLIT_STORAGE_KEY, String(SPLIT_DEFAULT)); } catch { /* ignore */ }
  });
}

// ============================================================ left: received thread

function renderReceivedThread(t: Ticket, received: Comment[]): HTMLElement {
  if (received.length === 0) {
    return el('div', { class: 'spira-empty', style: 'padding:var(--s-7)' }, [
      'メールのやり取りはまだありません',
    ]);
  }
  return el('div', { class: 'spira-th-list' }, received.map(c => renderReceivedCard(t, c)));
}

function renderReceivedCard(_t: Ticket, c: Comment): HTMLElement {
  const internal = isInternalMember(c.fromEmail);

  const head = el('div', { class: 'spira-th-card-head', style: 'flex-wrap:wrap;gap:var(--s-2)' }, [
    el('span', { html: icon('mail') }),
    el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
    c.fromEmail ? el('span', { style: 'color:var(--ink-3)' }, [` <${c.fromEmail}>`]) : '',
    internal
      ? el('span', { class: 'spira-badge spira-badge--muted', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['内部'])
      : el('span', { class: 'spira-badge spira-badge--warn', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['外部']),
    el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(c.sentAt)]),
  ]);

  const body = el('div', { class: 'spira-th-card-body' });
  if (c.isHtml) body.innerHTML = sanitizeMailHtml(c.content);
  else { body.style.whiteSpace = 'pre-wrap'; body.textContent = c.content; }

  const card = el('div', {
    class: 'spira-th-card spira-th-card--received',
    'data-side': internal ? 'internal' : 'external',
  }, [head, body]);
  attachCollapseToggle(card, body, c.id, expandedReceived);
  return card;
}

// ============================================================ right: notes pane (editable)

function renderNotesPane(t: Ticket, notes: Comment[]): HTMLElement {
  const list = el('div', { class: 'spira-th-list' }, notes.length === 0
    ? [el('div', { class: 'spira-empty', style: 'padding:var(--s-5)' }, ['メモはまだありません'])]
    : notes.map(n => renderNoteCard(n))
  );
  return el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-5)' }, [
    list,
    renderNewNoteForm(t),
  ]);
}

function renderNoteCard(c: Comment): HTMLElement {
  const authorKey = (c.fromEmail ?? c.fromName ?? '').toLowerCase();
  const authorColor = colorForAuthor(authorKey);
  const card = el('div', {
    class: 'spira-th-card spira-th-card--note',
    'data-comment-id': String(c.id),
    style: `border-left-color: ${authorColor}`,
  });

  const onDelete = () => {
    confirmModal(getRoot(), {
      title: 'メモを削除',
      message: 'このメモを削除します。元に戻せません。',
      primaryLabel: '削除',
      primaryVariant: 'danger',
      onConfirm: async () => {
        try {
          await getRepo().deleteComment(c.id);
          expandedNotes.delete(c.id);
          toast(getRoot(), 'メモを削除しました', 'ok');
          setState({});
        } catch (e) {
          toast(getRoot(), `削除失敗: ${(e as Error).message}`, 'error');
        }
      },
    });
  };

  const showView = () => {
    clear(card);
    const editBtn = el('button', {
      class: 'spira-btn spira-btn--ghost spira-btn--sm',
      style: 'flex-shrink:0',
      onclick: showEdit,
    }, ['編集']);
    const deleteBtn = el('button', {
      class: 'spira-btn spira-btn--danger spira-btn--sm',
      style: 'flex-shrink:0',
      onclick: onDelete,
    }, ['削除']);
    const headRow = el('div', { class: 'spira-th-card-head', style: 'flex-wrap:wrap;gap:var(--s-2)' }, [
      el('span', { html: icon('note') }),
      el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
      el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(c.sentAt)]),
      editBtn,
      deleteBtn,
    ]);
    const body = el('div', { class: 'spira-th-card-body' });
    if (c.isHtml) body.innerHTML = sanitizeMailHtml(c.content);
    else { body.style.whiteSpace = 'pre-wrap'; body.textContent = c.content; }

    card.appendChild(headRow);
    card.appendChild(body);
    attachCollapseToggle(card, body, c.id, expandedNotes);
  };

  const showEdit = () => {
    clear(card);
    const ta = el('textarea', { class: 'spira-textarea', rows: '4' }) as HTMLTextAreaElement;
    ta.value = c.content;
    autoSizeTextarea(ta);

    const saveBtn = el('button', {
      class: 'spira-btn spira-btn--primary spira-btn--sm',
      onclick: async () => {
        const v = ta.value.trim();
        if (!v) { toast(getRoot(), '空のメモは保存できません', 'warn'); return; }
        saveBtn.setAttribute('disabled', '');
        try {
          await getRepo().updateComment(c.id, { content: v });
          c.content = v;
          c.isHtml = false;
          toast(getRoot(), 'メモを更新しました', 'ok');
          showView();
          setState({});
        } catch (e) {
          toast(getRoot(), `更新失敗: ${(e as Error).message}`, 'error');
        } finally {
          saveBtn.removeAttribute('disabled');
        }
      },
    }, ['保存']);

    const cancelBtn = el('button', {
      class: 'spira-btn spira-btn--secondary spira-btn--sm',
      onclick: () => showView(),
    }, ['キャンセル']);

    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); showView(); }
    });

    const headRow = el('div', { class: 'spira-th-card-head' }, [
      el('span', { html: icon('note') }),
      el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
      el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(c.sentAt)]),
    ]);

    card.appendChild(headRow);
    card.appendChild(ta);
    card.appendChild(el('div', { style: 'display:flex;gap:var(--s-3);justify-content:flex-end;margin-top:var(--s-3)' }, [cancelBtn, saveBtn]));

    setTimeout(() => ta.focus(), 0);
  };

  showView();
  return card;
}

function renderNewNoteForm(t: Ticket): HTMLElement {
  const ta = el('textarea', {
    class: 'spira-textarea spira-note-input',
    placeholder: '内部メモを追加  (Cmd/Ctrl + Enter で保存)',
    rows: '3',
  }) as HTMLTextAreaElement;
  // Inline style — strongest priority, defeats any host CSS that would re-enable resize.
  ta.style.resize = 'none';
  autoSizeTextarea(ta);

  const saveBtn = el('button', {
    type: 'button',
    class: 'spira-note-submit',
    'aria-label': 'メモを追加',
    title: 'メモを追加 (Cmd/Ctrl + Enter)',
    html: icon('cornerDownLeft'),
    onclick: () => save(),
  });

  async function save() {
    const v = ta.value.trim();
    if (!v) return;
    saveBtn.setAttribute('disabled', '');
    try {
      await getRepo().addComment({
        ticketId: t.id, type: 'note',
        fromEmail: 'me@example.com', fromName: '自分',
        content: v, isHtml: false,
      });
      ta.value = '';
      toast(getRoot(), 'メモを追加しました', 'ok');
      setState({});
    } catch (e) {
      toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
    } finally {
      saveBtn.removeAttribute('disabled');
    }
  }
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });

  return el('div', { class: 'spira-note-form' }, [ta, saveBtn]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}
