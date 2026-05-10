// Spira — bookmarklet entry. Renders overlay onto <body>.
import css from './styles/app.css';
import { initRepo, getRepo, getRepoMode } from './api/repo';
import { renderShell } from './views/shell';
import { openNewTicketModal } from './views/inbox';
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
    style.textContent = css;
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

  // Initialize repo (mock or SP) → bootstrap lists → load counts/users.
  try {
    const initRes = await initRepo();
    const repo = getRepo();

    if (initRes.mode === 'sp') {
      const r = await repo.ensureLists();
      if (r.created.length > 0) {
        toast(root, `初期セットアップ: ${r.created.join(' / ')} を作成しました`, 'ok', 8000);
      }
    }

    // load counts & users
    const [inbox, trash, users] = await Promise.all([
      repo.listInbox({ unprocessedOnly: true }),
      repo.listDeletedTickets(),
      repo.listSiteUsers(),
    ]);
    setState({
      inboxCount: inbox.length,
      trashCount: trash.length,
      users,
      ready: true,
    });

    // first-load auto sync
    setTimeout(() => doSync(root, /* silent */ true), 100);
  } catch (e) {
    const msg = (e as Error).message;
    setState({ errorBanner: `初期化に失敗しました: ${msg}` });
    toast(root, `初期化エラー: ${msg}`, 'error');
  }

  // Mode hint in console (dev aid)
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
    const inbox = await repo.listInbox({ unprocessedOnly: true });
    setState({ inboxCount: inbox.length });
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
