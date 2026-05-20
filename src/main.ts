// Spira — bookmarklet entry. Renders overlay onto <body>.
import css from './styles/app.css';
import noteEditorCss from './lib/note-editor/editor.css';
import { initRepo, getRepo, getRepoMode, detectMode } from './api/repo';
import { openSiteSelectionModal } from './views/siteSelectionModal';
import { renderShell } from './views/shell';
import { openNewTicketModal, inboxRowsWithTag } from './views/inbox';
import { loadVersionInfo, isOutdated, isCurrentNewer, saveLatestBuildId } from './utils/versionCheck';
import { openSearchModal } from './views/search';
import { toast } from './components/toast';
import { setState, getState } from './state';
import type { InboxMail } from './types';

declare global {
  // eslint-disable-next-line no-var
  var __SPIRA_MOUNTED__: boolean | undefined;
}

// ── 受信自動更新タイマー (SpiraSettings.inboxSyncIntervalSec で制御) ───────
// startAutoSync() で起動、restartAutoSync() で設定変更後に再構築する。
let autoSyncTimer: number | null = null;
let autoSyncRoot: HTMLElement | null = null;

async function startAutoSync(root: HTMLElement): Promise<void> {
  autoSyncRoot = root;
  if (autoSyncTimer != null) {
    window.clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  try {
    const { getSyncIntervalSec } = await import('./views/syncIntervalModal');
    const sec = await getSyncIntervalSec();
    if (sec === 0) {
      console.log('[spira] auto-sync: OFF');
      return;
    }
    autoSyncTimer = window.setInterval(() => {
      if (!getState().ready) return;
      // タブが裏側のときは結果が反映できないので silent でも回さない方が良い
      // ように見えるが、SP 側の更新は走らせて inboxCount だけは更新したいので
      // そのまま実行する (visibilitychange は将来検討)。
      void doSync(autoSyncRoot!, /* silent */ true);
    }, sec * 1000);
    console.log(`[spira] auto-sync: every ${sec}s`);
  } catch (e) {
    console.warn('[spira] auto-sync setup failed:', (e as Error).message);
  }
}

/** 設定変更時に外部から呼び出してタイマーを再構築する。 */
export async function restartAutoSync(): Promise<void> {
  if (!autoSyncRoot) return;
  await startAutoSync(autoSyncRoot);
}

export async function mount(): Promise<void> {
  if (window.__SPIRA_MOUNTED__) {
    document.querySelector<HTMLElement>('.spira-root')?.remove();
  }
  if (!document.getElementById('spira-styles')) {
    const style = document.createElement('style');
    style.id = 'spira-styles';
    // App styles + note-editor package styles. Both are scoped (Spira via
    // #spira-root, note-editor via .ne-* classes), so order doesn't matter.
    style.textContent = css + '\n' + noteEditorCss;
    document.head.appendChild(style);
  }

  // Mount shell first so user sees something while repo initializes.
  const root = renderShell();
  document.body.appendChild(root);
  window.__SPIRA_MOUNTED__ = true;

  try {
    const saved = localStorage.getItem('spira:theme');
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
  } catch { /* noop */ }

  // 文字サイズ設定の復元 (data-font-size 属性経由で CSS スケール切替)
  try {
    const { applyFontSize } = await import('./utils/fontSize');
    applyFontSize();
  } catch { /* noop */ }

  // Click delegation for [data-action]
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'sync') doSync(root);
    if (action === 'new-ticket') doNewTicket();
  });

  // Cmd/Ctrl+K opens the search modal from anywhere. We capture early
  // so it works even when focus is inside an editable element. The
  // search modal itself handles Escape close.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openSearchModal();
    }
  });

  // Initialize repo (mock or SP) → bootstrap lists → load counts/users.
  try {
    // SP モードの場合、起動時にサイト選択モーダルを表示。前回選択サイトが
    // localStorage にあれば初期選択。決定後に repo を作成する。
    // ユーザーがキャンセルした場合は Spira を起動せずクリーンに撤退する。
    let overrideSiteUrl: string | undefined;
    if (detectMode() === 'sp') {
      const sel = await openSiteSelectionModal();
      if (sel == null) {
        // キャンセル → mount したルートを撤去して終了 (ブックマーク再実行で再表示)
        root.remove();
        window.__SPIRA_MOUNTED__ = false;
        return;
      }
      overrideSiteUrl = sel.siteUrl;
    }
    const initRes = await initRepo({ overrideSiteUrl });
    const repo = getRepo();

    if (initRes.mode === 'sp') {
      const r = await repo.ensureLists() as { created: string[]; addedFields?: string[] };
      const msgs: string[] = [];
      if (r.created.length > 0) msgs.push(`リスト作成: ${r.created.join(' / ')}`);
      if (r.addedFields && r.addedFields.length > 0) msgs.push(`列追加: ${r.addedFields.length}件`);
      if (msgs.length > 0) toast(root, `初期セットアップ完了 — ${msgs.join(' / ')}`, 'ok', 8000);
    }

    // load counts & users & current user
    const [inbox, trash, users, currentUser] = await Promise.all([
      repo.listInbox({ unprocessedOnly: true }),
      repo.listDeletedTickets(),
      repo.listSiteUsers(),
      repo.getCurrentUser(),
    ]);
    setState({
      inboxCount: inboxRowsWithTag(inbox).length,
      trashCount: trash.length,
      users,
      currentUser,
      ready: true,
    });

    // first-load auto sync
    setTimeout(() => doSync(root, /* silent */ true), 100);

    // 定期自動更新タイマーを起動 (SpiraSettings の inboxSyncIntervalSec で制御)
    setTimeout(() => { void startAutoSync(root); }, 500);

    // 監査ログのクリーンアップ (24h 経過時のみ実行)。失敗してもサイレント。
    setTimeout(() => {
      void import('./lib/audit').then(({ runStartupCleanup }) => runStartupCleanup());
    }, 2000);

    // バージョンチェック — SP の SpiraSettings に登録された latest と比較:
    //   - current のビルド日時 > latest なら自動で latest を current に更新
    //     (新版を開いたユーザーが SoT になる)
    //   - current < latest なら更新バナー表示 (ユーザーが古い)
    //   - 同じなら何もしない
    // 失敗はサイレントに無視 (バージョン情報未登録の環境では何も起きない)。
    void loadVersionInfo().then(async (info) => {
      if (isCurrentNewer(info)) {
        try { await saveLatestBuildId(info.current); }
        catch { /* noop */ }
        return;
      }
      if (isOutdated(info)) {
        setState({
          updateBanner: {
            message: `新しいバージョン (${info.latest}) があります。現在のビルド: ${info.current}`,
            url: info.updateUrl,
          },
        });
      }
    }).catch(() => { /* noop */ });
  } catch (e) {
    const msg = (e as Error).message;
    setState({ errorBanner: `初期化に失敗しました: ${msg}` });
    toast(root, `初期化エラー: ${msg}`, 'error');
  }

  // Mode hint in console (dev aid)
  console.log(`[spira] build: ${__SPIRA_BUILD_ID__}`);
  console.log(`[spira] repo mode: ${getRepoMode()}`);
}

