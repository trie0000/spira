import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { ticketStatusList, priorityList } from '../api/sp';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { renderMailBody } from '../utils/sanitize';
import { buildOwaSearchQuery, OWA_INBOX_URL } from '../utils/owa';
import { createNoteEditor, htmlToMarkdown } from '../lib/note-editor';
import { formatTicketTag, formatTicketIdShort, buildCopyableSubject } from '../utils/ticketTag';

function commentHasImage(c: Comment): boolean {
  if (!c.isHtml) return false;
  return /<img\b/i.test(c.content);
}

import { isInternalAuthor, colorForAuthor, tintForAuthor } from '../utils/members';
import { renderStatusBadge, renderPriorityLabel, renderAssignee, openInlineAssigneeMenu } from './ticketList';
import { toast } from '../components/toast';
import { confirmModal, openModal } from '../components/modal';
import { getLastSeen, markTicketSeen, isCommentNewSince } from '../utils/seenState';
import { openTicketPropertiesModal } from './ticketProperties';
import { getDepartmentOptions, getInquiryCategoryOptions } from '../utils/optionLists';
import { createDateTime } from '../components/datetime';
import { parseTeamsPaste, resolveTeamsTimeToISO, normalizeForDedup, detectLeadingOrphan } from '../lib/teams-paste';
import { parseEml, parseOutlookDragText, parseMsgFile, looksLikeEml, looksLikeOutlookDrag } from '../lib/eml-parser';
import { createAiChatPane, isAiPanelOpen, toggleAiPanel } from './aiChat';
import type { Ticket, Comment } from '../types';

// Module-level "next mount, scroll to this comment" request. Set by
// views that navigate to ticket detail and want a specific card to be
// highlighted (e.g. search results). Consumed once by the next
// renderTicketDetail call. Lives outside the state store so reading it
// doesn't trigger a re-render cascade.
let pendingScrollCommentId: number | null = null;
export function requestScrollToComment(commentId: number): void {
  pendingScrollCommentId = commentId;
}

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

  // Snapshot the user's PREVIOUS last-seen timestamp for this ticket
  // BEFORE stamping the current visit. Cards with sentAt > prevLastSeen
  // get a "NEW" badge for this render. Next visit's snapshot will be
  // "now", so badges only show until the user revisits.
  const prevLastSeen = getLastSeen(ticketId);
  markTicketSeen(ticketId);

  // Refresh banner — surfaced by the polling loop below when another
  // member has changed the underlying SP data while this view was open.
  const refreshBanner = el('div', {
    class: 'spira-refresh-banner',
    style: 'display:none',
    role: 'status',
  }, [
    el('span', { html: icon('refresh'), style: 'display:inline-flex;width:14px;height:14px' }),
    el('span', { style: 'flex:1;min-width:0' }, ['他のメンバーが内容を更新しました']),
    el('button', {
      class: 'spira-btn spira-btn--primary spira-btn--sm',
      onclick: () => setState({}),
    }, ['更新']),
  ]);

  const wrap = el('div', {
    class: 'spira-main-wrap',
    style: 'display:flex;flex-direction:column;height:100%;min-height:0',
  }, [
    await renderTabStrip(t, latestReceived),
    renderTicketHeader(t, latestReceived),
    refreshBanner,
    renderSplitPanes(t, comments, prevLastSeen),
  ]);

  // Deep-link scroll: if another view (e.g. search results) requested
  // we scroll to a specific comment, do it after the DOM has settled.
  // We use a module-level variable rather than the state store so the
  // request doesn't trigger an extra re-render of this view.
  const targetCommentId = pendingScrollCommentId;
  pendingScrollCommentId = null;
  if (targetCommentId != null) {
    setTimeout(() => {
      const card = wrap.querySelector<HTMLElement>(`[data-comment-id="${targetCommentId}"]`);
      if (!card) return;
      // For received cards inside a collapsed body, expand first so the
      // contents are visible before scrolling.
      if (card.classList.contains('spira-th-card--received')) {
        expandedReceived.add(targetCommentId);
      }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('spira-card-flash');
      setTimeout(() => card.classList.remove('spira-card-flash'), 1800);
    }, 120);
  }

  // Light polling: refetch comments every 30s and flag external changes.
  // The current user's own auto-saves are recorded in
  // `recentlySavedByMe` so they don't trigger a phantom banner against
  // themselves; their fingerprints silently update the baseline on the
  // next poll. New / deleted comments by ANY author still fire the
  // banner (since renderTicketDetail's setState path re-baselines the
  // whole closure on add / delete via setState, those races stay
  // bounded).
  startPollingForExternalChanges(wrap, ticketId, comments, refreshBanner);

  return wrap;
}

const POLL_INTERVAL_MS = 30_000;

/** Comment IDs the current user just auto-saved. The polling loop
 *  consults this set to avoid raising "他のメンバーが…" for the user's
 *  own edits (which haven't been re-fetched into the baseline yet). */
const recentlySavedByMe = new Set<number>();
function markRecentlySavedByMe(commentId: number): void {
  recentlySavedByMe.add(commentId);
  setTimeout(() => recentlySavedByMe.delete(commentId), 60_000);
}

/** Note editor registry: 起動中のノートエディタを comment id で引ける。
 *  ポーリングが「ユーザーが編集中か」を判定し、競合時のダイアログを
 *  出すために使う。 */
interface NoteEditorEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any;
  comment: Comment;
}
const noteEditorRegistry = new Map<number, NoteEditorEntry>();

/** 受信スレッドの新着カードを setState を介さず DOM に直接挿入。
 *  既存の `.spira-th-list` を探して、id 昇順で正しい位置に追加し、
 *  「更新」バッジを付ける。失敗時は no-op。 */
function insertReceivedCardSilently(c: Comment, _ticketId: number): void {
  const lists = Array.from(document.querySelectorAll<HTMLElement>('.spira-th-list'));
  const threadList = lists.find(l => l.querySelector('.spira-th-card--received')) ?? lists[0];
  if (!threadList) return;
  const t = { id: c.ticketId } as Ticket;
  const card = renderReceivedCard(t, c);
  const existing = Array.from(threadList.querySelectorAll<HTMLElement>('.spira-th-card--received'));
  let insertBefore: HTMLElement | null = null;
  for (const existCard of existing) {
    const eId = Number(existCard.getAttribute('data-comment-id') ?? '0');
    if (c.id < eId) { insertBefore = existCard; break; }
  }
  if (insertBefore) threadList.insertBefore(card, insertBefore);
  else threadList.appendChild(card);
  markCardUpdated(c.id);
}

/** 内部メモの新着カードを setState を介さず DOM に直接挿入。
 *  メモペインの `.spira-th-list` (received カードを含まない方) を探して、
 *  sentAt 昇順で正しい位置に追加し、「更新」バッジを付ける。
 *  失敗時は no-op (次の setState で正規描画される)。 */
function insertNoteCardSilently(c: Comment): void {
  const lists = Array.from(document.querySelectorAll<HTMLElement>('.spira-th-list'));
  // 受信スレッドカードを含まないリストがメモペイン
  const noteList = lists.find(l => !l.querySelector('.spira-th-card--received'))
    ?? lists[lists.length - 1];
  if (!noteList) return;
  // 「メモはまだありません」の empty state を消す
  const empty = noteList.querySelector('.spira-empty');
  if (empty) empty.remove();
  // 既に同 id のカードがある場合は no-op (再挿入防止)
  const existing = Array.from(noteList.querySelectorAll<HTMLElement>('.spira-th-card--note'));
  for (const existCard of existing) {
    const eId = Number(existCard.getAttribute('data-comment-id') ?? '0');
    if (eId === c.id) return;
  }
  const card = renderNoteCard(c);
  // id 昇順 (=作成順) で挿入 — 新着メモは末尾に来るのが通常
  let insertBefore: HTMLElement | null = null;
  for (const existCard of existing) {
    const eId = Number(existCard.getAttribute('data-comment-id') ?? '0');
    if (c.id < eId) { insertBefore = existCard; break; }
  }
  if (insertBefore) noteList.insertBefore(card, insertBefore);
  else noteList.appendChild(card);
  markCardUpdated(c.id);
}

/** 外部更新をローカルカードに適用する。
 *  - 受信スレッドカード: 本文を新しい内容で再描画 + 更新バッジ
 *  - 内部メモ (編集中でない): エディタ内容を差し替え + 更新バッジ
 *  - 内部メモ (編集中): 競合ダイアログを表示 */
