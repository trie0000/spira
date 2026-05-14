import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, subscribe } from '../state';
import { renderTicketList } from './ticketList';
import { renderTicketDetail } from './ticketDetail';
import { renderInbox } from './inbox';
import { renderTrash } from './trash';
import { confirmModal, openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo, getRepoMode } from '../api/repo';
import { getInternalMembers, setInternalMembers } from '../utils/members';
import {
  getTicketIdPrefix, setTicketIdPrefix, formatTicketTagWith, sanitizePrefix,
} from '../utils/ticketTag';

export function renderShell(): HTMLElement {
  // id + class — ID セレクタで host CSS の !important / ID rules を上書きできる
  const root = el('div', { id: 'spira-root', class: 'spira-root', 'data-theme': 'light' });
  const main = el('main', { class: 'spira-main' });
  const sideWrap = el('div', { style: 'display:contents' });
  sideWrap.appendChild(renderSidebar());
  const topbar = renderTopbar(root);
  const errorSlot = el('div');

  const shell = el('div', { class: 'spira-shell' }, [
    topbar,
    errorSlot,
    el('div', { class: 'spira-body' }, [sideWrap, main]),
  ]);
  root.appendChild(shell);

  // initial paint + on state change
  paintMain(main);
  subscribe(() => {
    paintMain(main);
    clear(sideWrap);
    sideWrap.appendChild(renderSidebar());
    paintErrorBanner(errorSlot);
  });
  return root;
}

let paintToken = 0;

async function paintMain(main: HTMLElement): Promise<void> {
  const myToken = ++paintToken;
  const s = getState();

  // Capture focus state before re-render so inputs marked with `data-focus-key`
  // can restore focus & cursor position after DOM replacement.
  const focusInfo = captureFocus(main);

  // Show skeleton immediately
  clear(main);
  main.appendChild(renderSkeleton());

  // Wait until repo + counts are ready before fetching view data.
  if (!s.ready) return;

  try {
    let view: HTMLElement;
    if (s.view === 'tickets') {
      view = s.selectedTicketId != null
        ? await renderTicketDetail(s.selectedTicketId)
        : await renderTicketList();
    } else if (s.view === 'inbox') {
      view = await renderInbox();
    } else {
      view = await renderTrash();
    }
    if (myToken !== paintToken) return; // stale
    clear(main);
    main.appendChild(view);
    restoreFocus(main, focusInfo);
  } catch (e) {
    if (myToken !== paintToken) return;
    clear(main);
    main.appendChild(renderError(e as Error));
  }
}

interface FocusInfo {
  key: string;
  selStart: number | null;
  selEnd: number | null;
}

function captureFocus(main: HTMLElement): FocusInfo | null {
  const ae = document.activeElement as (HTMLInputElement | HTMLTextAreaElement | HTMLElement) | null;
  if (!ae || !main.contains(ae)) return null;
  const key = (ae as HTMLElement).getAttribute('data-focus-key');
  if (!key) return null;
  const isText = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
  return {
    key,
    selStart: isText ? ae.selectionStart : null,
    selEnd: isText ? ae.selectionEnd : null,
  };
}

function restoreFocus(main: HTMLElement, info: FocusInfo | null): void {
  if (!info) return;
  const next = main.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${info.key}"]`);
  if (!next) return;
  next.focus();
  if (info.selStart != null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(info.selStart, info.selEnd ?? info.selStart);
    } catch { /* unsupported on number/email — ignore */ }
  }
}

