import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { sanitizeMailHtml } from '../utils/sanitize';
import { buildOwaSearchQuery, OWA_INBOX_URL } from '../utils/owa';
import { createNoteEditor, htmlToMarkdown } from '../lib/note-editor';
import { formatTicketTag, formatTicketIdShort, buildCopyableSubject } from '../utils/ticketTag';

function commentHasImage(c: Comment): boolean {
  if (!c.isHtml) return false;
  return /<img\b/i.test(c.content);
}

async function copySearchAndOpenOwa(ticket: Ticket, c: Comment): Promise<void> {
  const q = buildOwaSearchQuery({ ticket, comment: c });
  try {
    await navigator.clipboard.writeText(q);
    toast(getRoot(), '検索文字列をコピーしました。OWA の検索バーに貼り付けて Enter', 'ok', 8000);
  } catch {
    toast(getRoot(), `OWA で次を検索: ${q}`, 'warn', 12000);
  }
  window.open(OWA_INBOX_URL, '_blank', 'noopener');
}
import { isInternalMember, colorForAuthor } from '../utils/members';
import { renderStatusBadge, renderPriorityLabel } from './ticketList';
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
      draggable: 'true',
      'data-tab-id': String(id),
    }, [
      el('span', { style: 'font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink-3);margin-right:6px' }, [formatTicketIdShort(id)]),
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

    // Drag-to-reorder
    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      tab.classList.add('spira-tab--dragging');
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('spira-tab--dragging');
      document.querySelectorAll('.spira-tab--drop-target').forEach(n => n.classList.remove('spira-tab--drop-target'));
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tab.classList.add('spira-tab--drop-target');
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('spira-tab--drop-target');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('spira-tab--drop-target');
      const fromId = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10);
      if (!fromId || fromId === id) return;
      const cur = [...getState().openTicketIds];
      const fromIdx = cur.indexOf(fromId);
      const toIdx = cur.indexOf(id);
      if (fromIdx < 0 || toIdx < 0) return;
      cur.splice(fromIdx, 1);
      cur.splice(toIdx, 0, fromId);
      setState({ openTicketIds: cur });
    });

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
      ? '検索文字列を clipboard にコピーして OWA を開く。\nOWA の検索バーに Cmd/Ctrl + V → Enter で該当メールを表示し、\n「返信」を押せばスレッドが維持されます。'
      : '受信メールがないため返信を作成できません',
    disabled: !latestReceived,
    onclick: async () => {
      if (!latestReceived) return;
      const q = buildOwaSearchQuery({ ticket: activeT, comment: latestReceived });
      try {
        await navigator.clipboard.writeText(q);
        toast(getRoot(), `検索文字列をコピーしました。OWA の検索バーに貼り付けて Enter → 結果から「返信」`, 'ok', 8000);
      } catch {
        toast(getRoot(), `OWA で次を検索してください: ${q}`, 'warn', 12000);
      }
      window.open(OWA_INBOX_URL, '_blank', 'noopener');
    },
  }, [
    el('span', { html: icon('mail'), style: 'display:inline-flex;width:14px;height:14px' }),
    'OWA で返信',
  ]);

  // 件名コピー — 新規送信メールにそのまま貼れる「<タグ> <整形タイトル>」を
  // クリップボードに入れる。タイトルに残っている ML 番号や RE: 等の
  // プレフィックスは cleanSubjectCore() で剥がす。
  const copySubjectBtn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    title: '件名 (ID タグ付き) をクリップボードにコピー\nML 番号・RE: 等のプレフィックスは自動で除外されます',
    onclick: async () => {
      const subject = buildCopyableSubject(activeT.id, activeT.title);
      try {
        await navigator.clipboard.writeText(subject);
        toast(getRoot(), `件名をコピーしました: ${subject}`, 'ok', 5000);
      } catch {
        toast(getRoot(), `クリップボードに書き込めませんでした: ${subject}`, 'warn', 8000);
      }
    },
  }, [
    el('span', { html: icon('copy'), style: 'display:inline-flex;width:14px;height:14px' }),
    '件名コピー',
  ]);

  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--danger spira-btn--sm',
    onclick: () => {
      confirmModal(getRoot(), {
        title: 'チケットを削除',
        message: `${formatTicketIdShort(activeT.id)} 「${activeT.title}」 をゴミ箱に移動します。`,
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
    el('div', { class: 'spira-tab-right' }, [copySubjectBtn, replyBtn, deleteBtn]),
  ]);
}