async function doSync(root: HTMLElement, silent = false): Promise<void> {
  const repo = getRepo();
  // dev affordance: in mock mode, simulate inbound mail occasionally
  if (getRepoMode() === 'mock' && Math.random() < 0.5) {
    repo.injectFakeReply?.(1);
  }
  const syncBtn = root.querySelector<HTMLElement>('[data-action="sync"]');
  // silent (= 定期自動同期) では同期ボタンを回さない。チラつきの一因。
  if (!silent) syncBtn?.classList.add('spira-spin');
  try {
    const r = await repo.syncInbox();
    const inbox = await repo.listInbox({ unprocessedOnly: true });
    const newCount = inboxRowsWithTag(inbox).length;
    if (silent) {
      // 自動同期では画面全体の再描画 (paintMain) を起こしたくないので
      // silent モードで state だけ更新し、サイドバーの inbox バッジは
      // 直接 DOM 操作で書き換える。チケット詳細・受信一覧の差分反映は
      // それぞれの polling / 次回手動操作で行われる。
      setState({ inboxCount: newCount }, { silent: true });
      updateInboxBadge(root, newCount);
    } else {
      setState({ inboxCount: newCount });
      const errs = r.errors.length ? ` · エラー ${r.errors.length}件` : '';
      toast(root, `同期完了 · 自動紐付け ${r.autoLinked} 件 / 未処理 ${r.remaining} 件${errs}`, r.errors.length ? 'warn' : 'ok');
    }
  } catch (e) {
    if (!silent) toast(root, `同期失敗: ${(e as Error).message}`, 'error');
    else console.warn('[spira] silent sync failed:', (e as Error).message);
  } finally {
    if (!silent) syncBtn?.classList.remove('spira-spin');
  }
}

/** サイドバー「受信」項目のバッジ件数を DOM 直接更新。silent sync 用。 */
function updateInboxBadge(root: HTMLElement, count: number): void {
  const item = root.querySelector<HTMLElement>('[data-side-item="inbox"]');
  if (!item) return;
  let badge = item.querySelector<HTMLElement>('.spira-side-count');
  if (count > 0) {
    if (!badge) {
      // バッジが無かったら作る (count が 0 → 1 のとき)。
      badge = document.createElement('span');
      badge.className = 'spira-side-count';
      item.appendChild(badge);
    }
    badge.textContent = String(count);
  } else if (badge) {
    badge.remove();
  }
}

function doNewTicket(): void {
  if (!getState().ready) return;
  const blank: InboxMail = {
    id: 0, subject: '', bodyHtml: '', bodyText: '',
    fromEmail: '', fromName: '',
    receivedAt: new Date().toISOString(),
    hasAttachments: false, isProcessed: false,
  };
  openNewTicketModal(blank);
}

// Auto-mount when bundled & loaded as <script>
if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  mount();
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', mount);
}