function renderSkeleton(): HTMLElement {
  return el('div', { class: 'spira-content', style: 'display:flex;flex-direction:column;gap:var(--s-3)' }, [
    el('div', { class: 'spira-skeleton', style: 'height:38px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
    el('div', { class: 'spira-skeleton', style: 'height:42px' }),
  ]);
}

function renderError(e: Error): HTMLElement {
  const fullText = errorToText(e);
  const msgEl = el('pre', {
    style: 'max-width:560px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:var(--paper-2);border:1px solid var(--paper-3);border-radius:var(--r-2);padding:var(--s-4);font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);user-select:text',
  }, [fullText]);

  const copyBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(fullText);
        copyBtn.textContent = '✓ コピーしました';
        setTimeout(() => { copyBtn.replaceChildren(...copyLabel()); }, 1500);
      } catch {
        // fallback: select + execCommand
        const range = document.createRange();
        range.selectNodeContents(msgEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand('copy');
        copyBtn.textContent = '✓ コピーしました';
        setTimeout(() => { copyBtn.replaceChildren(...copyLabel()); }, 1500);
      }
    },
  }, copyLabel());

  return el('div', { class: 'spira-content' }, [
    el('div', { class: 'spira-empty', style: 'gap:var(--s-5)' }, [
      el('div', { class: 'spira-empty-title', style: 'color:var(--danger)' }, ['データの取得に失敗しました']),
      msgEl,
      el('div', { style: 'display:flex;gap:var(--s-3)' }, [
        copyBtn,
        el('button', {
          class: 'spira-btn spira-btn--secondary spira-btn--sm',
          onclick: () => setState({}),
        }, ['再試行']),
      ]),
    ]),
  ]);
}

function copyLabel(): (HTMLElement | string)[] {
  return [
    el('span', { html: icon('copy'), style: 'display:inline-flex;width:14px;height:14px' }),
    'エラーをコピー',
  ];
}

function errorToText(e: Error): string {
  // Compose a richer text payload than just e.message for copy/paste debugging.
  // For SpError we already include status/url/body in message; fall back to stack otherwise.
  const lines = [e.message];
  if (e.stack && e.stack !== e.message) lines.push('', '--- stack ---', e.stack);
  lines.push('', `(time: ${new Date().toISOString()})`, `(ua: ${navigator.userAgent})`);
  return lines.join('\n');
}

function paintErrorBanner(slot: HTMLElement): void {
  clear(slot);
  const msg = getState().errorBanner;
  if (!msg) return;
  slot.appendChild(el('div', { class: 'spira-error-banner' }, [
    el('span', { html: icon('alert'), style: 'display:inline-flex;width:16px;height:16px' }),
    msg,
    el('div', { class: 'spira-error-banner-spacer' }),
    el('button', {
      class: 'spira-iconbtn',
      'aria-label': '閉じる',
      onclick: () => setState({ errorBanner: null }),
      html: icon('x'),
    }),
  ]));
}

function renderTopbar(root: HTMLElement): HTMLElement {
  const themeBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': 'テーマ切替',
    title: 'テーマ切替',
    onclick: () => {
      const cur = root.getAttribute('data-theme') ?? 'light';
      const next = cur === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('spira:theme', next); } catch { /* noop */ }
      themeBtn.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    },
    html: icon('moon'),
  });

  const syncBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '同期',
    title: '同期',
    'data-action': 'sync',
    html: icon('sync'),
  });

  const closeBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '閉じる',
    title: '閉じる',
    onclick: () => root.remove(),
    html: icon('x'),
  });

  const settingsBtn = el('button', {
    class: 'spira-iconbtn',
    'aria-label': '設定',
    title: '設定',
    html: icon('gear'),
  });
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsMenu(root, settingsBtn);
  });

  return el('header', { class: 'spira-topbar', role: 'banner' }, [
    el('div', { class: 'spira-topbar-brand' }, ['Spira']),
    el('div', { class: 'spira-topbar-spacer' }),
    el('div', { class: 'spira-topbar-actions' }, [
      syncBtn,
      themeBtn,
      settingsBtn,
      closeBtn,
    ]),
  ]);
}