// (toolbar moved into the tab strip — see renderTabStrip above)

// ============================================================ ticket header (title + properties)

function renderTicketHeader(t: Ticket): HTMLElement {
  const users = getState().users;
  const idTag = formatTicketTag(t.id);
  const idDisplay = formatTicketIdShort(t.id);

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

  const statusBtn = renderStatusBadge(t.status);
  statusBtn.classList.add('spira-prop-edit');
  statusBtn.setAttribute('role', 'button');
  statusBtn.setAttribute('tabindex', '0');
  statusBtn.title = 'クリックでステータスを変更';
  statusBtn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    openSelectMenu(statusBtn, ticketStatusList(), t.status, async (next) => {
      await updateField(t, { status: next }, 'ステータス');
    });
  });

  const prioBtn = renderPriorityLabel(t.priority);
  prioBtn.classList.add('spira-prop-edit');
  prioBtn.setAttribute('role', 'button');
  prioBtn.setAttribute('tabindex', '0');
  prioBtn.title = 'クリックで優先度を変更';
  prioBtn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    openSelectMenu(prioBtn, priorityList(), t.priority, async (next) => {
      await updateField(t, { priority: next }, '優先度');
    });
  });

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
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s-4);align-items:center;margin-top:var(--s-3)' }, [
      label('ステータス'), statusBtn,
      label('優先度'), prioBtn,
      label('担当者'), assigneeSel,
      label('期限'), dueInput,
    ]),
  ]);
}

function label(text: string): HTMLElement {
  return el('span', { class: 'spira-prop-label', style: 'font-size:var(--fs-sm)' }, [text]);
}