function applyExternalUpdate(
  local: Comment,
  fresh: Comment,
  ticketId: number,
  pendingConflict: Set<number>,
): void {
  // メモかつ編集中 → 競合
  if (fresh.type === 'note') {
    const entry = noteEditorRegistry.get(fresh.id);
    const userIsEditing = entry &&
      (entry.editor.getMarkdown() as string) !== (local.content ?? '');
    if (userIsEditing && entry) {
      pendingConflict.add(fresh.id);
      openMemoConflictModal(entry, local, fresh, ticketId, pendingConflict);
      return;
    }
    // 編集中でない → エディタへ反映 + バッジ
    Object.assign(local, fresh);
    if (entry) {
      entry.editor.setMarkdown(fresh.content ?? '');
    }
    markCardUpdated(fresh.id);
    return;
  }
  // 受信スレッド/Teams/その他 — 本文を直接更新 + バッジ
  Object.assign(local, fresh);
  const card = document.querySelector<HTMLElement>(`[data-comment-id="${fresh.id}"]`);
  if (card) {
    const bodyEl = card.querySelector<HTMLElement>('.spira-th-card-body');
    if (bodyEl) {
      // 既存の content 構造を replace。HTML はサニタイザを通す。
      bodyEl.innerHTML = '';
      if (fresh.isHtml) {
        renderMailBody(bodyEl, fresh.content, null);
      } else {
        renderMailBody(bodyEl, null, fresh.content);
      }
    }
  }
  markCardUpdated(fresh.id);
}

/** 内部メモ編集中に外部更新があったときの 3 択ダイアログ。 */
function openMemoConflictModal(
  entry: NoteEditorEntry,
  local: Comment,
  fresh: Comment,
  ticketId: number,
  pendingConflict: Set<number>,
): void {
  const root = (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
  const body = el('div', { style: 'line-height:1.7' }, [
    '他のユーザーがこのメモを更新しました。あなたの編集中の内容と競合しています。',
    el('br', {}, []),
    el('br', {}, []),
    '以下から処理を選んでください:',
    el('ul', { style: 'margin-top:8px;padding-left:1.4em' }, [
      el('li', {}, ['他人の更新を反映 — 自分の編集を破棄し、最新の内容に置き換え']),
      el('li', {}, ['自身の更新で上書き — 自分の内容を保存し、相手の編集を上書き']),
      el('li', {}, ['別カードに保存 — 自分の内容を新しいメモカードとして保存し、現在のカードは最新で更新']),
    ]),
  ]);
  const choose = (action: 'remote' | 'mine' | 'separate') => async (): Promise<void> => {
    try {
      if (action === 'remote') {
        // 他人の更新を反映
        Object.assign(local, fresh);
        entry.editor.setMarkdown(fresh.content ?? '');
        markCardUpdated(fresh.id);
      } else if (action === 'mine') {
        // 自分の更新で上書き
        const v = entry.editor.getMarkdown();
        await getRepo().updateComment(fresh.id, { content: v, isHtml: false });
        local.content = v;
        local.isHtml = false;
        markRecentlySavedByMe(fresh.id);
      } else {
        // 別カードに保存
        const v = entry.editor.getMarkdown();
        const newCard = await getRepo().addComment({
          ticketId, type: 'note',
          fromEmail: local.fromEmail, fromName: local.fromName,
          content: v, isHtml: false,
        });
        markRecentlySavedByMe(newCard.id);
        // 現在のカードは最新の内容で更新
        Object.assign(local, fresh);
        entry.editor.setMarkdown(fresh.content ?? '');
        markCardUpdated(fresh.id);
        setState({}); // 新カードを表示
      }
    } finally {
      pendingConflict.delete(fresh.id);
    }
  };

  // confirmModal が cancel と primary 2 択しかないので、3 択は手作りで openModal
  const optMine = el('button', {
    type: 'button', class: 'spira-btn spira-btn--primary',
    onclick: async (e: Event) => { e.preventDefault(); await choose('mine')(); modalHandle.close(); },
  }, ['自身の更新で上書き']);
  const optRemote = el('button', {
    type: 'button', class: 'spira-btn spira-btn--secondary',
    onclick: async (e: Event) => { e.preventDefault(); await choose('remote')(); modalHandle.close(); },
  }, ['他人の更新を反映']);
  const optSeparate = el('button', {
    type: 'button', class: 'spira-btn spira-btn--secondary',
    onclick: async (e: Event) => { e.preventDefault(); await choose('separate')(); modalHandle.close(); },
  }, ['別カードに保存']);

  const footWrap = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px' }, [
    optRemote, optSeparate, optMine,
  ]);
  body.appendChild(footWrap);

  const modalHandle = openModal(root, {
    title: 'メモ競合: 他のユーザーが更新',
    body,
    primaryLabel: '閉じる',
    hideCancel: true,
    onPrimary: () => { pendingConflict.delete(fresh.id); },
  });
}

/** カードに「更新」バッジを付ける (画面遷移まで残る)。
 *  date-group の末尾 (NEW の右側 or 日付の右側) に挿入。 */
function markCardUpdated(commentId: number): void {
  const card = document.querySelector<HTMLElement>(`[data-comment-id="${commentId}"]`);
  if (!card) return;
  if (card.querySelector('.spira-card-updated-badge')) return; // 既に付いてる
  const badge = document.createElement('span');
  badge.className = 'spira-card-updated-badge';
  badge.textContent = '更新';
  badge.title = '他のユーザーが更新しました';
  const group = card.querySelector('.spira-card-date-group');
  if (group) {
    group.appendChild(badge);
  } else {
    card.appendChild(badge);
  }
}

function commentFingerprint(c: Comment): string {
  return `${(c.content ?? '').length}:${c.isHtml ? 1 : 0}:${c.sentAt ?? ''}:${c.content?.slice(-32) ?? ''}`;
}

function startPollingForExternalChanges(
  wrap: HTMLElement,
  ticketId: number,
  initial: Comment[],
  banner: HTMLElement,
): void {
  // initial[] の各 Comment はミュータブル: flushSave で content が更新される
  // のと同じオブジェクトを参照する。
  const localMap = new Map<number, Comment>();
  for (const c of initial) localMap.set(c.id, c);
  // 一度競合解決中のカードは、解決まで再判定しない (ダイアログ重複防止)
  const pendingConflict = new Set<number>();

  const poll = async (): Promise<void> => {
    if (document.hidden) return;
    try {
      const fresh = await getRepo().listComments(ticketId);
      const freshById = new Map(fresh.map(c => [c.id, c]));

      // (a) 既存カードの更新検知 + 新規受信カードの追加検知
      // (a) 既存カード更新検知 + 新規カード silent 挿入 (受信/メモ両方)
      for (const c of fresh) {
        if (pendingConflict.has(c.id)) continue;
        const freshFp = commentFingerprint(c);
        const local = localMap.get(c.id);
        if (local && commentFingerprint(local) === freshFp) continue;
        if (recentlySavedByMe.has(c.id)) {
          if (local) Object.assign(local, c);
          else localMap.set(c.id, c);
          continue;
        }
        if (!local) {
          localMap.set(c.id, c);
          if (c.type === 'received') {
            insertReceivedCardSilently(c, ticketId);
          } else {
            // 新規メモも banner なしで silent 挿入 + 更新バッジ
            insertNoteCardSilently(c);
          }
          continue;
        }
        applyExternalUpdate(local, c, ticketId, pendingConflict);
      }
      // (b) 削除検知 — タイプ問わず DOM から remove
      for (const id of localMap.keys()) {
        if (!freshById.has(id) && !recentlySavedByMe.has(id)) {
          localMap.delete(id);
          document.querySelector(`[data-comment-id="${id}"]`)?.remove();
        }
      }
      // banner はもう出さない (全 silent)
      void banner;
    } catch { /* swallow — transient network errors shouldn't break the UI */ }
  };

  const intervalId = window.setInterval(poll, POLL_INTERVAL_MS);

  // Catch up immediately when the user tabs back in.
  const onVisibility = (): void => { if (!document.hidden) void poll(); };
  document.addEventListener('visibilitychange', onVisibility);

  // Cleanup when this ticket-detail wrap is detached (setState() repaint,
  // navigation to inbox / trash, etc.). Same edge-trigger pattern used
  // for note-card cleanup — wait until we've seen the wrap connected at
  // least once before reacting to disconnection.
  let wasConnected = false;
  const observer = new MutationObserver(() => {
    if (wrap.isConnected) { wasConnected = true; return; }
    if (!wasConnected) return;
    clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibility);
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function renderTabStrip(activeT: Ticket, _latestReceived: Comment | undefined): Promise<HTMLElement> {
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

  // 件名コピー / OWA で返信 / 削除 はチケットヘッダの「起票:」行に
  // 移動した (renderTicketHeader 内の buildTicketActions 参照)。
  return el('div', { class: 'spira-tab-strip' }, [
    el('div', { class: 'spira-tab-left' }, [backBtn]),
    el('div', { class: 'spira-tab-middle' }, tabs),
  ]);
}

/** Build the per-ticket action buttons that live in the ticket header
 *  meta row: 件名コピー / OWA で返信 / 削除 (red trash icon). Shared
 *  helper so the wiring stays in one place. */
function buildTicketActions(activeT: Ticket, latestReceived: Comment | undefined): HTMLElement[] {
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

  // Unified icon-only red trash button (same style as memo / thread card).
  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--sm spira-btn--icon-trash',
    title: 'チケットをゴミ箱に移動',
    'aria-label': 'チケットを削除',
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
  }, [
    el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' }),
  ]);

  // Teams スレッド起票ボタン (内部用 / ユーザー用)
  // - 未起票なら TeamsPostRequests に 1 行 INSERT → PA が拾って Teams 投稿
  // - 起票済みなら DeepLink を新規タブで開く
  const internalThreadBtn = buildTeamsThreadButton(activeT, 'internal');
  const userThreadBtn = buildTeamsThreadButton(activeT, 'user');

  // プロパティ (Teams スレッドの解除・手動紐付け等)
  const propertiesBtn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    title: 'Teams スレッドの解除・手動紐付け',
    onclick: () => openTicketPropertiesModal(activeT),
  }, [
    el('span', { html: icon('gear'), style: 'display:inline-flex;width:14px;height:14px' }),
    'プロパティ',
  ]);

  // AI チャット トグル — チケット詳細画面のみで表示。右ペインの開閉切り替え。
  const aiBtn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm' + (isAiPanelOpen() ? ' spira-btn--active' : ''),
    title: 'AI チャット (右ペイン) を開閉',
    onclick: () => toggleAiPanel(),
  }, [
    el('span', { html: icon('sparkles'), style: 'display:inline-flex;width:14px;height:14px' }),
    'AI',
  ]);

  return [aiBtn, copySubjectBtn, replyBtn, internalThreadBtn, userThreadBtn, propertiesBtn, deleteBtn];
}