function openSettingsMenu(root: HTMLElement, anchor: HTMLElement): void {
  const existing = document.querySelector('.spira-settings-menu');
  if (existing) { existing.remove(); return; }

  const membersItem = el('div', {
    class: 'spira-menu-item',
    onclick: () => { menu.remove(); openInternalMembersModal(root); },
  }, [
    el('span', { html: icon('user'), style: 'display:inline-flex;width:14px;height:14px' }),
    '内部メンバー設定',
  ]);

  const idFormatItem = el('div', {
    class: 'spira-menu-item',
    onclick: () => { menu.remove(); openTicketIdFormatModal(root); },
  }, [
    el('span', { html: icon('hash'), style: 'display:inline-flex;width:14px;height:14px' }),
    'チケット ID 形式',
  ]);

  const helpItem = el('div', {
    class: 'spira-menu-item',
    onclick: () => { menu.remove(); openHelpModal(root); },
  }, [
    el('span', { html: icon('help'), style: 'display:inline-flex;width:14px;height:14px' }),
    'ヘルプ (PA フロー作成手順)',
  ]);

  const resetItem = el('div', {
    class: 'spira-menu-item',
    style: 'color:var(--danger)',
    onclick: () => {
      menu.remove();
      onResetLists(root);
    },
  }, [
    el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' }),
    'SP リストをリセット',
  ]);

  const modeLabel = el('div', {
    class: 'spira-menu-item',
    style: 'cursor:default;color:var(--ink-3);font-size:var(--fs-xs);pointer-events:none',
  }, [`モード: ${getRepoMode()}`]);

  // Build identity — clickable to copy to clipboard for bug reports.
  const buildLabel = el('div', {
    class: 'spira-menu-item',
    style: 'cursor:pointer;color:var(--ink-3);font-size:var(--fs-xs);font-family:ui-monospace,Menlo,monospace;white-space:normal;word-break:break-all;line-height:1.4',
    title: 'クリックでコピー',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(__SPIRA_BUILD_ID__);
        buildLabel.textContent = '✓ コピーしました';
        setTimeout(() => { buildLabel.textContent = `build: ${__SPIRA_BUILD_ID__}`; }, 1200);
      } catch { /* ignore */ }
    },
  }, [`build: ${__SPIRA_BUILD_ID__}`]);

  const menu = el('div', {
    class: 'spira-menu spira-settings-menu',
    style: 'position:fixed;z-index:var(--z-modal);min-width:280px',
  }, [
    modeLabel,
    buildLabel,
    el('div', { class: 'spira-menu-divider' }),
    membersItem,
    idFormatItem,
    helpItem,
    el('div', { class: 'spira-menu-divider' }),
    resetItem,
  ]);

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  root.appendChild(menu);

  // close on outside click / Esc
  setTimeout(() => {
    const closer = (ev: Event) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closer);
        document.removeEventListener('keydown', keyCloser);
      }
    };
    const keyCloser = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('click', closer);
        document.removeEventListener('keydown', keyCloser);
      }
    };
    document.addEventListener('click', closer);
    document.addEventListener('keydown', keyCloser);
  }, 0);
}

