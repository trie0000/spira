// Spira — bookmarklet entry. Renders overlay onto <body>.
import css from './styles/app.css';
import { seedMock, syncMock, injectFakeReplyMock } from './api/mock';
import { renderShell } from './views/shell';
import { openNewTicketModal } from './views/inbox';
import { toast } from './components/toast';
import { setState } from './state';
import type { InboxMail } from './types';

declare global {
  // eslint-disable-next-line no-var
  var __SPIRA_MOUNTED__: boolean | undefined;
}

export function mount(): void {
  if (window.__SPIRA_MOUNTED__) {
    document.querySelector<HTMLElement>('.spira-root')?.remove();
  }
  // inject styles once
  if (!document.getElementById('spira-styles')) {
    const style = document.createElement('style');
    style.id = 'spira-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  seedMock();
  const root = renderShell();
  document.body.appendChild(root);
  window.__SPIRA_MOUNTED__ = true;

  // theme persistence
  try {
    const saved = localStorage.getItem('spira:theme');
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
  } catch { /* noop */ }

  // wire global click delegation for [data-action]
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'sync') doSync(root);
    if (action === 'new-ticket') doNewTicket(root);
  });

  // first-load auto sync
  setTimeout(() => doSync(root, /* silent */ true), 200);
}

function doSync(root: HTMLElement, silent = false): void {
  // simulate inbox refresh: occasionally inject a reply for an existing ticket
  if (Math.random() < 0.5) injectFakeReplyMock(1);
  const result = syncMock();
  if (!silent) {
    const msg = `同期完了 · 自動紐付け ${result.autoLinked} 件 / 未処理 ${result.remaining} 件`;
    toast(root, msg, 'ok');
  }
  setState({});
}

function doNewTicket(_root: HTMLElement): void {
  // ad-hoc: open new ticket modal with empty mail (no source mail)
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