/** 内部/ユーザースレッド起票・遷移ボタン。状態に応じて表記が変わる:
 *  - DeepLink 未設定 → 「🏢 内部スレッド起票」「👥 ユーザースレッド起票」
 *  - DeepLink あり    → 「🏢 内部スレッドを開く」「👥 ユーザースレッドを開く」
 *  起票時は SP の TeamsPostRequests に Pending 行を INSERT するだけ。
 *  実際の Teams 投稿は PA フロー 2 が拾って実行する。 */
function buildTeamsThreadButton(activeT: Ticket, threadType: 'internal' | 'user'): HTMLElement {
  const isInternal = threadType === 'internal';
  const deepLink = isInternal ? activeT.internalDeepLink : activeT.userDeepLink;
  const emoji = isInternal ? '🏢' : '👥';
  const label = isInternal ? '内部スレッド' : 'ユーザースレッド';
  const created = !!deepLink;

  const btn = el('button', {
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    title: created
      ? `${label}を新規タブで開く`
      : `${label}を Teams に起票します。\nPA フローが実際の投稿を行い、完了後に DeepLink が反映されます。`,
    onclick: async () => {
      if (created && deepLink) {
        window.open(deepLink, '_blank', 'noopener');
        return;
      }
      // 連打防止
      btn.setAttribute('disabled', 'true');
      btn.classList.add('spira-spin');
      try {
        await getRepo().createTeamsPostRequest({
          ticketId: activeT.id,
          threadType,
        });
        toast(
          getRoot(),
          `${emoji} ${label}の起票をキューに積みました。PA 処理後に DeepLink が反映されます。`,
          'ok',
          6000,
        );
        // 再描画 (mock では即座に DeepLink が生える / SP では PA 完了後の同期待ち)
        setState({});
      } catch (e) {
        toast(getRoot(), `${label}起票に失敗: ${(e as Error).message}`, 'error');
        btn.removeAttribute('disabled');
        btn.classList.remove('spira-spin');
      }
    },
  }, [
    el('span', { html: icon('chat'), style: 'display:inline-flex;width:14px;height:14px' }),
    `${emoji} ${created ? `${label}を開く` : `${label}起票`}`,
  ]);

  if (created) btn.classList.add('spira-btn--success');
  return btn;
}

// (toolbar moved into the tab strip — see renderTabStrip above)

// ============================================================ ticket header (title + properties)