function openInternalMembersModal(root: HTMLElement): void {
  const adUsers = getState().users; // already loaded on bootstrap
  let members = getInternalMembers();

  const listWrap = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);min-height:60px;margin-bottom:var(--s-5)' });

  function renderList(): void {
    clear(listWrap);
    if (members.length === 0) {
      listWrap.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-5);font-size:var(--fs-sm)' }, ['まだ登録されていません']));
      return;
    }
    for (const email of members) {
      const adUser = adUsers.find(u => u.email.toLowerCase() === email);
      const row = el('div', {
        style: 'display:flex;align-items:center;gap:var(--s-3);padding:var(--s-2) var(--s-3);background:var(--paper-2);border-radius:var(--r-2)',
      }, [
        el('span', { style: 'flex:1' }, [adUser ? `${adUser.displayName} <${email}>` : email]),
        el('button', {
          class: 'spira-btn spira-btn--ghost spira-btn--sm',
          onclick: () => {
            members = members.filter(e => e !== email);
            renderList();
          },
        }, ['削除']),
      ]);
      listWrap.appendChild(row);
    }
  }
  renderList();

  // Add control: select from AD users + free-text fallback
  const select = el('select', { class: 'spira-select', style: 'flex:1' }, [
    el('option', { value: '' }, ['AD ユーザーから選択...']),
    ...adUsers
      .filter(u => !members.includes(u.email.toLowerCase()))
      .map(u => el('option', { value: u.email }, [`${u.displayName} <${u.email}>`])),
  ]) as HTMLSelectElement;

  const freeInput = el('input', {
    type: 'email', class: 'spira-input', style: 'flex:1',
    placeholder: 'または直接メールアドレスを入力',
  }) as HTMLInputElement;

  const addBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: () => {
      const v = (select.value || freeInput.value).trim().toLowerCase();
      if (!v) return;
      if (members.includes(v)) return;
      members = [...members, v];
      select.value = '';
      freeInput.value = '';
      renderList();
    },
  }, ['＋ 追加']);

  const body = el('div', {}, [
    el('div', { class: 'spira-field' }, [
      el('label', { class: 'spira-field-label' }, ['登録済みの内部メンバー']),
      listWrap,
    ]),
    el('div', { class: 'spira-field' }, [
      el('label', { class: 'spira-field-label' }, ['追加']),
      el('div', { style: 'display:flex;gap:var(--s-3);align-items:center' }, [select, addBtn]),
      el('div', { style: 'display:flex;gap:var(--s-3);align-items:center;margin-top:var(--s-2)' }, [freeInput]),
    ]),
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-3)' }, [
      '※ ここに登録したメールアドレスから来たメールは「社内」扱いになり、チケット詳細画面で右側に表示されます。',
    ]),
  ]);

  openModal(root, {
    title: '内部メンバー設定',
    body,
    primaryLabel: '保存',
    onPrimary: () => {
      setInternalMembers(members);
      toast(root, `内部メンバー ${members.length} 件を保存しました`, 'ok');
      setState({}); // re-render to apply colors
    },
  });
}

function openTicketIdFormatModal(root: HTMLElement): void {
  // Format is fixed as `[<prefix>#NNNNN]`. Only the prefix is editable
  // (e.g. "CASE", "SUP", or empty). Everything else — brackets, hash,
  // 5-digit padding — is locked.
  let prefix = getTicketIdPrefix();

  const previewSubject = el('div', {
    style: 'font-family:ui-monospace,Menlo,monospace;font-size:var(--fs-md);padding:var(--s-3) var(--s-4);background:var(--paper-2);border:1px solid var(--line);border-radius:var(--r-2)',
  });
  const previewExample = el('div', {
    style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2)',
  });

  const refreshPreview = (): void => {
    const tag = formatTicketTagWith(1, prefix);
    previewSubject.textContent = tag;
    previewExample.textContent = `件名サンプル → "RE: ${tag} お問い合わせの件"`;
  };

  const input = el('input', {
    type: 'text',
    value: prefix,
    placeholder: '例: CASE / SUP / 空欄も可',
    maxlength: '12',
    style: 'width:100%;padding:var(--s-3) var(--s-4);border:1px solid var(--line);border-radius:var(--r-2);font-size:var(--fs-md);font-family:ui-monospace,Menlo,monospace;background:var(--paper);color:var(--ink)',
    oninput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      const safe = sanitizePrefix(raw);
      // Reflect sanitized value back so the user sees what gets stored.
      if (raw !== safe) (e.target as HTMLInputElement).value = safe;
      prefix = safe;
      refreshPreview();
    },
  }) as HTMLInputElement;

  refreshPreview();

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-4)' }, [
    el('div', { style: 'font-size:var(--fs-sm);color:var(--ink);line-height:1.6' }, [
      '送信メール件名に挿入する形式は ',
      el('code', { style: 'background:var(--paper-2);padding:1px 4px;border-radius:3px' }, ['[<prefix>#NNNNN]']),
      ' 固定です。',
      el('br'),
      'プレフィックス部分のみ自由に変更できます (英数字・ハイフン・アンダースコアのみ、最大 12 文字)。',
    ]),
    el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2)' }, [
      el('label', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, ['プレフィックス']),
      input,
    ]),
    el('div', { style: 'display:flex;flex-direction:column;gap:0' }, [
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:var(--s-2)' }, ['プレビュー']),
      previewSubject,
      previewExample,
    ]),
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' }, [
      '※ ID は 5 桁ゼロ埋め固定。既存メールの件名は再生成されません。',
      el('br'),
      '※ 受信時のパースは過去のフォーマット (',
      el('code', { style: 'background:var(--paper-2);padding:0 3px;border-radius:2px' }, ['[CASE-NNN]']),
      ', ',
      el('code', { style: 'background:var(--paper-2);padding:0 3px;border-radius:2px' }, ['(#NNN)']),
      ' 等) も引き続き受け付けます。',
    ]),
  ]);

  openModal(root, {
    title: 'チケット ID 形式',
    body,
    primaryLabel: '保存',
    onPrimary: () => {
      setTicketIdPrefix(prefix);
      const tag = formatTicketTagWith(1, prefix);
      toast(root, `ID 形式を ${tag} に変更しました`, 'ok');
      setState({});
    },
  });
}