/** Anchor a small menu under the given element to pick from a list of values. */
function openSelectMenu<T extends string>(
  anchor: HTMLElement,
  options: T[],
  current: T,
  onSelect: (v: T) => void,
): void {
  document.querySelectorAll('.spira-select-menu').forEach(n => n.remove());
  const menu = el('div', {
    class: 'spira-menu spira-select-menu',
    style: 'position:fixed;z-index:2147483700;min-width:140px',
  }, options.map(opt => el('div', {
    class: 'spira-menu-item' + (opt === current ? ' spira-menu-item--current' : ''),
    onclick: () => { menu.remove(); onSelect(opt); },
  }, [opt])));
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  getRoot().appendChild(menu);
  setTimeout(() => {
    const closer = (e: Event) => {
      if (menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
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

  const flipExpanded = (): void => {
    if (expandedSet.has(id)) expandedSet.delete(id);
    else expandedSet.add(id);
    apply();
    toggle.innerHTML = '';
    toggle.appendChild(toggleLabel(expandedSet.has(id)));
  };

  const toggle = el('button', {
    type: 'button',
    class: 'spira-th-toggle',
    onclick: (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      flipExpanded();
    },
  }, [toggleLabel(expandedSet.has(id))]);
  card.appendChild(toggle);

  // Same toggle on card double-click. Only interactive children
  // (buttons / links / form controls / contenteditable) are skipped.
  //
  // We intentionally do NOT bail out when the browser's default
  // word-selection has fired — that was the previous behavior and it
  // made the "double-click anywhere on the card to close it" gesture
  // silently fail whenever the user dblclicked on body text (the
  // browser would word-select first and our handler would early-out
  // because the selection wasn't collapsed). Now we always toggle and
  // explicitly clear the selection so the user doesn't see a stray
  // word-highlight after collapse.
  card.addEventListener('dblclick', (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (target && target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    flipExpanded();
  });

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

function renderReceivedCard(t: Ticket, c: Comment): HTMLElement {
  const internal = isInternalMember(c.fromEmail);
  const hasImage = commentHasImage(c);

  const tagPills: HTMLElement[] = [];
  if (c.hasAttachments) {
    tagPills.push(el('span', {
      class: 'spira-badge spira-badge--muted',
      style: 'font-size:var(--fs-xs)',
      title: '添付ファイルあり',
    }, ['📎 添付あり']));
  }
  if (hasImage) {
    tagPills.push(el('span', {
      class: 'spira-badge spira-badge--muted',
      style: 'font-size:var(--fs-xs)',
      title: '本文中に画像あり',
    }, ['🖼 画像あり']));
  }

  const searchBtn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    style: 'flex-shrink:0',
    title: 'このメールの検索文字列をコピーして OWA を開く',
    onclick: (e: Event) => { e.stopPropagation(); copySearchAndOpenOwa(t, c); },
  }, [
    el('span', { html: icon('search'), style: 'display:inline-flex;width:14px;height:14px' }),
    'OWA で検索',
  ]);

  const head = el('div', { class: 'spira-th-card-head', style: 'flex-wrap:wrap;gap:var(--s-2)' }, [
    el('span', { html: icon('mail') }),
    el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
    c.fromEmail ? el('span', { style: 'color:var(--ink-3)' }, [` <${c.fromEmail}>`]) : '',
    internal
      ? el('span', { class: 'spira-badge spira-badge--muted', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['内部'])
      : el('span', { class: 'spira-badge spira-badge--warn', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['外部']),
    ...tagPills,
    el('span', { style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(c.sentAt)]),
    searchBtn,
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

  // Inline editor with debounced auto-save. No "edit" / "save" toggle —
  // typing into the card persists automatically. Unsaved status is shown
  // next to the date so the user knows when their work has landed.
  const status = el('span', {
    class: 'spira-note-status',
    style: 'margin-left:auto;color:var(--ink-3);font-size:var(--fs-sm);min-width:0;text-align:right',
  }, [fmtDate(c.sentAt)]);

  // Legacy HTML notes (created before the editor port) get a one-way
  // conversion to markdown on first edit. We convert eagerly so the user
  // sees a real markdown editor instead of an empty one — losing some
  // formatting on the way is acceptable since plain mail HTML is mostly
  // <p>/<br>/<a>/<b>/<i>, all of which htmlToMarkdown handles.
  const initialMd = c.isHtml ? htmlToMarkdown(c.content) : (c.content ?? '');

  let saveTimer: number | null = null;
  let saving = false;
  let inflight: Promise<void> = Promise.resolve();

  const flashSaved = (): void => {
    status.textContent = '保存済み';
    setTimeout(() => {
      // Restore the date label only if we're still in "saved" state — a
      // subsequent edit would have flipped to "未保存".
      if (status.textContent === '保存済み') {
        status.textContent = fmtDate(c.sentAt);
      }
    }, 1200);
  };

  const flushSave = async (): Promise<void> => {
    if (!editor) return;
    const v = editor.getMarkdown();
    if (v === c.content && !c.isHtml) { status.textContent = fmtDate(c.sentAt); return; }
    saving = true;
    status.textContent = '保存中...';
    try {
      // Persist `isHtml: false` whenever we save — the new editor always
      // produces markdown, so legacy HTML memos that we converted on
      // edit must be re-tagged in SP too. Otherwise the next reload
      // still sees `IsHtml=true` and the markdown leaks raw HTML
      // entities through sanitizeNoteHtml instead of going through
      // markdownToHtml.
      await getRepo().updateComment(c.id, { content: v, isHtml: false });
      c.content = v;
      c.isHtml = false;
      flashSaved();
    } catch (e) {
      status.textContent = `保存失敗: ${(e as Error).message}`;
    } finally {
      saving = false;
    }
  };

  const scheduleSave = (): void => {
    status.textContent = '未保存';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      inflight = inflight.then(flushSave);
    }, 700);
  };

  const editor = createNoteEditor({
    value: initialMd,
    placeholder: '内部メモ ... / でブロック挿入',
    onDirty: scheduleSave,
    onSubmit: () => {
      // Explicit Cmd/Ctrl+Enter — flush pending debounce immediately.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      inflight = inflight.then(flushSave);
    },
    floatingContainer: getRoot(),
    // File drops / slash-menu file picker go to SP doc library
    // (or mock data URL). Errors surface as a toast and bubble back to
    // the editor so it can drop the placeholder chip.
    onFileUpload: async (file) => {
      try {
        return await getRepo().uploadAttachment(c.ticketId, file);
      } catch (e) {
        toast(getRoot(), `アップロード失敗: ${file.name} — ${(e as Error).message}`, 'error', 6000);
        return null;
      }
    },
  });

  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--danger spira-btn--sm',
    style: 'flex-shrink:0',
    onclick: onDelete,
  }, ['削除']);

  const headRow = el('div', {
    class: 'spira-th-card-head',
    style: 'flex-wrap:wrap;gap:var(--s-2);align-items:center',
  }, [
    el('span', { html: icon('note') }),
    el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
    status,
    deleteBtn,
  ]);

  card.appendChild(headRow);
  card.appendChild(editor.root);

  // Best-effort flush on tab close / navigation. Already-debounced save
  // races are tolerated — the worst case is one missed character.
  const onBeforeUnload = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer); saveTimer = null;
      // Synchronous best-effort. Modern browsers ignore async work here.
      void flushSave();
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // Detach cleanup — runs when the card is removed from the DOM (e.g.
  // setState() re-paints the ticket detail mid-edit). Without this the
  // debounced saveTimer could still fire after the card is gone, and
  // the window-level beforeunload listener would leak across renders.
  // We schedule a synchronous flush via the inflight chain so anything
  // the user has typed at the moment of detach reaches SP.
  let cardCleanedUp = false;
  const cleanupCard = (): void => {
    if (cardCleanedUp) return;
    cardCleanedUp = true;
    if (saveTimer) {
      clearTimeout(saveTimer); saveTimer = null;
      inflight = inflight.then(flushSave);
    }
    window.removeEventListener('beforeunload', onBeforeUnload);
    detachObserver?.disconnect();
  };
  let detachObserver: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    let wasConnected = false;
    detachObserver = new MutationObserver(() => {
      if (card.isConnected) wasConnected = true;
      else if (wasConnected) cleanupCard();
    });
    detachObserver.observe(document.body, { childList: true, subtree: true });
  }
  // `saving` is read inside flushSave to avoid concurrent writes —
  // referenced here for the type-checker which can't see across closures.
  void saving;

  return card;
}

function renderNewNoteForm(t: Ticket): HTMLElement {
  // Add an empty memo card on click — the inline editor + autosave inside
  // the new card handles content entry. No separate compose form.
  const addBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--secondary',
    style: 'width:100%;justify-content:center',
    onclick: async () => {
      addBtn.setAttribute('disabled', '');
      try {
        const created = await getRepo().addComment({
          ticketId: t.id, type: 'note',
          fromEmail: 'me@example.com', fromName: '自分',
          content: '', isHtml: false,
        });
        setState({});
        // After re-render, focus the new card's editor so the user can
        // start typing immediately.
        setTimeout(() => {
          const newCard = document.querySelector<HTMLElement>(
            `.spira-th-card--note[data-comment-id="${created.id}"] .ne-content`,
          );
          newCard?.focus();
        }, 50);
      } catch (e) {
        toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
      } finally {
        addBtn.removeAttribute('disabled');
      }
    },
  }, ['+ メモを追加']);

  return el('div', { class: 'spira-note-form spira-note-form--add' }, [addBtn]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}