function renderTicketHeader(t: Ticket, latestReceived: Comment | undefined): HTMLElement {
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

  // 担当者: 一覧と同じインラインメニュー (チェックボックス) を使用。
  // 現在の選択をアバタースタックで表示し、クリックでメニュー展開。
  const assigneeCell = (() => {
    const view = renderAssignee(t.assigneeNames, t.assigneeEmails);
    view.style.cursor = 'pointer';
    view.style.padding = '2px 6px';
    view.style.border = '1px solid var(--line)';
    view.style.borderRadius = 'var(--r-2)';
    return el('span', {
      onclick: (e: Event) => {
        e.stopPropagation();
        openInlineAssigneeMenu(view, t.assigneeEmails ?? [], (emails, names) => {
          void updateField(t, {
            assigneeEmails: emails.length > 0 ? emails : undefined,
            assigneeNames: names.length > 0 ? names : undefined,
          }, '担当者');
        });
      },
    }, [view]);
  })();

  // 部門 / 問い合わせ種別: ボタン風 UI でクリック → ドロップダウンメニュー
  const buildOptionButton = (
    field: 'department' | 'inquiryCategory',
    getOptions: () => Promise<string[]>,
    fieldLabel: string,
  ): HTMLElement => {
    const current = t[field] ?? '';
    const btn = el('span', {
      class: 'spira-prop-edit',
      role: 'button',
      tabindex: '0',
      style: 'cursor:pointer;padding:2px 8px;border:1px solid var(--line);border-radius:var(--r-2);font-size:var(--fs-sm);min-width:80px;display:inline-block',
      title: `クリックで${fieldLabel}を変更`,
    }, [current || el('span', { style: 'color:var(--ink-3)' }, ['(未設定)'])]);
    btn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const options = await getOptions();
      // 「(未設定)」+ 既存選択肢 + 現在値が削除済みなら末尾に補完
      const allOptions = ['(未設定)', ...options];
      if (current && !options.includes(current)) {
        allOptions.push(`${current} (削除済み)`);
      }
      openSelectMenu(btn, allOptions, current ? current : '(未設定)', async (next) => {
        let value: string | undefined;
        if (next === '(未設定)') value = undefined;
        else if (next.endsWith(' (削除済み)')) value = current; // 何も変えない
        else value = next;
        if (value === current) return;
        await updateField(t, { [field]: value } as Partial<Ticket>, fieldLabel);
      });
    });
    return btn;
  };

  const deptBtn = buildOptionButton('department', getDepartmentOptions, '部門');
  const categoryBtn = buildOptionButton('inquiryCategory', getInquiryCategoryOptions, '問い合わせ種別');

  // 他の要素 (ステータス・優先度ボタン、部門/種別ボタン) と高さを揃えるため
  // padding を小さくして枠サイズを統一。
  const dueInput = el('input', {
    type: 'date',
    style:
      'padding:2px 6px;border:1px solid var(--line);border-radius:var(--r-2);' +
      'font-size:var(--fs-sm);background:var(--paper);color:var(--ink);' +
      'height:24px;line-height:1;box-sizing:border-box',
    value: t.dueDate ? t.dueDate.slice(0, 10) : '',
  }) as HTMLInputElement;
  dueInput.addEventListener('change', () => updateField(t, {
    dueDate: dueInput.value ? new Date(dueInput.value).toISOString() : undefined,
  }, '期限'));

  return el('div', { class: 'spira-detail-hd-wrap' }, [
    // 起票/更新 meta + 件名コピー/OWA で返信/削除 を 1 行に。
    el('div', {
      class: 'spira-detail-hd-meta',
      style: 'display:flex;align-items:center;gap:var(--s-4);margin-bottom:var(--s-1);flex-wrap:wrap',
    }, [
      el('span', { style: 'flex:1;min-width:0' }, [
        `起票: ${fmtDate(t.createdAt)}`, ' · ', `更新: ${fmtDate(t.updatedAt)}`,
        t.reporterName ? ` · 起票元: ${t.reporterName}` : '',
      ]),
      el('div', { style: 'display:flex;gap:var(--s-2);align-items:center;flex-shrink:0' },
        buildTicketActions(t, latestReceived),
      ),
    ]),
    el('div', { class: 'spira-detail-title-row' }, [idLabel, titleInput]),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s-4);align-items:center;margin-top:var(--s-3)' }, [
      label('ステータス'), statusBtn,
      label('優先度'), prioBtn,
      label('担当者'), assigneeCell,
      label('期限'), dueInput,
      label('部門'), deptBtn,
      label('種別'), categoryBtn,
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

function renderSplitPanes(t: Ticket, comments: Comment[], lastSeen: number | null = null): HTMLElement {
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');

  const addHistoryBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    style: 'margin-left:auto',
    onclick: () => openAddHistoryModal(t, received),
  }, [
    el('span', { html: icon('plus'), style: 'display:inline-flex;width:14px;height:14px' }),
    '履歴を追加',
  ]);

  const leftPane = el('div', {
    class: 'spira-split-pane',
    'data-bg': 'paper',
    style: 'flex:1 1 50%;min-width:0;overflow:auto;padding:0 var(--s-7) var(--s-7);background:var(--paper)',
  }, [
    paneTitle('📋 スレッド', `${received.length} 件`, addHistoryBtn),
    renderReceivedThread(t, received, lastSeen),
  ]);

  const addNoteBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    style: 'margin-left:auto',
    onclick: () => addNewNote(t),
  }, [
    el('span', { html: icon('plus'), style: 'display:inline-flex;width:14px;height:14px' }),
    'メモを追加',
  ]);

  const rightPane = el('div', {
    class: 'spira-split-pane',
    'data-bg': 'paper-2',
    style: 'flex:1 1 50%;min-width:0;overflow:auto;padding:0 var(--s-7) var(--s-7);background:var(--paper-2)',
  }, [
    paneTitle('📝 内部メモ', `${notes.length} 件`, addNoteBtn),
    renderNotesPane(t, notes, lastSeen),
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

  // ── AI chat right-pane (slide-out) ──────────────────────────────────
  // 右ペインに付随する形で、トグル可能な AI チャットペインを配置する。
  // 内部メモ ↔ AI ペインの境にもリサイザを置いて、ユーザが幅を調整可能。
  const splitChildren: HTMLElement[] = [leftPane, resizer, rightPane];
  if (isAiPanelOpen()) {
    const aiPane = createAiChatPane({ ticket: t, comments });
    // 保存幅 (px) を復元。CSS の width:360px をインラインで上書きする。
    try {
      const savedAi = parseFloat(localStorage.getItem(AI_PANE_WIDTH_KEY) ?? '');
      if (Number.isFinite(savedAi) && savedAi >= AI_PANE_MIN_PX && savedAi <= AI_PANE_MAX_PX) {
        aiPane.style.width = `${savedAi}px`;
        aiPane.style.flex = `0 0 ${savedAi}px`;
      }
    } catch { /* ignore */ }
    const aiResizer = el('div', {
      class: 'spira-split-resizer spira-ai-resizer',
      'aria-label': 'AI ペインの幅を変更',
      style: 'flex:0 0 6px;cursor:col-resize;background:var(--paper-3);transition:background 0.1s',
    });
    attachAiResizer(aiResizer, aiPane);
    splitChildren.push(aiResizer, aiPane);
  }

  const wrap = el('div', {
    class: 'spira-split',
    style: 'display:flex;flex:1;min-height:0;overflow:hidden;border-top:1px solid var(--line)',
  }, splitChildren);

  return wrap;
}

// AI ペイン幅 (px) の永続化キー + 制約。
const AI_PANE_WIDTH_KEY = 'spira:ai-pane-w';
const AI_PANE_MIN_PX = 280;
const AI_PANE_MAX_PX = 720;
const AI_PANE_DEFAULT_PX = 360;

/** AI ペインの左端リサイザ。ドラッグで AI ペインの幅を増減し、その分は
 *  内部メモペイン (right) が flex で吸収する。leftPane (受信スレッド) は
 *  影響を受けない。ダブルクリックで既定の 360px に戻す。 */
function attachAiResizer(resizer: HTMLElement, aiPane: HTMLElement): void {
  resizer.addEventListener('mouseenter', () => { resizer.style.background = 'var(--accent-soft)'; });
  resizer.addEventListener('mouseleave', () => { resizer.style.background = 'var(--paper-3)'; });
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiPane.getBoundingClientRect().width;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.style.background = 'var(--accent)';

    const onMove = (ev: MouseEvent) => {
      // ドラッグ方向: 左に動かす (dx<0) と AI ペインが広がる
      const dx = ev.clientX - startX;
      let newW = startW - dx;
      newW = Math.max(AI_PANE_MIN_PX, Math.min(newW, AI_PANE_MAX_PX));
      aiPane.style.width = `${newW}px`;
      aiPane.style.flex = `0 0 ${newW}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      resizer.style.background = 'var(--paper-3)';
      const w = aiPane.getBoundingClientRect().width;
      try { localStorage.setItem(AI_PANE_WIDTH_KEY, String(Math.round(w))); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  // ダブルクリックで既定値に戻す
  resizer.addEventListener('dblclick', () => {
    aiPane.style.width = `${AI_PANE_DEFAULT_PX}px`;
    aiPane.style.flex = `0 0 ${AI_PANE_DEFAULT_PX}px`;
    try { localStorage.setItem(AI_PANE_WIDTH_KEY, String(AI_PANE_DEFAULT_PX)); } catch { /* ignore */ }
  });
}

function paneTitle(title: string, sub: string, action?: HTMLElement): HTMLElement {
  return el('div', { class: 'spira-pane-title' }, [
    el('h3', { style: 'font-size:var(--fs-md);font-weight:600;color:var(--ink);margin:0' }, [title]),
    el('span', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' }, [sub]),
    ...(action ? [action] : []),
  ]);
}

// ============================================================ add history modal

function openAddHistoryModal(t: Ticket, existing: Comment[]): void {
  type Source = 'mail' | 'teams' | 'other';

  // Truncate ISO timestamp to minute resolution so seconds-level seq
  // offsets (added by resolveTeamsTimeToISO to keep same-minute messages
  // sortable) don't break dedup. Falls back to the original string if
  // parsing fails.
  const minuteKey = (iso: string): string => {
    const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : (iso ?? '');
  };

  const fingerprint = (author: string, isoTime: string, body: string): string =>
    `${author.toLowerCase()}::${minuteKey(isoTime)}::${normalizeForDedup(body)}`;

  // Pre-normalize existing 'received' comments for duplicate detection.
  const existingFingerprints = new Set(
    existing.map(c => fingerprint(c.fromName ?? '', c.sentAt, c.content))
  );

  const sourceSel = el('select', {
    class: 'spira-input',
    style: 'width:200px;min-width:0',
  }, [
    el('option', { value: 'teams' }, ['Teams']),
    el('option', { value: 'mail' }, ['メール']),
    el('option', { value: 'other' }, ['その他']),
  ]);

  // Datalist for the 送信者 field — AD users + authors already seen
  // on this ticket. Same source list used by the edit modal.
  const adUsers = getState().users;
  const ticketAuthors = Array.from(new Set(
    existing.map(c => (c.fromName ?? '').trim()).filter(s => s.length > 0)
  ));
  const adNames = new Set(adUsers.map(u => u.displayName.trim().toLowerCase()));
  const datalistId = `spira-add-author-${t.id}`;
  const authorDatalist = el('datalist', { id: datalistId }, [
    ...adUsers.map(u => el('option', { value: u.displayName, label: u.email }, [])),
    ...ticketAuthors
      .filter(n => !adNames.has(n.toLowerCase()))
      .map(n => el('option', { value: n, label: 'このチケット内' }, [])),
  ]);

  // 送信者 field. Unified between Teams / メール / その他 sources:
  //   - Teams: this is the LEADING speaker (the first orphan message
  //     that Teams strips). Subsequent messages come from the parsed
  //     clipboard.
  //   - メール / その他: this is the single comment's author.
  // The placeholder updates with the source select so the meaning stays
  // clear without changing the field's identity.
  const authorInput = el('input', {
    type: 'text',
    class: 'spira-input',
    list: datalistId,
    placeholder: '先頭メッセージの送信者 (Teams の仕様で取得できないため手入力)',
    style: 'width:100%;max-width:420px;min-width:0',
    autocomplete: 'off',
  }) as HTMLInputElement;

  // 送信時間 (YYYY/MM/DD HH:MM 連結ウィジェット)。初期値は今日 + 自動時刻。
  // ユーザが手で変更したら usingDefaultLeadingTime=false で自動更新を止める。
  let usingDefaultLeadingTime = true;
  const todayISO = new Date().toISOString().slice(0, 10);
  const leadingDateTimePicker = createDateTime({
    initial: `${todayISO}T00:00`,
    onUserEdit: () => {
      usingDefaultLeadingTime = false;
      leadingTimeHint.style.display = 'none';
      updatePreview();
    },
  });
  const leadingTimeHint = el('span', {
    style: 'font-size:var(--fs-xs);color:var(--ink-3);',
  }, ['(デフォルト)']);

  const bodyArea = el('textarea', {
    class: 'spira-input',
    rows: '12',
    style: 'width:100%;font:13px/1.55 ui-monospace,Menlo,monospace;resize:vertical',
    placeholder: 'Teams: 右クリック→コピーしたチャットを貼り付け\nメール / その他: 本文を貼り付け',
  }) as HTMLTextAreaElement;

  // Inline alert banner (shown above the textarea when something is
  // wrong with the paste). Lives inside the modal body so it stays
  // visible without being washed out by the modal's blur backdrop.
  const alertBanner = el('div', {
    style: [
      'display:none',
      'background:#fef3c7', 'border:1px solid #f59e0b', 'color:#78350f',
      'border-radius:var(--r-2)', 'padding:var(--s-3) var(--s-4)',
      'font-size:var(--fs-sm)', 'line-height:1.6', 'white-space:pre-line',
    ].join(';'),
    role: 'alert',
  }, []);

  const showAlert = (msg: string): void => {
    alertBanner.textContent = msg;
    alertBanner.style.display = 'block';
  };
  const hideAlert = (): void => {
    alertBanner.textContent = '';
    alertBanner.style.display = 'none';
  };

  const preview = el('div', {
    style: 'font-size:var(--fs-xs);color:var(--ink-3);min-height:1.4em;margin-top:var(--s-2)',
  }, []);

  /** Extract the date portion of the picker as a Date object (local-time
   *  midnight). Used by Teams parser to anchor parsed HH:MM strings. */
  const currentBaseDate = (): Date => {
    const v = leadingDateTimePicker.getValue();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    return new Date();
  };

  /** Extract the HH:MM portion of the picker (empty string when blank). */
  const currentLeadingTime = (): string => {
    const v = leadingDateTimePicker.getValue();
    const m = v.match(/T(\d{2}):(\d{2})$/);
    return m ? `${m[1]}:${m[2]}` : '';
  };

  // Two-click confirmation for "register with empty leading author".
  // First 登録 click sets this true and shows a banner; second click
  // proceeds with fromName='' on the orphan.
  let pendingEmptyOk = false;
  const clearPendingEmptyOk = () => { pendingEmptyOk = false; };
  // Any input change un-arms the pending confirmation so the user
  // isn't surprised by a stale state.
  // (wired after the inputs exist; declarations below)

  const pad2 = (n: number): string => String(n).padStart(2, '0');

  /** Compute the auto-default for the leading-time input as HH:MM.
   *  - If the paste yielded >= 1 header-detected message, return
   *    (earliest detected time) - 1 minute.
   *  - Otherwise (no headers — only orphan body), return the current
   *    wall-clock time.
   *  Returns '' when the paste is empty / unparseable. */
  const computeDefaultLeadingTime = (text: string): string => {
    const probe = parseTeamsPaste(text, {}); // no leader hint
    if (probe.length === 0) {
      const d = new Date();
      return text.trim() ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
    }
    // Find earliest "HH:MM" among detected messages.
    const earliest = probe
      .map(m => m.time.match(/^(\d{1,2}):(\d{2})/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ h: Number(m[1]), mi: Number(m[2]) }))
      .sort((a, b) => (a.h * 60 + a.mi) - (b.h * 60 + b.mi))[0];
    if (!earliest) return '';
    const total = earliest.h * 60 + earliest.mi - 1;
    const h = Math.max(0, Math.floor(total / 60));
    const mi = ((total % 60) + 60) % 60;
    return `${pad2(h)}:${pad2(mi)}`;
  };

  /** Refresh only the time portion of the leading-datetime picker
   *  (keep the user-chosen date intact). */
  const refreshLeadingTimeDefault = (): void => {
    if (!usingDefaultLeadingTime) return;
    const auto = computeDefaultLeadingTime(bodyArea.value); // 'HH:MM' or ''
    const cur = leadingDateTimePicker.getValue();
    const dateMatch = cur.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch?.[1] ?? new Date().toISOString().slice(0, 10);
    if (auto) {
      leadingDateTimePicker.setValueQuiet(`${date}T${auto}`);
      leadingTimeHint.style.display = '';
    } else {
      leadingDateTimePicker.setValueQuiet(`${date}T00:00`);
      leadingTimeHint.style.display = 'none';
    }
  };

  const updatePreview = (): void => {
    const src = (sourceSel as HTMLSelectElement).value as Source;
    const baseDate = currentBaseDate();
    if (src === 'teams') {
      const raw = bodyArea.value.trim();
      refreshLeadingTimeDefault();

      if (!raw) { preview.textContent = ''; hideAlert(); return; }
      const leadingAuthor = authorInput.value.trim();
      const leadingTime = currentLeadingTime();
      const orphan = detectLeadingOrphan(bodyArea.value);
      // For live preview we still attribute the orphan using the current
      // (possibly empty) leadingAuthor. Empty-author warning is shown
      // only at submit time per the spec.
      const msgs = parseTeamsPaste(bodyArea.value, {
        leadingAuthor: orphan ? (leadingAuthor || '(不明)') : leadingAuthor,
        leadingTime,
      });

      // No live warning for missing leading author — moved to submit handler.
      // Only show the live banner when the paste is completely unparseable.
      if (msgs.length === 0) {
        preview.textContent = '';
        showAlert(
          '送信者を検出できませんでした。\n' +
          'コピー範囲に送信者名・時刻ヘッダが含まれているか確認してください。'
        );
        return;
      }
      hideAlert();

      const dupCount = msgs.filter(m =>
        existingFingerprints.has(fingerprint(m.author, resolveTeamsTimeToISO(m.time, baseDate, 0), m.body))
      ).length;
      const newCount = msgs.length - dupCount;
      const parts = [`抽出: ${msgs.length} 件`];
      if (newCount > 0) parts.push(`新規 ${newCount} 件`);
      if (dupCount > 0) parts.push(`重複スキップ ${dupCount} 件`);
      preview.textContent = parts.join(' / ');
    } else {
      hideAlert();
      const text = bodyArea.value.trim();
      if (!text) { preview.textContent = ''; return; }
      const dup = existingFingerprints.has(
        fingerprint(authorInput.value.trim(), baseDate.toISOString(), text)
      );
      preview.textContent = dup ? '⚠ 同じ時間の同じ履歴がすでに登録されています (登録するとスキップされます)' : '1 件登録予定';
    }
  };

  bodyArea.addEventListener('input', () => { clearPendingEmptyOk(); updatePreview(); });
  authorInput.addEventListener('input', () => { clearPendingEmptyOk(); updatePreview(); });
  // (leadingDateTimePicker user-edit handled via its onUserEdit callback)
  sourceSel.addEventListener('change', () => {
    const src = (sourceSel as HTMLSelectElement).value as Source;
    // Update 送信者 placeholder so the user knows the field's meaning
    // in the current source mode (leading speaker for Teams,
    // single-comment sender for mail / other).
    authorInput.placeholder = src === 'teams'
      ? '先頭メッセージの送信者 (Teams の仕様で取得できないため手入力)'
      : '送信者名 (任意)';
    updatePreview();
  });

  // Consistent 2-column form grid. Same field order as the edit modal:
  //   ソース → 送信時間 → 送信者 → 本文
  const labelStyle =
    'color:var(--ink-3);font-size:var(--fs-sm);' +
    'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
  const labelTopStyle = labelStyle + ';align-self:start;padding-top:8px';

  const dateTimeCell = el('div', {
    style: 'display:flex;gap:var(--s-3);align-items:center;flex-wrap:wrap',
  }, [leadingDateTimePicker.el, leadingTimeHint]);

  const bodyCell = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2)' }, [
    alertBanner,
    bodyArea,
    preview,
  ]);

  const body = el('div', {
    style:
      'display:grid;grid-template-columns:72px minmax(0,1fr);' +
      'gap:var(--s-4) var(--s-4);align-items:center',
  }, [
    el('label', { style: labelStyle }, ['ソース']),     sourceSel,
    el('label', { style: labelStyle }, ['送信時間']),   dateTimeCell,
    el('label', { style: labelStyle }, ['送信者']),
    el('div', { style: 'display:contents' }, [authorInput, authorDatalist]),
    el('label', { style: labelTopStyle }, ['本文']),    bodyCell,
    // Footer hint spans both columns
    el('div', {
      style:
        'grid-column:1 / -1;' +
        'font-size:var(--fs-xs);color:var(--ink-3);' +
        'background:var(--paper-2);padding:var(--s-3);' +
        'border-radius:var(--r-2);line-height:1.6',
    }, [
      el('strong', {}, ['Teams ソースの取り込み手順']),
      el('div', {}, ['Teams で複数メッセージを範囲選択 → 右クリック → コピー → ここに貼り付け。']),
      el('div', { style: 'margin-top:var(--s-2);color:#78350f' }, [
        '⚠ ',
        el('strong', {}, ['先頭メッセージの送信者名は Teams の仕様で取れません']),
        '。「送信者」欄に送信者名を入れると、その本文も 1 件として取り込まれます。空のままなら「不明」として登録され、後からカードの「編集」で修正できます。',
      ]),
    ]),
  ]);

  // ---- Outlook .eml ドロップ取り込み -----------------------------------
  // 新規チケットモーダルと同様、Outlook for Mac は件名ドラッグで .eml
  // ファイル本体を渡してくるので、files → text/plain (eml 本文) →
  // text/plain (件名行) の 3 段階フォールバックで取り込む。
  // ドロップ時はソースを "mail" 固定。
  const applyParsedEmlToHistory = (parsed: ReturnType<typeof parseEml>): void => {
    (sourceSel as HTMLSelectElement).value = 'mail';
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    if (parsed.fromName && !authorInput.value.trim()) {
      authorInput.value = parsed.fromName;
      authorInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (parsed.dateISO) {
      const d = new Date(parsed.dateISO);
      const p2 = (n: number): string => String(n).padStart(2, '0');
      const local = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
      leadingDateTimePicker.setValueQuiet(local);
      // eml の Date を採用したので、テキスト変化に伴う auto-default 上書きを止める
      usingDefaultLeadingTime = false;
      leadingTimeHint.style.display = 'none';
    }
    if (parsed.body && !bodyArea.value.trim()) {
      bodyArea.value = parsed.body;
      bodyArea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (parsed.subject) {
      // 履歴モーダルには件名フィールドが無いので、本文先頭に「件名: ...」を
      // 入れて取りこぼしを防ぐ。すでに本文がある場合は付加しない。
      if (bodyArea.value === (parsed.body ?? '')) {
        bodyArea.value = `件名: ${parsed.subject}\n\n${bodyArea.value}`;
        bodyArea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    updatePreview();
  };

  // dragover は無条件で preventDefault — Outlook for Mac の NSFilePromise
  // ドラッグでは `dataTransfer.types` に 'Files' が出ないことがあり、target
  // 判定で accept が外れるため。preventDefault は「drop 受け入れ可能」の
  // シグナルだけなので、textarea へのテキスト挿入は drop 側で振り分ける。
  const handleHistoryDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const handleHistoryDrop = async (e: DragEvent): Promise<void> => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files ?? []);
    const types = Array.from(dt.types ?? []);
    console.debug('[spira/drop history]', {
      fileCount: files.length,
      fileNames: files.map(f => `${f.name} (${f.type || '?'}, ${f.size}B)`),
      types,
    });
    // .eml — Mac Outlook 主経路
    const emlFile = files.find(f =>
      /\.eml$/i.test(f.name) || f.type === 'message/rfc822',
    );
    if (emlFile) {
      e.preventDefault();
      try {
        const text = await emlFile.text();
        applyParsedEmlToHistory(parseEml(text));
        toast(getRoot(), `「${emlFile.name}」を取り込みました`, 'ok');
      } catch (err) {
        toast(getRoot(), `EML 読み取り失敗: ${(err as Error).message}`, 'error');
      }
      return;
    }
    // .msg — Outlook for Windows 主経路。@kenjiuno/msgreader でデコード。
    const msgFile = files.find(f =>
      /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook',
    );
    if (msgFile) {
      e.preventDefault();
      try {
        const parsed = await parseMsgFile(msgFile);
        console.debug('[spira/drop history] parseMsgFile result:', {
          subject: parsed.subject,
          fromName: parsed.fromName,
          fromEmail: parsed.fromEmail,
          dateISO: parsed.dateISO,
          bodyLen: parsed.body?.length ?? 0,
        });
        applyParsedEmlToHistory(parsed);
        toast(getRoot(), `「${msgFile.name}」を取り込みました`, 'ok');
        return;
      } catch (err) {
        console.warn('[spira/drop history] parseMsgFile threw:', err);
        toast(getRoot(), `.msg 読み取り失敗: ${(err as Error).message} — text/plain にフォールバックします`, 'warn', 8000);
        // 失敗時は text/plain 経路へ
      }
    } else if (files.length > 0) {
      // 未対応ファイル
      e.preventDefault();
      toast(getRoot(), `未対応のファイル形式: ${files[0]!.name}`, 'warn', 5000);
      return;
    }
    // ファイル以外は textarea 上の標準挙動を尊重 (ただし .msg ありなら処理続行)
    if (!msgFile && e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    const txt = dt.getData('text/plain') ?? '';
    console.debug('[spira/drop history] text/plain head (500ch):', txt.slice(0, 500));
    if (txt && looksLikeEml(txt)) {
      try { applyParsedEmlToHistory(parseEml(txt)); return; } catch { /* fall through */ }
    }
    // Outlook for Windows のドラッグ: From/Subject 等のヘッダ付き text/plain
    if (txt && looksLikeOutlookDrag(txt)) {
      try {
        const parsed = parseOutlookDragText(txt);
        console.debug('[spira/drop history] parseOutlookDragText result:', {
          subject: parsed.subject,
          fromName: parsed.fromName,
          fromEmail: parsed.fromEmail,
          dateISO: parsed.dateISO,
          bodyLen: parsed.body?.length ?? 0,
        });
        if (parsed.subject || parsed.fromName || parsed.fromEmail || parsed.body) {
          applyParsedEmlToHistory(parsed);
          toast(getRoot(), 'Outlook ヘッダから取り込みました', 'ok');
          return;
        }
      } catch (err) {
        console.warn('[spira/drop history] parseOutlookDragText threw:', err);
      }
    }
    if (txt) {
      // textarea 外にドロップされた素のテキストは本文に追記。
      bodyArea.value = bodyArea.value ? `${bodyArea.value}\n${txt}` : txt;
      bodyArea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  // capture フェーズで登録 → textarea の intrinsic file-drop より先に走る
  body.addEventListener('dragover', handleHistoryDragOver, { capture: true });
  body.addEventListener('drop', (e) => { void handleHistoryDrop(e); }, { capture: true });

  setTimeout(updatePreview, 0);

  openModal(getRoot(), {
    title: 'スレッドに履歴を追加',
    body,
    size: 'lg',
    primaryLabel: '登録',
    onPrimary: async () => {
      const src = (sourceSel as HTMLSelectElement).value as Source;
      const baseDate = currentBaseDate();
      const repo = getRepo();

      if (src === 'teams') {
        const leadingAuthor = authorInput.value.trim();
        const leadingTime = currentLeadingTime() || computeDefaultLeadingTime(bodyArea.value);
        const orphan = detectLeadingOrphan(bodyArea.value);

        // Submit-time warning: orphan exists but speaker not provided.
        // Show the yellow banner ONCE; the user can re-click 登録 to
        // proceed and register the first message with fromName='' so
        // it renders as "不明".
        if (orphan && !leadingAuthor && !pendingEmptyOk) {
          showAlert(
            '先頭送信者が未設定です。\n' +
            'このまま登録すると、先頭メッセージは「不明」として保存されます (後でカードの「編集」から修正できます)。\n' +
            'もう一度「登録」をクリックすると、不明扱いで続行します。'
          );
          pendingEmptyOk = true;
          throw new Error('pending-empty-confirm');
        }

        // Parser injects orphan only when leadingAuthor is non-empty;
        // pass '' explicitly via a sentinel and post-process below.
        const msgs = parseTeamsPaste(bodyArea.value, {
          leadingAuthor: orphan ? (leadingAuthor || ' UNKNOWN') : leadingAuthor,
          leadingTime,
        });
        // Replace sentinel with empty string so the saved fromName is empty.
        for (const m of msgs) if (m.author === ' UNKNOWN') m.author = '';

        if (msgs.length === 0) {
          showAlert(
            '送信者を検出できませんでした。\n' +
            'コピー範囲に送信者名・時刻ヘッダが含まれているか確認してください。'
          );
          throw new Error('no-messages');
        }
        let added = 0;
        let skipped = 0;
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const isoForKey = resolveTeamsTimeToISO(m.time, baseDate, 0);
          const fp = fingerprint(m.author, isoForKey, m.body);
          if (existingFingerprints.has(fp)) { skipped++; continue; }
          existingFingerprints.add(fp);
          try {
            await repo.addComment({
              ticketId: t.id,
              type: 'received',
              fromName: m.author,
              content: m.body,
              isHtml: false,
              sentAt: resolveTeamsTimeToISO(m.time, baseDate, i),
              source: 'teams',
            });
            added++;
          } catch (e) {
            console.warn('[spira] addComment failed for teams message:', e);
          }
        }
        const parts = [];
        if (added > 0) parts.push(`${added} 件追加`);
        if (skipped > 0) parts.push(`${skipped} 件重複スキップ`);
        toast(getRoot(), parts.length ? parts.join(' / ') : '追加なし', added > 0 ? 'ok' : 'warn');
      } else {
        const text = bodyArea.value.trim();
        if (!text) {
          toast(getRoot(), '本文が空です', 'warn');
          throw new Error('empty');
        }
        const fromName = authorInput.value.trim();
        const baseISO = baseDate.toISOString();
        const fp = fingerprint(fromName, baseISO, text);
        if (existingFingerprints.has(fp)) {
          toast(getRoot(), '同じ時間の同じ履歴がすでに登録されています', 'warn');
          throw new Error('duplicate');
        }
        try {
          await repo.addComment({
            ticketId: t.id,
            type: 'received',
            fromName: fromName || (src === 'mail' ? '(メール)' : '(履歴)'),
            content: text,
            isHtml: false,
            sentAt: baseISO,
            source: src,
          });
          toast(getRoot(), 'スレッドに追加しました', 'ok');
        } catch (e) {
          toast(getRoot(), `追加に失敗: ${(e as Error).message}`, 'error');
          throw e;
        }
      }
      setState({});
    },
  });
}

// ============================================================ edit comment modal

/** Inline editor for an existing received comment. Surfaces fromName
 *  (with the same AD + チケット内 datalist as the add modal) and sentAt
 *  (date + time) so the user can fix mistakes after registration.
 *
 *  Internal / external classification is derived from fromName, so
 *  changing the name here automatically updates the badge on the next
 *  render. "不明" appears when the name is left blank. */
function openEditCommentModal(_t: Ticket, c: Comment): void {
  const adUsers = getState().users;
  const datalistId = `spira-edit-author-${c.id}`;
  const datalist = el('datalist', { id: datalistId },
    adUsers.map(u => el('option', { value: u.displayName, label: u.email }, [])),
  );

  const fromNameInput = el('input', {
    type: 'text',
    class: 'spira-input',
    list: datalistId,
    placeholder: '(空欄なら不明)',
    style: 'width:100%;max-width:420px;min-width:0',
    autocomplete: 'off',
    value: c.fromName ?? '',
  }) as HTMLInputElement;

  // Combined YYYY/MM/DD HH:MM widget with calendar icon on the right.
  const dateTimePicker = createDateTime({ initial: c.sentAt });

  // ソース選択。legacy コメント (source 未設定) は 'mail' 扱いで初期化。
  const initialSource: 'mail' | 'teams' | 'other' = c.source ?? 'mail';
  const sourceSel = el('select', {
    class: 'spira-input',
    style: 'width:200px;min-width:0',
  }, [
    el('option', { value: 'mail',  ...(initialSource === 'mail'  ? { selected: 'selected' } : {}) }, ['メール']),
    el('option', { value: 'teams', ...(initialSource === 'teams' ? { selected: 'selected' } : {}) }, ['Teams']),
    el('option', { value: 'other', ...(initialSource === 'other' ? { selected: 'selected' } : {}) }, ['その他']),
  ]) as HTMLSelectElement;

  // 本文 textarea。
  //   - isHtml === false (Teams ペースト / 手動追加): プレーンテキストとして表示
  //   - isHtml === true  (メール取り込み): 生 HTML が見えるが編集は可能。
  //     注意書きで「整形が崩れる可能性」を明示し、保存時は isHtml フラグを維持。
  const contentArea = el('textarea', {
    class: 'spira-input',
    rows: '10',
    style: 'width:100%;font:13px/1.55 ui-monospace,Menlo,monospace;resize:vertical',
  }) as HTMLTextAreaElement;
  // textarea content must be set via .value (the `value` attribute
  // doesn't populate the displayed text).
  contentArea.value = c.content;

  const htmlWarning = c.isHtml ? el('div', {
    style: 'font-size:var(--fs-xs);color:#78350f;background:#fef3c7;border:1px solid #f59e0b;padding:var(--s-2) var(--s-3);border-radius:var(--r-2)',
  }, [
    '⚠ このカードは HTML 形式 (メール取り込み) です。本文は生 HTML として表示・編集されます。タグを誤って削除すると整形が崩れます。',
  ]) : null;

  // Consistent 2-column form grid (same look as the add-history modal).
  const labelStyle =
    'color:var(--ink-3);font-size:var(--fs-sm);' +
    'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
  const labelTopStyle = labelStyle + ';align-self:start;padding-top:8px';

  const bodyCell = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2)' }, [
    ...(htmlWarning ? [htmlWarning] : []),
    contentArea,
  ]);

  // Same field order as the add-history modal: ソース → 送信時間 → 送信者 → 本文
  const body = el('div', {
    style:
      'display:grid;grid-template-columns:72px minmax(0,1fr);' +
      'gap:var(--s-4) var(--s-4);align-items:center',
  }, [
    el('label', { style: labelStyle }, ['ソース']),    sourceSel,
    el('label', { style: labelStyle }, ['送信時間']),  dateTimePicker.el,
    el('label', { style: labelStyle }, ['送信者']),
    el('div', { style: 'display:contents' }, [fromNameInput, datalist]),
    el('label', { style: labelTopStyle }, ['本文']),    bodyCell,

    el('div', {
      style:
        'grid-column:1 / -1;' +
        'font-size:var(--fs-xs);color:var(--ink-3);' +
        'background:var(--paper-2);padding:var(--s-3);' +
        'border-radius:var(--r-2);line-height:1.6',
    }, [
      '送信者を空欄にすると ',
      el('strong', {}, ['不明']),
      ' バッジで表示されます。内部/外部の判定は AD 表示名と「内部メンバー設定」をもとに自動で行われます (変更後は再描画で反映)。',
    ]),
  ]);

  openModal(getRoot(), {
    title: 'カードを編集',
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: async () => {
      const fromName = fromNameInput.value.trim();
      let sentAt = c.sentAt;
      const v = dateTimePicker.getValue(); // 'YYYY-MM-DDTHH:MM' or ''
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (m) {
        sentAt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0).toISOString();
      }
      try {
        await getRepo().updateComment(c.id, {
          fromName: fromName || null,
          sentAt,
          content: contentArea.value,
          isHtml: c.isHtml, // preserve the original flag
          source: sourceSel.value as 'mail' | 'teams' | 'other',
        });
        toast(getRoot(), '更新しました', 'ok');
        setState({});
      } catch (e) {
        toast(getRoot(), `更新失敗: ${(e as Error).message}`, 'error');
        throw e;
      }
    },
  });
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

function renderReceivedThread(t: Ticket, received: Comment[], lastSeen: number | null = null): HTMLElement {
  if (received.length === 0) {
    return el('div', { class: 'spira-empty', style: 'padding:var(--s-7)' }, [
      'メールのやり取りはまだありません',
    ]);
  }
  return el('div', { class: 'spira-th-list' }, received.map(c => renderReceivedCard(t, c, lastSeen)));
}

function renderReceivedCard(t: Ticket, c: Comment, lastSeen: number | null = null): HTMLElement {
  const hasAuthor = !!((c.fromName ?? '').trim() || (c.fromEmail ?? '').trim());
  const internal = hasAuthor && isInternalAuthor(c, getState().users);
  const hasImage = commentHasImage(c);
  const isNew = isCommentNewSince(c.sentAt, lastSeen);

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

  const editBtn = el('button', {
    class: 'spira-btn spira-btn--sm spira-btn--icon-action',
    style: 'flex-shrink:0',
    title: '送信者・時刻を編集',
    'aria-label': 'カードを編集',
    onclick: (e: Event) => {
      e.stopPropagation();
      openEditCommentModal(t, c);
    },
  }, [
    el('span', { html: icon('edit'), style: 'display:inline-flex;width:14px;height:14px' }),
  ]);

  const deleteBtn = el('button', {
    class: 'spira-btn spira-btn--sm spira-btn--icon-trash',
    style: 'flex-shrink:0',
    title: 'このカードをスレッドから削除',
    'aria-label': 'スレッドから削除',
    onclick: (e: Event) => {
      e.stopPropagation();
      confirmModal(getRoot(), {
        title: 'スレッドから削除',
        message: 'このカードをスレッドから削除します。元に戻せません。',
        primaryLabel: '削除',
        primaryVariant: 'danger',
        onConfirm: async () => {
          try {
            await getRepo().deleteComment(c.id);
            expandedReceived.delete(c.id);
            toast(getRoot(), 'スレッドから削除しました', 'ok');
            setState({});
          } catch (err) {
            toast(getRoot(), `削除失敗: ${(err as Error).message}`, 'error');
          }
        },
      });
    },
  }, [el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const statusBadge = !hasAuthor
    ? el('span', {
        class: 'spira-badge spira-badge--muted',
        style: 'margin-left:var(--s-2);font-size:var(--fs-xs);background:var(--paper-3);color:var(--ink-3)',
      }, ['不明'])
    : internal
      ? el('span', { class: 'spira-badge spira-badge--muted', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['内部'])
      : el('span', { class: 'spira-badge spira-badge--warn', style: 'margin-left:var(--s-2);font-size:var(--fs-xs)' }, ['外部']);

  // Pick the leading icon by source. Legacy received comments without a
  // source default to the mail envelope (most legacy data was auto-
  // imported from InboxMails).
  const sourceIconName = c.source === 'teams' ? 'chat'
    : c.source === 'other' ? 'bookmark'
    : 'mail';
  const sourceIconTitle = c.source === 'teams' ? 'Teams から取り込み'
    : c.source === 'other' ? 'その他のソース'
    : 'メール';

  const newBadge = isNew
    ? el('span', { class: 'spira-badge spira-badge--new', title: '前回表示時以降の新着' }, ['NEW'])
    : null;

  const head = el('div', { class: 'spira-th-card-head', style: 'flex-wrap:wrap;gap:var(--s-2)' }, [
    el('span', { html: icon(sourceIconName), title: sourceIconTitle }),
    el('span', { class: 'spira-th-card-from' }, [hasAuthor ? (c.fromName ?? c.fromEmail ?? '(unknown)') : '(送信者未設定)']),
    c.fromEmail ? el('span', { style: 'color:var(--ink-3)' }, [` <${c.fromEmail}>`]) : '',
    statusBadge,
    ...tagPills,
    // 送信日時 + バッジ (NEW / 更新) を同じグループにまとめて常に同じ行に。
    // NEW と 更新 はそれぞれ別タイミングで動的に挿入される (NEW は最初の
    // 描画時、更新 は markCardUpdated 経由)。
    el('span', {
      class: 'spira-card-date-group',
      style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex-shrink:0',
    }, [
      el('span', {
        class: 'spira-card-date',
        style: 'color:var(--ink-3);font-size:var(--fs-sm)',
      }, [fmtDate(c.sentAt)]),
      ...(newBadge ? [newBadge] : []),
    ]),
    editBtn,
    deleteBtn,
  ]);

  // 登録・更新情報行 (SP の Author / Editor + Created / Modified)。
  // 受信カードに「誰がいつ登録/更新したか」を明示する。SP 環境では
  // Author/Editor が expand で取得され、mock では fromName をフォール
  // バックに使う。
  const createdBy = c.createdBy ?? c.fromName ?? c.fromEmail ?? '?';
  const createdAt = c.createdAt ?? c.sentAt;
  const auditParts: HTMLElement[] = [
    el('span', {}, [`登録: ${createdBy}${createdAt ? ` (${fmtDate(createdAt)})` : ''}`]),
  ];
  if (c.updatedAt && c.createdAt && c.updatedAt !== c.createdAt) {
    auditParts.push(el('span', {}, [
      `更新: ${c.updatedBy ?? '?'} (${fmtDate(c.updatedAt)})`,
    ]));
  }
  const auditLine = el('div', {
    class: 'spira-th-card-audit',
    style: 'font-size:var(--fs-xs);color:var(--ink-3);padding:2px 0;display:flex;gap:var(--s-3);flex-wrap:wrap',
  }, auditParts);

  const body = el('div', { class: 'spira-th-card-body' });
  // renderMailBody handles the awkward case where PA's "Body" returns
  // a plain-text mail as HTML without any <br>/<p> tags — converting
  // its literal \n line breaks into <br> so the message stays readable.
  renderMailBody(body, c.isHtml ? c.content : null, c.isHtml ? null : c.content);

  const card = el('div', {
    class: 'spira-th-card spira-th-card--received',
    'data-side': !hasAuthor ? 'unknown' : internal ? 'internal' : 'external',
    'data-comment-id': String(c.id),
  }, [head, auditLine, body]);
  attachCollapseToggle(card, body, c.id, expandedReceived);
  return card;
}

// ============================================================ right: notes pane (editable)

function renderNotesPane(_t: Ticket, notes: Comment[], lastSeen: number | null = null): HTMLElement {
  // +メモを追加 はペインタイトル右側のボタンに移動済み (renderSplitPanes 内で
  // addNoteBtn を作成して paneTitle に渡している)。
  const list = el('div', { class: 'spira-th-list' }, notes.length === 0
    ? [el('div', { class: 'spira-empty', style: 'padding:var(--s-5)' }, ['メモはまだありません'])]
    : notes.map(n => renderNoteCard(n, lastSeen))
  );
  return el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-5)' }, [list]);
}

function renderNoteCard(c: Comment, lastSeen: number | null = null): HTMLElement {
  // 登録者と最終更新者でカードの色付けを分ける。
  //   - border-left: 登録者 (createdBy) の色 — カードの左端アクセント
  //   - 右側に幅 4px の縦バー (background-image gradient): 更新者 (updatedBy)
  //     の色。登録者と異なる場合のみ表示して「誰が最後に触ったか」を示す。
  const creatorKey = (c.createdBy ?? c.fromName ?? c.fromEmail ?? '').toLowerCase();
  const updaterKey = (c.updatedBy ?? c.createdBy ?? c.fromName ?? c.fromEmail ?? '').toLowerCase();
  const creatorColor = colorForAuthor(creatorKey);
  const updaterColor = colorForAuthor(updaterKey);
  const creatorTint = tintForAuthor(creatorKey, 0.10);
  const sameAuthor = creatorKey === updaterKey;
  // 視認性のため:
  //  - 左ボーダーを 4px に拡張 + creator 色
  //  - 背景に creator 色の薄いティント (alpha 0.10) を重ねる
  //  - 更新者が異なる場合は右端 6px に updater 色のバー (linear-gradient)
  // background-color と background-image は同時指定できるので tint を残しつつ
  // バーを描画できる。
  const styleParts = [
    `border-left: 4px solid ${creatorColor}`,
    `background-color: ${creatorTint}`,
  ];
  if (!sameAuthor) {
    styleParts.push(
      `background-image: linear-gradient(to left, ${updaterColor} 0, ${updaterColor} 6px, transparent 6px)`,
    );
  }
  const card = el('div', {
    class: 'spira-th-card spira-th-card--note',
    'data-comment-id': String(c.id),
    'data-created-by': c.createdBy ?? c.fromName ?? '',
    'data-updated-by': c.updatedBy ?? '',
    style: styleParts.join('; '),
    title: sameAuthor
      ? `登録/更新: ${c.createdBy ?? c.fromName ?? ''}`
      : `登録: ${c.createdBy ?? c.fromName ?? ''}\n最終更新: ${c.updatedBy ?? ''}`,
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
      // Tell the parent ticketDetail's polling loop that this change
      // came from this client. Without this, the next 30-sec poll would
      // see a fingerprint mismatch and show the "他のメンバーが…"
      // banner against the user's own save.
      markRecentlySavedByMe(c.id);
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
    class: 'spira-btn spira-btn--sm spira-btn--icon-trash',
    style: 'flex-shrink:0',
    title: 'メモを削除',
    'aria-label': 'メモを削除',
    onclick: onDelete,
  }, [el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' })]);

  const isNew = isCommentNewSince(c.sentAt, lastSeen);
  const newBadge = isNew
    ? el('span', { class: 'spira-badge spira-badge--new', title: '前回表示時以降の新着' }, ['NEW'])
    : null;

  // status (= 日付/保存中ラベル) + NEW + 更新 を date-group にまとめて
  // 受信カードと同じ並びに統一。
  const dateGroup = el('span', {
    class: 'spira-card-date-group',
    style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex-shrink:0',
  }, [
    status,
    ...(newBadge ? [newBadge] : []),
  ]);

  const headRow = el('div', {
    class: 'spira-th-card-head',
    style: 'flex-wrap:wrap;gap:var(--s-2);align-items:center',
  }, [
    el('span', { html: icon('note') }),
    el('span', { class: 'spira-th-card-from' }, [c.fromName ?? c.fromEmail ?? '(unknown)']),
    dateGroup,
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

  // ポーリングからアクセスできるようにレジストリに登録。card が detach
  // されたら自動でレジストリからも除去。
  noteEditorRegistry.set(c.id, { editor, comment: c });
  if (typeof MutationObserver !== 'undefined') {
    let wasConn = false;
    const obs = new MutationObserver(() => {
      if (card.isConnected) { wasConn = true; return; }
      if (!wasConn) return;
      if (noteEditorRegistry.get(c.id)?.editor === editor) {
        noteEditorRegistry.delete(c.id);
      }
      obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  return card;
}

/** Add an empty memo card; inline autosave handles content entry.
 *  Scrolls the new card into view and focuses its editor so the user
 *  can immediately start typing. */
async function addNewNote(t: Ticket): Promise<void> {
  try {
    const me = getState().currentUser;
    const created = await getRepo().addComment({
      ticketId: t.id, type: 'note',
      fromEmail: me?.email,
      fromName: me?.displayName,
      content: '', isHtml: false,
    });
    setState({});
    // After re-render, scroll the new card into view and focus its
    // editor. setTimeout to wait for the next paint after setState.
    setTimeout(() => {
      const card = document.querySelector<HTMLElement>(
        `.spira-th-card--note[data-comment-id="${created.id}"]`,
      );
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const content = card.querySelector<HTMLElement>('.ne-content');
      content?.focus();
    }, 60);
  } catch (e) {
    toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
  }
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('#spira-root') ?? document.body;
}