function openHelpModal(root: HTMLElement): void {
  // The PA flow ingests email into the SP `InboxMails` list. From there
  // Spira's syncInbox auto-links replies (subject contains a ticket tag)
  // and surfaces unprocessed mails for manual triage.
  //
  // Steps below match the column schema declared in api/sp.ts
  // (`inboxFieldSpecs`) — keep in sync if the schema changes.

  const h = (text: string): HTMLElement =>
    el('h3', { style: 'margin:var(--s-5) 0 var(--s-2);font-size:var(--fs-md);font-weight:600;color:var(--ink)' }, [text]);

  const p = (text: string): HTMLElement =>
    el('p', { style: 'margin:0 0 var(--s-3);line-height:1.7;font-size:var(--fs-sm);color:var(--ink)' }, [text]);

  const ol = (items: (string | HTMLElement)[]): HTMLElement =>
    el('ol', {
      style: 'margin:var(--s-2) 0;padding-left:1.4em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)',
    }, items.map((it) => el('li', { style: 'margin-bottom:var(--s-2)' }, [it])));

  const code = (text: string): HTMLElement =>
    el('code', {
      style: 'background:var(--paper-2);padding:1px 5px;border-radius:3px;font-family:ui-monospace,Menlo,monospace;font-size:0.92em;color:#c7254e',
    }, [text]);

  const codeBlock = (text: string): HTMLElement =>
    el('pre', {
      style: 'background:var(--paper-2);padding:var(--s-3) var(--s-4);border:1px solid var(--line);border-radius:var(--r-2);font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre;color:var(--ink);margin:var(--s-2) 0',
    }, [text]);

  const row = (k: string, v: string, hint?: string): HTMLElement =>
    el('tr', {}, [
      el('td', { style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)' }, [k]),
      el('td', { style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top' }, [
        el('div', { style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)' }, [v]),
        ...(hint ? [el('div', { style: 'font-size:11px;color:var(--ink-3);margin-top:2px' }, [hint])] : []),
      ]),
    ]);

  // ── Content sections ───────────────────────────────────────────────

  const intro = el('div', {}, [
    p('Spira は SharePoint 上の 3 つのリスト (Tickets / Comments / InboxMails) のみで動作します。受信メールをアプリに取り込むには Power Automate (PA) フローを 1 本作成し、メールが届いたら InboxMails リストに行を追加するように設定してください。'),
    p('PA で取り込まれたメールは画面左側の「受信メール」に表示され、件名に含まれるチケット ID タグから自動で既存チケットへ紐付けられます (タグが無いものは「新規起票」または「既存に紐付け」のボタンで手動処理)。'),
  ]);

  const prereq = el('div', {}, [
    h('1. 必要なもの'),
    ol([
      el('div', {}, ['SharePoint サイト (Spira を入れたサイトと同じテナント)']),
      el('div', {}, [
        '取り込み対象のメールが届くメールボックス: 共有メールボックス、グループ メール、または個人メール',
      ]),
      el('div', {}, ['Power Automate のフロー作成権限']),
      el('div', {}, [
        '初回起動済みの Spira (SP リストが ',
        code('ensureLists'),
        ' で作成済み)',
      ]),
    ]),
  ]);

  const trigger = el('div', {}, [
    h('2. トリガーの設定'),
    p('Microsoft 365 Outlook コネクタの「新しいメールが届いたとき (V3)」または「共有メールボックスに新しいメールが届いたとき (V2)」を使います。'),
    ol([
      el('div', {}, ['Power Automate を開き「+ 作成」 → 「自動化したクラウド フロー」']),
      el('div', {}, [
        'フロー名 (例: ',
        code('Spira – Inbox Ingest'),
        ') を入力し、トリガーで ',
        code('When a new email arrives (V3)'),
        ' を選択',
      ]),
      el('div', {}, [
        'パラメータ:',
        el('ul', { style: 'margin:6px 0;padding-left:1.2em;line-height:1.7' }, [
          el('li', {}, ['Folder: ', code('Inbox'), ' (もしくは取り込み対象のフォルダ)']),
          el('li', {}, ['Importance: ', code('Any')]),
          el('li', {}, ['Include Attachments: ', code('No'), ' (添付の中身までは保存しない)']),
          el('li', {}, ['Only with Attachments: ', code('No')]),
          el('li', {}, ['Subject Filter: 空欄 (全件取り込みたい場合) / ', code('[#'), ' などでフィルタしてもよい']),
        ]),
      ]),
    ]),
  ]);

  // Column mapping table — matches inboxFieldSpecs() in api/sp.ts
  const mappingTable = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:var(--s-2)',
  }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['列名 (SP)']),
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['動的コンテンツ / 値']),
      ]),
    ]),
    el('tbody', {}, [
      row('Title', 'Subject から (式: trigger().subject)', '実質ダミー。SP の必須列なので埋めるだけ。'),
      row('Subject', 'Subject', 'メール件名そのまま。'),
      row('BodyHtml', 'Body', 'HTML 形式の本文。Spira がサニタイズして表示。'),
      row('BodyText', 'Body Preview', 'プレーン テキスト本文 (短縮版で OK)。'),
      row('FromEmail', 'From', '差出人アドレス。内部/外部判定にも使われます。'),
      row('FromName', 'From - Name', '差出人表示名。'),
      row('HasAttachments', 'Has Attachment', 'true/false。'),
      row('ConversationId', 'Conversation Id', 'スレッド ID。受信パネルで会話単位の紐付けに使用。'),
      row('ReceivedAt', 'Received Time', 'このメールボックスにメールが到着した時刻。表示・ソート用。'),
      row('SentAt', "(式) triggerOutputs()?['body/sentDateTime']", '送信者が「送信」した時刻。Spira の重複起票判定 (送信者 + 送信時刻一致) の主キー。動的コンテンツ パネルに「Sent Time」が出ないテナントが多いので、「式」タブから取得すること (詳細は表下のサンプル参照)。'),
      row('OwaLink', "(式) concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))", 'メッセージ ID から OWA URL を構築。動的コンテンツ「Web Link」は V3 トリガでは出ないので必ず「式」タブで入力。'),
      row('IsProcessed', 'false (固定)', 'Spira 側で取り込み完了時に true に更新。'),
      row('IsHidden', 'false (固定)', '非表示フラグ。'),
      row('InternetMessageId', 'Internet Message Id', 'メールの一意 ID。重複防止に使用。'),
    ]),
  ]);

  const action = el('div', {}, [
    h('3. アクション: SharePoint に項目を作成'),
    p('トリガーの後に SharePoint コネクタの「項目の作成」を追加します。'),
    ol([
      el('div', {}, [
        'Site Address: Spira を導入した SP サイト URL (例: ',
        code('https://<tenant>.sharepoint.com/sites/<site>'),
        ')',
      ]),
      el('div', {}, [
        'List Name: ',
        code('InboxMails'),
        ' を選択',
      ]),
      el('div', {}, [
        '以下の列に動的コンテンツをマッピング (',
        el('strong', {}, ['列名は大文字小文字含めて完全一致']),
        '):',
      ]),
    ]),
    mappingTable,
    p('式の入力例 (IsProcessed / IsHidden 用):'),
    codeBlock('false'),
    p('SentAt 用の式 (動的コンテンツに「Sent Time」が出ない場合は「式」タブから入力):'),
    codeBlock("triggerOutputs()?['body/sentDateTime']"),
    p('上の式が空を返す場合、トリガーのバージョン違いで body の field 名が異なる可能性があります。次のどれかを順に試してください:'),
    codeBlock(
      "triggerOutputs()?['body/sentDateTime']\n" +
      "triggerOutputs()?['body/DateTimeSent']\n" +
      "triggerOutputs()?['body/dateTimeSent']"
    ),
    p('それでも null の場合は、SentDateTime を持たないトリガー (古い V2 等) を使っている可能性があります。トリガー直後に「メールの取得 (V2) — Get email (V2)」アクションを追加し、Message Id を渡して取得した body から `sentDateTime` を使うのが確実です。アクションの出力を使う場合は式を:'),
    codeBlock("body('メールの取得_V2')?['sentDateTime']"),
    p('OwaLink 用の式 (動的コンテンツ パネルではなく「式」タブに貼り付け):'),
    codeBlock(
      "concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))"
    ),
    p('共有メールボックス トリガー (V2) の場合や、ユーザ別 OWA を開きたい場合は以下のいずれかに置き換え可:'),
    codeBlock(
      "concat('https://outlook.office365.com/owa/?ItemID=', encodeUriComponent(triggerOutputs()?['body/Id']), '&exvsurl=1&viewmodel=ReadMessageItem')"
    ),
  ]);

  const verify = el('div', {}, [
    h('4. 動作確認'),
    ol([
      el('div', {}, ['フローを「保存」 → 「テスト」 → 手動でテスト メールを送信']),
      el('div', {}, [
        'SP リスト ',
        code('InboxMails'),
        ' に行が増えていれば成功',
      ]),
      el('div', {}, [
        'Spira 画面左の「受信メール」に表示されるか確認 (右上の同期ボタンで強制リロード可能)',
      ]),
      el('div', {}, [
        '件名に既存チケットの ID タグ (例: ',
        code('[#00001]'),
        ') を含めて返信メールを送ると、自動でそのチケットの履歴に追加されます',
      ]),
    ]),
  ]);

  const trouble = el('div', {}, [
    h('5. トラブルシューティング'),
    el('ul', { style: 'margin:0;padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [
        el('strong', {}, ['列マッピング エラー']),
        ': SP の列名と PA で指定する列名が一致しているか確認。Spira リスト リセット後に列が増えていれば再設定が必要。',
      ]),
      el('li', {}, [
        el('strong', {}, ['400 InvalidColumnName']),
        ': SP リストが古いスキーマのまま。Spira を一度起動すると ',
        code('ensureLists'),
        ' が走って不足列を追加します。',
      ]),
      el('li', {}, [
        el('strong', {}, ['同じメールが何度も取り込まれる']),
        ': InternetMessageId 列が空欄になっていないか確認。',
      ]),
      el('li', {}, [
        el('strong', {}, ['重複起票がブロックされない / 別人のメールと衝突する']),
        ': SentAt 列が空になっていないか確認。Spira の重複判定 (送信者 + 送信時刻一致) は ',
        code('SentAt'),
        ' を主キーとし、空の場合のみ ',
        code('ReceivedAt'),
        ' にフォールバック。Received Time は宛先メールボックスごとに微妙にズレるため、SentAt が無いと別人の同タイミング メールで誤検知することがあります。',
      ]),
      el('li', {}, [
        el('strong', {}, ['動的コンテンツに「Sent Time」が表示されない']),
        ': V3 トリガでは Sent Time が「動的コンテンツ」パネルに出ないことがほとんど。SentAt 列には ',
        code("triggerOutputs()?['body/sentDateTime']"),
        ' を ',
        el('em', {}, ['式']),
        ' タブから入力してください。式の結果が null の場合は ',
        code('DateTimeSent'),
        ' / ',
        code('dateTimeSent'),
        ' を順に試すか、トリガ直後に「メールの取得 (V2)」アクションを追加して取得した body の ',
        code('sentDateTime'),
        ' を使ってください。',
      ]),
      el('li', {}, [
        el('strong', {}, ['OwaLink が空 / 開けない']),
        ': V3 トリガでは「Web Link」動的コンテンツが出ません。OwaLink 列には ',
        code("concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))"),
        ' を ',
        el('em', {}, ['式']),
        ' タブから入力してください (上記マッピング表の式と同じ)。',
      ]),
      el('li', {}, [
        el('strong', {}, ['返信が紐付かない']),
        ': 件名にタグがあるか、現在の ID 形式 (設定 → ',
        el('em', {}, ['チケット ID 形式']),
        ') と整合しているか確認。レガシー形式 ',
        code('[CASE-NNN]'),
        ' / ',
        code('(#NNN)'),
        ' / ',
        code('<#NNN>'),
        ' も読み込み可能。',
      ]),
      el('li', {}, [
        el('strong', {}, ['SP リストをリセットしたら PA フローが動かなくなった']),
        ': リセットは「中身を空にする」のみで List GUID は変わらないため通常は影響なし。それでも壊れる場合は PA の SharePoint アクションで List を再選択してください。',
      ]),
    ]),
  ]);

  const body = el('div', {
    style: 'max-width:720px;line-height:1.7',
  }, [
    intro,
    prereq,
    trigger,
    action,
    verify,
    trouble,
  ]);

  openModal(root, {
    title: 'ヘルプ — Power Automate フロー作成手順',
    body,
    size: 'lg',
    primaryLabel: '閉じる',
    hideCancel: true,
  });
}

