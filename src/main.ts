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
    let overrideSiteUrl: string | undefined;
    if (detectMode() === 'sp') {
      const sel = await openSiteSelectionModal();
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
      repo.listInbox({}),
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
  syncBtn?.classList.add('spira-spin');
  try {
    const r = await repo.syncInbox();
    const inbox = await repo.listInbox({});
    setState({ inboxCount: inboxRowsWithTag(inbox).length });
    if (!silent) {
      const errs = r.errors.length ? ` · エラー ${r.errors.length}件` : '';
      toast(root, `同期完了 · 自動紐付け ${r.autoLinked} 件 / 未処理 ${r.remaining} 件${errs}`, r.errors.length ? 'warn' : 'ok');
    }
  } catch (e) {
    toast(root, `同期失敗: ${(e as Error).message}`, 'error');
  } finally {
    syncBtn?.classList.remove('spira-spin');
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