function onResetLists(root: HTMLElement): void {
  const isMock = getRepoMode() === 'mock';
  const message = isMock
    ? 'mock データを初期化します。チケット / コメント / 受信メールがすべて消えてサンプルに戻ります。'
    : 'SP の Tickets / Comments / InboxMails の **アイテム（中身）をすべて削除** します。' +
      '\nリスト本体は残るので Power Automate の参照は壊れません。' +
      '\nチケット・コメント・受信メールのデータは戻せません。本当に実行しますか？';

  confirmModal(root, {
    title: 'SP リストをリセット',
    message,
    primaryLabel: 'リセット実行',
    primaryVariant: 'danger',
    onConfirm: async () => {
      try {
        const r = await getRepo().resetLists();
        const msg = isMock
          ? 'mock データをリセットしました'
          : `中身を削除しました: ${r.deleted.join(' / ')}`;
        toast(root, msg, 'ok', 6000);
        // 再読み込みで完全なクリーン状態へ
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        toast(root, `リセット失敗: ${(e as Error).message}`, 'error');
      }
    },
  });
}

function renderSidebar(): HTMLElement {
  const s = getState();

  const item = (label: string, view: 'tickets' | 'inbox' | 'trash', iconName: string, count?: number) => {
    const isActive = s.view === view;
    const node = el('div', {
      class: `spira-side-item${isActive ? ' active' : ''}`,
      role: 'button',
      tabindex: '0',
      onclick: () => setState({ view, selectedTicketId: null }),
    }, [
      el('span', { class: 'spira-side-icon', html: icon(iconName), style: 'display:inline-flex;width:18px;height:18px;color:var(--ink-3)' }),
      label,
    ]);
    if (count != null && count > 0) {
      node.appendChild(el('span', { class: 'spira-side-count' }, [String(count)]));
    }
    return node;
  };

  return el('aside', { class: 'spira-side', 'aria-label': 'サイドバー' }, [
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['Tickets']),
      item('チケット一覧', 'tickets', 'list'),
      item('受信メール', 'inbox', 'inbox', s.inboxCount),
    ]),
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['その他']),
      item('ゴミ箱', 'trash', 'trash', s.trashCount),
    ]),
    el('div', { class: 'spira-side-bottom' }, [
      el('button', {
        class: 'spira-btn spira-btn--primary',
        style: 'width:100%',
        'data-action': 'new-ticket',
      }, [
        el('span', { html: icon('plus'), style: 'display:inline-flex;width:14px;height:14px' }),
        '新規チケット',
      ]),
    ]),
  ]);
}
