import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, subscribe } from '../state';
import { renderTicketList } from './ticketList';
import { renderTicketDetail } from './ticketDetail';
import { renderInbox } from './inbox';
import { renderTrash } from './trash';
import { openSearchModal } from './search';
import { confirmModal, openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo, getRepoMode } from '../api/repo';
import { getInternalMembers, setInternalMembers, getInternalDisplayNames, setInternalDisplayNames } from '../utils/members';
import {
  getTicketIdPrefix, setTicketIdPrefix, formatTicketTagWith, sanitizePrefix,
} from '../utils/ticketTag';
import {
  parseTeamsChannelUrl,
  getInternalChannelConfig, setInternalChannelConfig,
  getExternalChannelConfig, setExternalChannelConfig,
  type TeamsChannelConfig,
} from '../utils/teamsChannels';
import {
  currentBuildId, loadVersionInfo, saveUpdateUrl,
} from '../utils/versionCheck';
import {
  getDepartmentOptions, setDepartmentOptions,
  getInquiryCategoryOptions, setInquiryCategoryOptions,
  getStatusOptions, setStatusOptions,
  getPriorityOptions, setPriorityOptions,
} from '../utils/optionLists';
import {
  getTagDictionary, setTagDictionary,
  TAG_COLORS, TAG_COLOR_STYLE,
  type TagDef, type TagColor,
} from '../utils/tagDictionary';

export function renderShell(): HTMLElement {
  // id + class — ID セレクタで host CSS の !important / ID rules を上書きできる
  const root = el('div', { id: 'spira-root', class: 'spira-root', 'data-theme': 'light' });
  const main = el('main', { class: 'spira-main' });
  const sideWrap = el('div', { style: 'display:contents' });
  sideWrap.appendChild(renderSidebar());
  const topbarSlot = el('div', { style: 'display:contents' });
  topbarSlot.appendChild(renderTopbar(root));
  const errorSlot = el('div');

  const shell = el('div', { class: 'spira-shell' }, [
    topbarSlot,
    errorSlot,
    el('div', { class: 'spira-body' }, [sideWrap, main]),
  ]);
  root.appendChild(shell);

  // initial paint + on state change. topbar も state 変化で再描画する
  // (ログインユーザー取得は bootstrap で非同期に完了するため)。
  paintMain(main);
  subscribe(() => {
    paintMain(main);
    clear(sideWrap);
    sideWrap.appendChild(renderSidebar());
    clear(topbarSlot);
    topbarSlot.appendChild(renderTopbar(root));
    paintErrorBanner(errorSlot);
  });

  // 内部メンバー一覧の変更を捕捉して受信カードのバッジを再描画。
  //   - 同一タブ: members.ts の writeList が発火する custom event
  //   - 別タブ:   localStorage を直接書き換えた場合の StorageEvent
  // どちらも setState({}) を呼んで paintMain で全描画 → isInternalAuthor が
  // 最新のリストで再評価され、各カードの「内部 / 外部」バッジが更新される。
  const onMembersChanged = (): void => { setState({}); };
  window.addEventListener('spira:internal-members-changed', onMembersChanged);
  window.addEventListener('storage', (e) => {
    if (e.key === 'spira:internal-members' || e.key === 'spira:internal-names') {
      onMembersChanged();
    }
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
    } else if (s.view === 'dashboard') {
      const { renderDashboard } = await import('./dashboard');
      view = await renderDashboard();
    } else if (s.view === 'help') {
      const { renderHelp } = await import('./help');
      view = renderHelp();
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
  const s = getState();
  if (s.errorBanner) {
    slot.appendChild(el('div', { class: 'spira-error-banner' }, [
      el('span', { html: icon('alert'), style: 'display:inline-flex;width:16px;height:16px' }),
      s.errorBanner,
      el('div', { class: 'spira-error-banner-spacer' }),
      el('button', {
        class: 'spira-iconbtn',
        'aria-label': '閉じる',
        onclick: () => setState({ errorBanner: null }),
        html: icon('x'),
      }),
    ]));
  }
  if (s.updateBanner) {
    const ub = s.updateBanner;
    slot.appendChild(el('div', { class: 'spira-update-banner' }, [
      el('span', { html: icon('alert'), style: 'display:inline-flex;width:16px;height:16px' }),
      el('span', { style: 'flex:1' }, [ub.message]),
      ...(ub.url ? [el('a', {
        href: ub.url, target: '_blank', rel: 'noopener',
        class: 'spira-btn spira-btn--primary spira-btn--sm',
        style: 'text-decoration:none',
      }, ['更新ページを開く →'])] : []),
      el('button', {
        class: 'spira-iconbtn',
        'aria-label': '閉じる',
        title: '今は表示しない',
        onclick: () => setState({ updateBanner: null }),
        html: icon('x'),
      }),
    ]));
  }
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

  // ログインユーザー表示。state.currentUser が bootstrap で取得される
  // (SP は /_api/web/currentuser、mock はテストユーザー)。SP の
  // _spPageContextInfo にもフォールバック。
  const currentUser = getState().currentUser;
  const ctx = (window as unknown as {
    _spPageContextInfo?: { userDisplayName?: string; userEmail?: string; userLoginName?: string };
  })._spPageContextInfo;
  const displayName = currentUser?.displayName ?? ctx?.userDisplayName ?? '';
  const email = currentUser?.email ?? ctx?.userEmail ?? ctx?.userLoginName ?? '';
  const userInitials = (() => {
    const src = displayName || email || '?';
    return src.slice(0, 1).toUpperCase();
  })();
  const userChip = el('div', {
    class: 'spira-topbar-user',
    title: displayName && email ? `${displayName} <${email}>` : (displayName || email || 'ログイン情報なし'),
    style:
      'display:inline-flex;align-items:center;gap:6px;padding:2px 8px 2px 4px;' +
      'border-radius:999px;background:var(--paper-2);color:var(--ink);' +
      'font-size:var(--fs-sm);max-width:200px',
  }, [
    el('span', {
      class: 'spira-topbar-user-avatar',
      style:
        'display:inline-flex;align-items:center;justify-content:center;' +
        'width:22px;height:22px;border-radius:50%;background:var(--accent);' +
        'color:#fff;font-weight:600;font-size:12px;flex-shrink:0',
    }, [userInitials]),
    el('span', {
      class: 'spira-topbar-user-name',
      style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    }, [displayName || email || 'ログイン情報なし']),
  ]);

  // ワークスペース表記 (現在接続中の SP サイトの Title)。クリックで SP サイトを
  // 新規タブで開く。bootstrap で siteTitle が取れていない場合は非表示。
  const s = getState();
  const workspaceChip = s.siteTitle
    ? el('a', {
        class: 'spira-topbar-workspace',
        href: s.siteUrl ?? '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `ワークスペース: ${s.siteTitle}${s.siteUrl ? '\n' + s.siteUrl : ''}\nクリックで SP サイトを開く`,
        style:
          'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;' +
          'margin-left:var(--s-3);background:var(--paper-2);border:1px solid var(--line);' +
          'border-radius:var(--r-2);color:var(--ink-2);font-size:var(--fs-xs);' +
          'text-decoration:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      }, [
        el('span', { style: 'font-size:11px;color:var(--ink-3)' }, ['📁']),
        el('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, [s.siteTitle]),
      ])
    : null;

  return el('header', { class: 'spira-topbar', role: 'banner' }, [
    el('div', { class: 'spira-topbar-brand' }, ['Spira']),
    ...(workspaceChip ? [workspaceChip] : []),
    el('div', { class: 'spira-topbar-spacer' }),
    el('div', { class: 'spira-topbar-actions' }, [
      userChip,
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

  // 設定ハブを開くだけのシンプルなメニュー (旧 10+ 項目を 1 つに集約)
  const settingsHubItem = el('div', {
    class: 'spira-menu-item',
    onclick: () => {
      menu.remove();
      void import('./settingsModal').then(({ openSettingsHubModal }) => openSettingsHubModal(root));
    },
  }, [
    el('span', { html: icon('gear'), style: 'display:inline-flex;width:14px;height:14px' }),
    '設定',
  ]);

  const aboutItem = el('div', {
    class: 'spira-menu-item',
    onclick: () => {
      menu.remove();
      void import('./aboutModal').then(({ openAboutModal }) => openAboutModal());
    },
  }, [
    el('span', { html: icon('help'), style: 'display:inline-flex;width:14px;height:14px' }),
    'Spira について (概要・アーキ図・PA フロー手順)',
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
    style: 'position:fixed;z-index:var(--z-modal);min-width:240px',
  }, [
    modeLabel,
    buildLabel,
    el('div', { class: 'spira-menu-divider' }),
    settingsHubItem,
    aboutItem,
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

export function buildInternalMembersPanel(root: HTMLElement): { body: HTMLElement; save: () => Promise<void> } {
  const adUsers = getState().users; // already loaded on bootstrap
  let members = getInternalMembers();
  let names = getInternalDisplayNames();

  // ============== email-based (AD) list
  const emailListWrap = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);min-height:60px;margin-bottom:var(--s-5)' });

  function renderEmailList(): void {
    clear(emailListWrap);
    if (members.length === 0) {
      emailListWrap.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-5);font-size:var(--fs-sm)' }, ['まだ登録されていません']));
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
            renderEmailList();
          },
        }, ['削除']),
      ]);
      emailListWrap.appendChild(row);
    }
  }
  renderEmailList();

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

  const addEmailBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: () => {
      const v = (select.value || freeInput.value).trim().toLowerCase();
      if (!v) return;
      if (members.includes(v)) return;
      members = [...members, v];
      select.value = '';
      freeInput.value = '';
      renderEmailList();
    },
  }, ['＋ 追加']);

  // ============== display-name list (for Teams / other non-AD sources)
  const nameListWrap = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);min-height:60px;margin-bottom:var(--s-5)' });

  function renderNameList(): void {
    clear(nameListWrap);
    if (names.length === 0) {
      nameListWrap.appendChild(el('div', { class: 'spira-empty', style: 'padding:var(--s-5);font-size:var(--fs-sm)' }, ['まだ登録されていません']));
      return;
    }
    for (const name of names) {
      const row = el('div', {
        style: 'display:flex;align-items:center;gap:var(--s-3);padding:var(--s-2) var(--s-3);background:var(--paper-2);border-radius:var(--r-2)',
      }, [
        el('span', { style: 'flex:1' }, [name]),
        el('button', {
          class: 'spira-btn spira-btn--ghost spira-btn--sm',
          onclick: () => {
            names = names.filter(n => n !== name);
            renderNameList();
          },
        }, ['削除']),
      ]);
      nameListWrap.appendChild(row);
    }
  }
  renderNameList();

  const nameInput = el('input', {
    type: 'text', class: 'spira-input', style: 'flex:1',
    placeholder: 'Teams 等の表示名を入力 (例: 山田 太郎)',
  }) as HTMLInputElement;

  const addNameBtn = el('button', {
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: () => {
      const v = nameInput.value.trim().toLowerCase();
      if (!v) return;
      if (names.includes(v)) return;
      names = [...names, v];
      nameInput.value = '';
      renderNameList();
    },
  }, ['＋ 追加']);

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addNameBtn.click(); }
  });

  const body = el('div', {}, [
    el('div', { class: 'spira-field' }, [
      el('label', { class: 'spira-field-label' }, ['内部メンバー (メールアドレス)']),
      emailListWrap,
      el('div', { style: 'display:flex;gap:var(--s-3);align-items:center' }, [select, addEmailBtn]),
      el('div', { style: 'display:flex;gap:var(--s-3);align-items:center;margin-top:var(--s-2)' }, [freeInput]),
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2)' }, [
        '※ 受信メールの差出人がここに登録されている場合「社内」扱いになります。',
      ]),
    ]),
    el('div', { class: 'spira-field', style: 'margin-top:var(--s-6);padding-top:var(--s-5);border-top:1px solid var(--line)' }, [
      el('label', { class: 'spira-field-label' }, ['内部メンバー (Teams / その他の表示名)']),
      nameListWrap,
      el('div', { style: 'display:flex;gap:var(--s-3);align-items:center' }, [nameInput, addNameBtn]),
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2)' }, [
        '※ Teams ペーストや「対応履歴を追加」で取り込んだ発言は AD と紐付かないので、表示名で判定します。大文字小文字は無視。',
      ]),
    ]),
  ]);

  const save = async (): Promise<void> => {
    setInternalMembers(members);
    setInternalDisplayNames(names);
    toast(root, `内部メンバー ${members.length} 件 / 表示名 ${names.length} 件を保存しました`, 'ok');
    setState({});
  };

  return { body, save };
}

export function openInternalMembersModal(root: HTMLElement): void {
  const { body, save } = buildInternalMembersPanel(root);
  openModal(root, {
    title: '内部メンバー設定',
    body,
    primaryLabel: '保存',
    onPrimary: save,
  });
}

/** 設定ハブ inline 用 body builder。openTicketIdFormatModal が内部利用。 */
export function buildTicketIdFormatPanel(root: HTMLElement): { body: HTMLElement; save: () => Promise<void> } {
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

  const save = async (): Promise<void> => {
    setTicketIdPrefix(prefix);
    const tag = formatTicketTagWith(1, prefix);
    toast(root, `ID 形式を ${tag} に変更しました`, 'ok');
    setState({});
  };

  return { body, save };
}

export function openTicketIdFormatModal(root: HTMLElement): void {
  const { body, save } = buildTicketIdFormatPanel(root);
  openModal(root, {
    title: 'チケット ID 形式',
    body,
    primaryLabel: '保存',
    onPrimary: save,
  });
}

/** Teams チャネル設定モーダル。
 *  内部用 / 外部用の Teams チャネル URL を入力させ、URL から Channel ID /
 *  Team ID をパース。保存先は SP の SpiraSettings リスト (Spira 全体共有)。
 *  レイアウトは「履歴を追加」「チケットプロパティ」と同じ 2 列グリッド。 */
export function buildTeamsChannelsPanel(root: HTMLElement): { body: HTMLElement; save: () => Promise<void> } {
  // 編集中ドラフト (保存ボタンで一括 commit)。SP から読込中は null。
  let internalDraft: TeamsChannelConfig | null = null;
  let externalDraft: TeamsChannelConfig | null = null;

  // 履歴追加・チケットプロパティ と同じスタイル
  const LABEL_STYLE =
    'color:var(--ink-3);font-size:var(--fs-sm);' +
    'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
  const LABEL_TOP_STYLE = LABEL_STYLE + ';align-self:start;padding-top:8px';
  const SECTION_HEAD_STYLE =
    'grid-column:1 / -1;' +
    'font-size:var(--fs-md);font-weight:600;color:var(--ink);' +
    'border-top:1px solid var(--line);padding-top:var(--s-3);margin-top:var(--s-2)';
  const CODE_STYLE =
    'font-family:ui-monospace,Menlo,monospace;font-size:12px;' +
    'background:var(--paper-2);padding:2px 6px;border-radius:3px;' +
    'word-break:break-all;display:inline-block;max-width:100%';

  const grid = el('div', {
    style:
      'display:grid;grid-template-columns:96px minmax(0,1fr);' +
      'gap:var(--s-3) var(--s-4);align-items:center',
  });

  /** 1 スレッド分の rows を grid に流し込む。 */
  const appendChannelRows = (
    sectionLabel: string,
    initial: TeamsChannelConfig | null,
    onChange: (cfg: TeamsChannelConfig | null) => void,
  ): void => {
    // セクションヘッダ
    grid.append(el('div', { style: SECTION_HEAD_STYLE }, [sectionLabel]));

    // 状態 + プレビュー (再描画用ホスト)
    const statusValue = el('div', { style: 'min-width:0' });
    const previewHost = el('div', { style: 'min-width:0' });

    const renderStatusAndPreview = (cfg: TeamsChannelConfig | null): void => {
      statusValue.replaceChildren(
        cfg
          ? el('span', { style: 'color:rgb(34,197,94);font-weight:500' }, ['● 設定済み'])
          : el('span', { style: 'color:var(--ink-3)' }, ['○ 未設定']),
      );
      previewHost.replaceChildren();
      if (!cfg) return;
      const rows: HTMLElement[] = [];
      if (cfg.channelName) {
        rows.push(el('div', { style: 'display:flex;gap:var(--s-2)' }, [
          el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm);width:60px;flex-shrink:0' }, ['Name']),
          el('code', { style: CODE_STYLE }, [cfg.channelName]),
        ]));
      }
      rows.push(
        el('div', { style: 'display:flex;gap:var(--s-2)' }, [
          el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm);width:60px;flex-shrink:0' }, ['Channel']),
          el('code', { style: CODE_STYLE }, [cfg.channelId]),
        ]),
        el('div', { style: 'display:flex;gap:var(--s-2)' }, [
          el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm);width:60px;flex-shrink:0' }, ['Team']),
          el('code', { style: CODE_STYLE }, [cfg.teamId]),
        ]),
      );
      previewHost.append(el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, rows));
    };

    // URL 入力 + 解析エラー表示
    const urlInput = el('input', {
      type: 'url',
      placeholder: 'Teams のチャネル「···」→「チャネルへのリンクを取得」した URL を貼り付け',
      value: initial?.url ?? '',
      style:
        'width:100%;padding:var(--s-2) var(--s-3);' +
        'border:1px solid var(--line);border-radius:var(--r-2);' +
        'font-size:12px;font-family:ui-monospace,Menlo,monospace;' +
        'background:var(--paper);color:var(--ink)',
    }) as HTMLInputElement;

    const errLine = el('div', { style: 'font-size:var(--fs-xs);color:rgb(239,68,68)' });

    const tryParse = (raw: string): void => {
      errLine.replaceChildren();
      if (raw.trim() === '') {
        onChange(null);
        renderStatusAndPreview(null);
        return;
      }
      const parsed = parseTeamsChannelUrl(raw);
      if (parsed) {
        onChange(parsed);
        renderStatusAndPreview(parsed);
      } else {
        errLine.textContent = '⚠ Teams チャネル URL を解析できませんでした';
        onChange(null);
        renderStatusAndPreview(null);
      }
    };

    urlInput.addEventListener('paste', (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      setTimeout(() => { tryParse(text); }, 0);
    });
    urlInput.addEventListener('input', () => { tryParse(urlInput.value); });

    const clearBtn = el('button', {
      type: 'button',
      class: 'spira-btn spira-btn--ghost spira-btn--sm',
      onclick: () => {
        urlInput.value = '';
        tryParse('');
      },
    }, ['クリア']);

    renderStatusAndPreview(initial);

    grid.append(
      el('label', { style: LABEL_STYLE }, ['状態']),
      statusValue,
      el('label', { style: LABEL_TOP_STYLE }, ['URL を貼付']),
      el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);min-width:0' }, [
        el('div', { style: 'display:flex;gap:var(--s-2);align-items:flex-start' }, [
          el('div', { style: 'flex:1;min-width:0' }, [urlInput]),
          clearBtn,
        ]),
        errLine,
      ]),
      el('label', { style: LABEL_TOP_STYLE }, ['抽出結果']),
      previewHost,
    );
  };

  const renderGrid = (): void => {
    grid.replaceChildren();
    appendChannelRows('🏢 内部用チャネル (社内議論)', internalDraft, (cfg) => { internalDraft = cfg; });
    appendChannelRows('👥 外部用チャネル (顧客対応)', externalDraft, (cfg) => { externalDraft = cfg; });
    grid.append(el('div', {
      style:
        'grid-column:1 / -1;' +
        'font-size:var(--fs-xs);color:var(--ink-3);' +
        'background:var(--paper-2);padding:var(--s-3);' +
        'border-radius:var(--r-2);line-height:1.6;margin-top:var(--s-2)',
    }, [
      '※ 設定は SharePoint の SpiraSettings リストに保存され、Spira 全体で共有されます。',
      el('br'),
      '※ Teams で対象チャネルの「···」→「チャネルへのリンクを取得」した URL を貼ると自動パース。',
      el('br'),
      '※ PA フローのチャネル選択も併せて更新してください (Spira 設定は自動反映されません)。',
    ]));
  };

  // 初期描画 (まだロード中なので未設定状態)
  renderGrid();

  // SP から非同期ロード
  Promise.all([getInternalChannelConfig(), getExternalChannelConfig()])
    .then(([i, e]) => {
      internalDraft = i;
      externalDraft = e;
      renderGrid();
    })
    .catch((err: Error) => {
      toast(root, `設定読込失敗: ${err.message}`, 'error');
    });

  const save = async (): Promise<void> => {
    try {
      await Promise.all([
        setInternalChannelConfig(internalDraft),
        setExternalChannelConfig(externalDraft),
      ]);
      const msgs: string[] = [];
      msgs.push(`内部: ${internalDraft ? '✅ 設定済み' : '(未設定)'}`);
      msgs.push(`外部: ${externalDraft ? '✅ 設定済み' : '(未設定)'}`);
      toast(root, `チャネル設定を保存しました — ${msgs.join(' / ')}`, 'ok', 5000);
    } catch (e) {
      toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      throw e;
    }
  };

  return { body: grid, save };
}

export function openTeamsChannelsModal(root: HTMLElement): void {
  const { body, save } = buildTeamsChannelsPanel(root);
  openModal(root, {
    title: 'Teams チャネル設定',
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: save,
  });
}

/** 選択肢編集モーダル (部門 / 問い合わせ種別 共通)。
 *  リスト表示 + 行ごとの削除ボタン + 末尾に追加入力。並び順は保持。
 *  保存先は SpiraSettings (全ユーザー共有)。 */
export type OptionsPanelKind = 'dept' | 'category' | 'status' | 'priority';

export function buildOptionsPanel(root: HTMLElement, kind: OptionsPanelKind): { body: HTMLElement; save: () => Promise<void>; title: string } {
  const meta = {
    dept:     { title: '部門の選択肢',        getter: getDepartmentOptions,       setter: setDepartmentOptions,       placeholder: '例: 営業部 / 開発部 / 管理部' },
    category: { title: '問い合わせ種別の選択肢', getter: getInquiryCategoryOptions, setter: setInquiryCategoryOptions, placeholder: '例: 不具合・エラーの報告' },
    status:   { title: 'ステータスの選択肢',    getter: getStatusOptions,          setter: setStatusOptions,          placeholder: '例: 新規 / 対応中 / 確認待ち / 完了' },
    priority: { title: '影響度の選択肢',        getter: getPriorityOptions,        setter: setPriorityOptions,        placeholder: '例: High / Medium / Low' },
  }[kind];
  const { title, getter, setter, placeholder } = meta;
  // dept/category/status/priority → Ticket フィールド名へのマッピング (バルク更新用)
  const TICKET_FIELD: Record<OptionsPanelKind, 'department' | 'inquiryCategory' | 'status' | 'priority'> = {
    dept: 'department',
    category: 'inquiryCategory',
    status: 'status',
    priority: 'priority',
  };

  // 初期ロード時のスナップショット (改名・削除の差分計算用)。
  let initialSnapshot: string[] = [];
  let draft: string[] = [];
  // 各 draft 行に対応する「元の値」。新規追加行は null。改名されても元の値は
  // ここに保持される。並び替え・削除では draft と一緒に splice / swap される。
  let rowOrigin: (string | null)[] = [];

  const listHost = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);max-height:50vh;overflow-y:auto' });

  const renderList = (): void => {
    listHost.replaceChildren();
    if (draft.length === 0) {
      listHost.appendChild(el('div', {
        style: 'color:var(--ink-3);font-size:var(--fs-sm);padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);text-align:center',
      }, ['(未設定 — 下の入力欄から追加してください)']));
      return;
    }
    draft.forEach((item, i) => {
      // 名称をインラインで編集できる input。blur 時に draft[i] を更新。
      // 重複・空文字は元の値に戻す。Enter で次の input にフォーカス。
      const renameInput = el('input', {
        type: 'text',
        class: 'spira-input',
        value: item,
        style: 'flex:1;min-width:0;background:var(--paper);border:1px solid transparent;' +
               'padding:4px 6px;border-radius:var(--r-2);font-size:var(--fs-sm)',
        title: 'クリックして名称を編集 (フォーカスを外すと反映)',
        onfocus: (e: Event) => {
          (e.target as HTMLInputElement).style.borderColor = 'var(--accent)';
        },
        onblur: (e: Event) => {
          const input = e.target as HTMLInputElement;
          input.style.borderColor = 'transparent';
          const next = input.value.trim();
          if (!next) {
            // 空欄は不可 — 元の値に戻す
            input.value = draft[i] ?? '';
            return;
          }
          if (next === draft[i]) return; // 変更なし
          // 重複チェック (自分自身以外と比較)
          const dupIdx = draft.findIndex((x, idx) => idx !== i && x === next);
          if (dupIdx >= 0) {
            toast(getRoot(), `「${next}」は既に存在します`, 'warn');
            input.value = draft[i] ?? '';
            return;
          }
          draft[i] = next;
          // 名称変更の補足: 既存チケットの値は保存ボタンを押すまで更新されないため
          // 視覚的なフィードバックだけ。
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
            // 次の input にフォーカス移動
            const inputs = listHost.querySelectorAll<HTMLInputElement>('input.spira-input');
            const idx = Array.from(inputs).indexOf(e.target as HTMLInputElement);
            if (idx >= 0 && idx + 1 < inputs.length) inputs[idx + 1]?.focus();
          } else if (e.key === 'Escape') {
            (e.target as HTMLInputElement).value = draft[i] ?? '';
            (e.target as HTMLInputElement).blur();
          }
        },
      }) as HTMLInputElement;

      const row = el('div', {
        style:
          'display:flex;gap:var(--s-2);align-items:center;' +
          'padding:var(--s-2) var(--s-3);background:var(--paper);' +
          'border:1px solid var(--line);border-radius:var(--r-2)',
      }, [
        renameInput,
        el('button', {
          type: 'button',
          class: 'spira-btn spira-btn--ghost spira-btn--sm',
          title: '上へ移動',
          disabled: i === 0,
          onclick: () => {
            if (i === 0) return;
            [draft[i - 1], draft[i]] = [draft[i]!, draft[i - 1]!];
            [rowOrigin[i - 1], rowOrigin[i]] = [rowOrigin[i]!, rowOrigin[i - 1]!];
            renderList();
          },
        }, ['↑']),
        el('button', {
          type: 'button',
          class: 'spira-btn spira-btn--ghost spira-btn--sm',
          title: '下へ移動',
          disabled: i === draft.length - 1,
          onclick: () => {
            if (i === draft.length - 1) return;
            [draft[i + 1], draft[i]] = [draft[i]!, draft[i + 1]!];
            [rowOrigin[i + 1], rowOrigin[i]] = [rowOrigin[i]!, rowOrigin[i + 1]!];
            renderList();
          },
        }, ['↓']),
        el('button', {
          type: 'button',
          class: 'spira-btn spira-btn--ghost spira-btn--sm',
          style: 'color:var(--danger)',
          title: '削除',
          onclick: () => {
            draft.splice(i, 1);
            rowOrigin.splice(i, 1);
            renderList();
          },
        }, ['×']),
      ]);
      listHost.appendChild(row);
    });
  };

  const addInput = el('input', {
    type: 'text', class: 'spira-input', placeholder,
    style: 'flex:1;min-width:0',
  }) as HTMLInputElement;
  const addBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => {
      const v = addInput.value.trim();
      if (!v) return;
      if (draft.includes(v)) {
        toast(root, `「${v}」はすでに登録されています`, 'warn', 3000);
        return;
      }
      draft.push(v);
      rowOrigin.push(null); // 新規追加なので origin は null
      addInput.value = '';
      renderList();
      addInput.focus();
    },
  }, ['追加']);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
  });

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-3)' }, [
    listHost,
    el('div', { style: 'display:flex;gap:var(--s-2);align-items:center' }, [addInput, addBtn]),
    el('div', {
      style: 'font-size:var(--fs-xs);color:var(--ink-3);background:var(--paper-2);' +
             'padding:var(--s-3);border-radius:var(--r-2);line-height:1.6',
    }, [
      '※ 各行の入力欄をクリックすると名称を編集できます (Enter / フォーカスを外すと反映、Esc でキャンセル)。',
      el('br'),
      '※ 設定は SpiraSettings リストに保存され、全ユーザーで共有されます。',
      el('br'),
      '※ ', el('strong', {}, ['保存ボタンを押すと既存チケットも一括更新']),
      ' されます: 名称変更 → 該当チケットを新名に書き換え / 削除 → 該当チケットの値を ',
      el('strong', {}, ['ブランクにリセット']),
      '。件数が多い場合は更新に時間がかかる場合があります。',
      ...(kind === 'category' ? [
        el('br'),
        '※ Forms 起票時、応答のカテゴリ値がここの一覧と一致すれば自動マッピング。一致しない場合は応答の値そのままが入ります。',
      ] : []),
      ...(kind === 'status' || kind === 'priority' ? [
        el('br'),
        '※ SP の Tickets リスト側 Choice 列にも同じ選択肢を手動追加する必要があります (SP リスト設定 → 列 → Status/Priority)。',
      ] : []),
    ]),
  ]);

  void getter().then((list) => {
    initialSnapshot = [...list];
    draft = [...list];
    rowOrigin = list.map(v => v); // 初期ロードは全部 origin=自分自身
    renderList();
  });
  renderList(); // 初期 (ロード中)

  const save = async (): Promise<void> => {
    try {
      // 差分計算: rowOrigin と draft を見比べて renames / deletions を作る。
      const renames = new Map<string, string>();
      const presentOrigins = new Set<string>();
      for (let i = 0; i < draft.length; i++) {
        const o = rowOrigin[i];
        if (!o) continue;                      // 新規追加行 (origin=null) はスキップ
        presentOrigins.add(o);
        if (o !== draft[i]) renames.set(o, draft[i]!);  // 改名
      }
      // 初期にあって今 rowOrigin に存在しない = 削除された値
      const deletions = new Set<string>(
        initialSnapshot.filter(v => !presentOrigins.has(v))
      );

      // 先に SpiraSettings を保存 (新しい選択肢リスト)
      await setter(draft);

      // バルク更新を実施 (該当チケットがあれば)
      if (renames.size > 0 || deletions.size > 0) {
        const repo = getRepo();
        const field = TICKET_FIELD[kind];
        const result = await repo.bulkMigrateTicketField(field, renames, deletions);
        const parts: string[] = [`${title}を保存`];
        if (renames.size > 0) parts.push(`改名 ${renames.size} 件`);
        if (deletions.size > 0) parts.push(`削除 ${deletions.size} 件`);
        if (result.updated > 0) parts.push(`既存チケット ${result.updated} 件を一括更新`);
        if (result.errors.length > 0) {
          toast(root, `${parts.join(' / ')} (エラー ${result.errors.length} 件)`, 'warn', 8000);
          console.warn('[spira/bulkMigrate] errors:', result.errors);
        } else {
          toast(root, parts.join(' / '), 'ok', 6000);
        }
        // 反映後のスナップショットを更新 (再保存に備える)
        initialSnapshot = [...draft];
        rowOrigin = draft.map(v => v);
      } else {
        toast(root, `${title}を保存しました (${draft.length} 件)`, 'ok', 4000);
      }
      setState({});
    } catch (e) {
      toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      throw e;
    }
  };

  return { body, save, title };
}

export function openOptionsModal(root: HTMLElement, kind: OptionsPanelKind): void {
  const { body, save, title } = buildOptionsPanel(root, kind);
  openModal(root, {
    title,
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: save,
  });
}

/** タグ辞書設定パネル。各タグ = name + color + description。
 *  既存チケットの一括更新も対応 (改名は配列内置換、削除は配列から除去)。 */
export function buildTagDictionaryPanel(root: HTMLElement): { body: HTMLElement; save: () => Promise<void> } {
  let initialSnapshot: TagDef[] = [];
  let draft: TagDef[] = [];
  let rowOrigin: (string | null)[] = []; // 改名差分追跡用 (各 draft 行の元の name)

  const listHost = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);max-height:50vh;overflow-y:auto' });

  const colorChip = (c: TagColor, selected: boolean): HTMLElement => {
    const s = TAG_COLOR_STYLE[c];
    return el('span', {
      style:
        `display:inline-block;width:18px;height:18px;border-radius:50%;` +
        `background:${s.border};cursor:pointer;` +
        `box-shadow:${selected ? '0 0 0 2px var(--ink),0 0 0 4px ' + s.border : 'none'};` +
        `transition:box-shadow 0.1s`,
      title: c,
    });
  };

  const renderList = (): void => {
    listHost.replaceChildren();
    if (draft.length === 0) {
      listHost.appendChild(el('div', {
        style: 'color:var(--ink-3);font-size:var(--fs-sm);padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);text-align:center',
      }, ['(タグ未登録 — 下の入力欄から追加してください)']));
      return;
    }
    draft.forEach((tag, i) => {
      // 名前 input
      const nameInput = el('input', {
        type: 'text',
        class: 'spira-input',
        value: tag.name,
        style: 'flex:1 1 140px;min-width:120px;font-size:var(--fs-sm);' +
               'padding:4px 8px;border:1px solid var(--line);border-radius:var(--r-2)',
        onblur: () => {
          const next = nameInput.value.trim();
          if (!next) { nameInput.value = tag.name; return; }
          if (next === tag.name) return;
          const dupIdx = draft.findIndex((t, idx) => idx !== i && t.name === next);
          if (dupIdx >= 0) {
            toast(getRoot(), `「${next}」はすでに存在します`, 'warn');
            nameInput.value = tag.name;
            return;
          }
          tag.name = next;
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') nameInput.blur();
          if (e.key === 'Escape') { nameInput.value = tag.name; nameInput.blur(); }
        },
      }) as HTMLInputElement;

      // 色ピッカー
      const colorWrap = el('div', {
        style: 'display:flex;gap:4px;flex-wrap:wrap;align-items:center',
      }, TAG_COLORS.map(c => {
        const chip = colorChip(c, c === tag.color);
        chip.addEventListener('click', () => {
          tag.color = c;
          renderList();
        });
        return chip;
      }));

      // 説明 input
      const descInput = el('input', {
        type: 'text',
        class: 'spira-input',
        value: tag.description ?? '',
        placeholder: '(任意) 説明',
        style: 'flex:1 1 180px;min-width:140px;font-size:var(--fs-xs);' +
               'padding:4px 8px;border:1px solid var(--line);border-radius:var(--r-2);color:var(--ink-2)',
        onblur: () => { tag.description = descInput.value.trim() || undefined; },
      }) as HTMLInputElement;

      // プレビューピル
      const preview = renderTagPill(tag);

      const row = el('div', {
        style:
          'display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center;' +
          'padding:var(--s-2) var(--s-3);background:var(--paper);' +
          'border:1px solid var(--line);border-radius:var(--r-2)',
      }, [
        preview,
        nameInput,
        colorWrap,
        descInput,
        el('button', {
          type: 'button', class: 'spira-btn spira-btn--ghost spira-btn--sm',
          title: '上へ移動', disabled: i === 0,
          onclick: () => {
            if (i === 0) return;
            [draft[i - 1], draft[i]] = [draft[i]!, draft[i - 1]!];
            [rowOrigin[i - 1], rowOrigin[i]] = [rowOrigin[i]!, rowOrigin[i - 1]!];
            renderList();
          },
        }, ['↑']),
        el('button', {
          type: 'button', class: 'spira-btn spira-btn--ghost spira-btn--sm',
          title: '下へ移動', disabled: i === draft.length - 1,
          onclick: () => {
            if (i === draft.length - 1) return;
            [draft[i + 1], draft[i]] = [draft[i]!, draft[i + 1]!];
            [rowOrigin[i + 1], rowOrigin[i]] = [rowOrigin[i]!, rowOrigin[i + 1]!];
            renderList();
          },
        }, ['↓']),
        el('button', {
          type: 'button', class: 'spira-btn spira-btn--ghost spira-btn--sm',
          style: 'color:var(--danger)', title: '削除',
          onclick: () => {
            draft.splice(i, 1);
            rowOrigin.splice(i, 1);
            renderList();
          },
        }, ['×']),
      ]);
      listHost.appendChild(row);
    });
  };

  // 新規追加
  const addNameInput = el('input', {
    type: 'text', class: 'spira-input',
    placeholder: '新しいタグ名 (例: セキュリティ / 緊急 / 顧客A)',
    style: 'flex:1;min-width:0',
  }) as HTMLInputElement;
  let newColor: TagColor = 'gray';
  const newColorWrap = el('div', { style: 'display:flex;gap:4px' }, []);
  const refreshNewColor = (): void => {
    newColorWrap.replaceChildren(...TAG_COLORS.map(c => {
      const chip = colorChip(c, c === newColor);
      chip.addEventListener('click', () => { newColor = c; refreshNewColor(); });
      return chip;
    }));
  };
  refreshNewColor();
  const addBtn = el('button', {
    type: 'button', class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => {
      const v = addNameInput.value.trim();
      if (!v) return;
      if (draft.find(t => t.name === v)) {
        toast(getRoot(), `「${v}」はすでに存在します`, 'warn');
        return;
      }
      draft.push({ name: v, color: newColor });
      rowOrigin.push(null);
      addNameInput.value = '';
      renderList();
      addNameInput.focus();
    },
  }, ['追加']);
  addNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
  });

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-3)' }, [
    listHost,
    el('div', {
      style: 'display:flex;flex-direction:column;gap:var(--s-2);padding:var(--s-3);' +
             'background:var(--paper-2);border-radius:var(--r-2)',
    }, [
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);font-weight:600' }, ['新規タグの追加']),
      el('div', { style: 'display:flex;gap:var(--s-2);align-items:center' }, [addNameInput, addBtn]),
      el('div', { style: 'display:flex;gap:var(--s-2);align-items:center' }, [
        el('span', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' }, ['色:']),
        newColorWrap,
      ]),
    ]),
    el('div', {
      style: 'font-size:var(--fs-xs);color:var(--ink-3);background:var(--paper-2);' +
             'padding:var(--s-3);border-radius:var(--r-2);line-height:1.6',
    }, [
      '※ タグはチケット本体に紐付きます (コメント / メモには付きません)。',
      el('br'),
      '※ ユーザーは ', el('strong', {}, ['この辞書から選択']),
      ' してチケットに付けます (自由追加は不可、混沌防止のため)。',
      el('br'),
      '※ ', el('strong', {}, ['保存ボタンを押すと既存チケットも一括更新']),
      ' されます: タグ名変更 → 旧名を新名に置換 / タグ削除 → 該当チケットのタグ配列から除去。',
      el('br'),
      '※ 色・説明はチケット表示時のピル装飾とツールチップに使われます。',
    ]),
  ]);

  void getTagDictionary().then((list) => {
    initialSnapshot = list.map(t => ({ ...t }));
    draft = list.map(t => ({ ...t }));
    rowOrigin = list.map(t => t.name);
    renderList();
  });
  renderList();

  const save = async (): Promise<void> => {
    try {
      const renames = new Map<string, string>();
      const presentOrigins = new Set<string>();
      for (let i = 0; i < draft.length; i++) {
        const o = rowOrigin[i];
        if (!o) continue;
        presentOrigins.add(o);
        if (o !== draft[i]!.name) renames.set(o, draft[i]!.name);
      }
      const deletions = new Set<string>(
        initialSnapshot.map(t => t.name).filter(n => !presentOrigins.has(n))
      );

      await setTagDictionary(draft);

      if (renames.size > 0 || deletions.size > 0) {
        const repo = getRepo();
        const result = await repo.bulkMigrateTicketTags?.(renames, deletions);
        const parts: string[] = ['タグ辞書を保存'];
        if (renames.size > 0) parts.push(`改名 ${renames.size} 件`);
        if (deletions.size > 0) parts.push(`削除 ${deletions.size} 件`);
        if (result && result.updated > 0) parts.push(`既存チケット ${result.updated} 件を一括更新`);
        if (result && result.errors.length > 0) {
          toast(root, `${parts.join(' / ')} (エラー ${result.errors.length} 件)`, 'warn', 8000);
          console.warn('[spira/tags] bulk migrate errors:', result.errors);
        } else {
          toast(root, parts.join(' / '), 'ok', 6000);
        }
        initialSnapshot = draft.map(t => ({ ...t }));
        rowOrigin = draft.map(t => t.name);
      } else {
        toast(root, `タグ辞書を保存しました (${draft.length} 件)`, 'ok', 4000);
      }
      setState({});
    } catch (e) {
      toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      throw e;
    }
  };

  return { body, save };
}

/** TagDef からチケット表示用のピル DOM を生成。 */
export function renderTagPill(tag: TagDef): HTMLElement {
  const s = TAG_COLOR_STYLE[tag.color];
  return el('span', {
    class: 'spira-tag-pill',
    style:
      `display:inline-flex;align-items:center;padding:1px 8px;` +
      `border-radius:10px;font-size:var(--fs-xs);` +
      `background:${s.bg};color:${s.fg};border:1px solid ${s.border}`,
    title: tag.description ?? tag.name,
  }, [tag.name]);
}

/** バージョン管理モーダル。
 *  - 現在のビルド ID 表示
 *  - 最新ビルド ID (SP の SpiraSettings に登録、編集可能)
 *  - 更新先 URL (SpiraSettings に登録)
 *  - 「現バージョンを最新に登録」ショートカット (dev / 管理者用)
 *  レイアウトは履歴追加・チケットプロパティと同じ 2 列グリッド。 */
export function buildVersionPanel(root: HTMLElement): { body: HTMLElement; save: () => Promise<void> } {
  const LABEL_STYLE =
    'color:var(--ink-3);font-size:var(--fs-sm);' +
    'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
  const LABEL_TOP_STYLE = LABEL_STYLE + ';align-self:start;padding-top:8px';
  const CODE_STYLE =
    'font-family:ui-monospace,Menlo,monospace;font-size:12px;' +
    'background:var(--paper-2);padding:2px 6px;border-radius:3px;' +
    'word-break:break-all;display:inline-block;max-width:100%';

  const current = currentBuildId();
  let urlDraft = '';
  const latestDisplay = el('code', { style: CODE_STYLE }, ['(未登録)']);

  const urlInput = el('input', {
    type: 'url',
    placeholder: 'https://your-server.example/spira/install.html',
    style:
      'width:100%;padding:var(--s-2) var(--s-3);' +
      'border:1px solid var(--line);border-radius:var(--r-2);' +
      'font-size:12px;font-family:ui-monospace,Menlo,monospace;' +
      'background:var(--paper);color:var(--ink)',
  }) as HTMLInputElement;
  urlInput.addEventListener('input', () => { urlDraft = urlInput.value; });

  const grid = el('div', {
    style:
      'display:grid;grid-template-columns:120px minmax(0,1fr);' +
      'gap:var(--s-3) var(--s-4);align-items:center',
  }, [
    el('label', { style: LABEL_STYLE }, ['現在のビルド']),
    el('div', { style: 'min-width:0' }, [el('code', { style: CODE_STYLE }, [current])]),

    el('label', { style: LABEL_STYLE }, ['登録済み最新']),
    el('div', { style: 'min-width:0' }, [latestDisplay]),

    el('label', { style: LABEL_TOP_STYLE }, ['更新先 URL']),
    el('div', { style: 'min-width:0' }, [urlInput]),

    el('div', {
      style:
        'grid-column:1 / -1;' +
        'font-size:var(--fs-xs);color:var(--ink-3);' +
        'background:var(--paper-2);padding:var(--s-3);' +
        'border-radius:var(--r-2);line-height:1.6;margin-top:var(--s-2)',
    }, [
      '※ 最新ビルド ID は Spira 起動時に自動更新されます (新しい bookmarklet を開いた人が SoT)。',
      el('br'),
      '※ 設定は SpiraSettings リストに保存され、全ユーザーで共有されます。',
      el('br'),
      '※ 古いビルドを開いたユーザーには起動時に更新バナーが表示され、更新先 URL に誘導されます。',
    ]),
  ]);

  // 非同期ロード — 既存値を input/display に流し込む
  void loadVersionInfo().then((info) => {
    urlDraft = info.updateUrl ?? '';
    urlInput.value = urlDraft;
    latestDisplay.textContent = info.latest ?? '(未登録)';
  });

  const save = async (): Promise<void> => {
    try {
      await saveUpdateUrl(urlDraft.trim() || null);
      toast(root, '更新先 URL を保存しました', 'ok', 4000);
    } catch (e) {
      toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      throw e;
    }
  };

  return { body: grid, save };
}

export function openVersionModal(root: HTMLElement): void {
  const { body, save } = buildVersionPanel(root);
  openModal(root, {
    title: 'バージョン管理',
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: save,
  });
}

function buildPaFlowsBodyImpl(root: HTMLElement): HTMLElement {
  // The help modal covers 3 Power Automate flows that Spira relies on:
  //   ① Inbox Ingest        — Outlook mail → SP InboxMails list
  //   ② Teams Thread Create — SP TeamsPostRequests → Teams post → DeepLink writeback
  //   ③ Forms Ingest        — Microsoft Forms response → SP InboxMails (forms-* convId)
  // Each is wrapped in a <details> toggle so the modal stays scannable.
  //
  // Steps below match the column schema declared in api/sp.ts
  // (`inboxFieldSpecs` / `ticketFieldSpecs` / `teamsPostRequestFieldSpecs`)
  // — keep in sync if the schema changes.

  const h = (text: string): HTMLElement =>
    el('h3', { style: 'margin:var(--s-5) 0 var(--s-2);font-size:var(--fs-md);font-weight:600;color:var(--ink)' }, [text]);

  const p = (text: string): HTMLElement =>
    el('p', { style: 'margin:0 0 var(--s-3);line-height:1.7;font-size:var(--fs-sm);color:var(--ink)' }, [text]);

  /** Paragraph with mixed text/element children (e.g. inline <code>). */
  const pn = (...children: (string | HTMLElement)[]): HTMLElement =>
    el('p', { style: 'margin:0 0 var(--s-3);line-height:1.7;font-size:var(--fs-sm);color:var(--ink)' }, children);

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

  /** Collapsible section. `open` controls initial expansion (only the first
   *  flow expanded by default to keep the modal compact). */
  const toggle = (title: string, subtitle: string, contents: HTMLElement[], open = false): HTMLElement => {
    const summary = el('summary', {
      style:
        'cursor:pointer;list-style:none;padding:var(--s-4) var(--s-5);' +
        'background:var(--paper-2);border:1px solid var(--line);border-radius:var(--r-2);' +
        'font-weight:600;font-size:var(--fs-md);color:var(--ink);' +
        'display:flex;align-items:center;gap:var(--s-3);user-select:none',
    }, [
      el('span', { style: 'font-size:0.85em;color:var(--ink-3);transition:transform 0.15s', class: 'spira-toggle-marker' }, ['▶']),
      el('span', { style: 'flex:1' }, [title]),
      el('span', { style: 'font-size:var(--fs-xs);color:var(--ink-3);font-weight:400' }, [subtitle]),
    ]);
    const det = el('details', {
      style: 'margin-bottom:var(--s-3)',
      ...(open ? { open: '' } : {}),
    }, [
      summary,
      el('div', {
        style: 'padding:var(--s-4) var(--s-5);border:1px solid var(--line);border-top:0;' +
               'border-radius:0 0 var(--r-2) var(--r-2);background:var(--paper)',
      }, contents),
    ]);
    // 開閉時に三角マーカーを回転
    det.addEventListener('toggle', () => {
      const marker = summary.querySelector<HTMLElement>('.spira-toggle-marker');
      if (marker) marker.style.transform = (det as HTMLDetailsElement).open ? 'rotate(90deg)' : 'rotate(0)';
    });
    return det;
  };

  const row = (k: string, v: string, hint?: string): HTMLElement =>
    el('tr', {}, [
      el('td', { style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)' }, [k]),
      el('td', { style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top' }, [
        el('div', { style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)' }, [v]),
        ...(hint ? [el('div', { style: 'font-size:11px;color:var(--ink-3);margin-top:2px' }, [hint])] : []),
      ]),
    ]);

  /** PA アクションのステップカード。番号付きヘッダ + アクション名 +
   *  入力パラメータ表 (各フィールドに何を入れるかを明示) + 補足。
   *  ユーザが「PA で目の前のフォームをどう埋めるか」を 1 画面で見られる
   *  ことに最適化したレイアウト。 */
  interface StepParam {
    field: string;       // フォームのラベル名 (例: "Folder", "Site Address")
    value: string;       // 入れる値 (動的コンテンツ名 / 式 / 固定値)
    type?: 'static' | 'dynamic' | 'expression' | 'choose'; // 表示色分け
    hint?: string;       // 補足
  }
  const stepCard = (opts: {
    num: number | string;
    title: string;
    connector?: string;   // 例: "Microsoft 365 Outlook"
    action?: string;      // 例: "When a new email arrives (V3)"
    note?: string;        // ステップ全体の補足
    params?: StepParam[]; // 入力パラメータ
    extra?: HTMLElement[];// パラメータ表の後ろに追加するブロック
  }): HTMLElement => {
    const typeBadge = (t?: StepParam['type']): HTMLElement => {
      const map: Record<NonNullable<StepParam['type']>, { label: string; color: string }> = {
        static:     { label: '固定値',     color: '#5e6f5c' },
        dynamic:    { label: '動的コンテンツ', color: '#3d8b8a' },
        expression: { label: '式',         color: '#a05a8c' },
        choose:     { label: '選択',       color: '#7a8aa9' },
      };
      const e = map[t ?? 'static'];
      return el('span', {
        style: `display:inline-block;padding:1px 6px;border-radius:8px;background:${e.color}22;color:${e.color};font-size:10px;font-weight:600;margin-left:6px;white-space:nowrap`,
      }, [e.label]);
    };
    const paramTable = (opts.params && opts.params.length > 0) ? el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:var(--s-2)',
    }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase;width:30%' }, ['フィールド名']),
          el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['設定値']),
        ]),
      ]),
      el('tbody', {}, opts.params.map((p) => el('tr', {}, [
        el('td', {
          style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-weight:500;color:var(--ink)',
        }, [p.field]),
        el('td', { style: 'padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top' }, [
          el('div', { style: 'display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap' }, [
            el('code', {
              style: 'background:var(--paper-2);padding:1px 6px;border-radius:3px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink);word-break:break-all',
            }, [p.value]),
            typeBadge(p.type),
          ]),
          ...(p.hint ? [el('div', { style: 'font-size:11px;color:var(--ink-3);margin-top:4px;line-height:1.5' }, [p.hint])] : []),
        ]),
      ]))),
    ]) : null;

    return el('div', {
      style: 'margin:var(--s-4) 0;border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-4) var(--s-5);background:var(--paper)',
    }, [
      // ヘッダ: ステップ番号 + タイトル
      el('div', { style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-2)' }, [
        el('span', {
          style: 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:13px;flex-shrink:0',
        }, [String(opts.num)]),
        el('h4', { style: 'margin:0;font-size:var(--fs-md);font-weight:600;color:var(--ink);flex:1' }, [opts.title]),
      ]),
      // アクション名 (コネクタ + アクション)
      ...((opts.connector || opts.action) ? [el('div', {
        style: 'margin:0 0 var(--s-2);padding:6px 10px;background:var(--paper-2);border-radius:var(--r-2);font-size:var(--fs-sm);color:var(--ink-2)',
      }, [
        el('span', { style: 'font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['追加するアクション: ']),
        ...(opts.connector ? [el('span', { style: 'color:var(--ink-2)' }, [opts.connector + ' / '])] : []),
        el('code', {
          style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#c7254e;background:transparent',
        }, [opts.action ?? '']),
      ])] : []),
      ...(opts.note ? [el('p', {
        style: 'margin:0 0 var(--s-2);font-size:var(--fs-sm);color:var(--ink-2);line-height:1.6;white-space:pre-wrap',
      }, [opts.note])] : []),
      ...(paramTable ? [paramTable] : []),
      ...(opts.extra ?? []),
    ]);
  };

  // ── Content sections ───────────────────────────────────────────────

  const intro = el('div', {}, [
    p('Spira は SharePoint 上のリスト (Tickets / Comments / InboxMails / TeamsPostRequests / SpiraSettings) のみで動作します。外部連携のため、Power Automate (PA) を最大 4 本作成します:'),
    el('ul', { style: 'margin:0 0 var(--s-3);padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [el('strong', {}, ['① メール取り込み']), ' — Outlook の新着メールを InboxMails リストに追加 (必須)']),
      el('li', {}, [el('strong', {}, ['② Teams スレッド作成']), ' — チケット起票時に Teams へ自動投稿し DeepLink を書き戻す (任意)']),
      el('li', {}, [el('strong', {}, ['③ Forms 取り込み']), ' — Microsoft Forms 応答を InboxMails に追加 (任意)']),
      el('li', {}, [el('strong', {}, ['④ Teams 返信同期']), ' — 管理チャネルの返信を InboxMails 経由でチケットに自動反映 (任意)']),
    ]),
    el('div', {
      style: 'background:var(--bg-soft);border-left:3px solid var(--accent);padding:var(--s-3) var(--s-4);margin:var(--s-3) 0;border-radius:4px;font-size:var(--fs-sm);line-height:1.7;color:var(--ink)',
    }, [
      el('strong', {}, ['★ 全パラメータを fx 式で記述']),
      el('br', {}),
      'このヘルプの設定値は ',
      el('strong', {}, ['すべて fx (式) タブにそのまま貼り付け']),
      ' できる式に統一しています。動的コンテンツ パネルは PA 新デザイナーやテナント差で表示が揺れるため、',
      '「式タブにコードを貼って保存」だけで誰でも同じ構成を再現できることを優先しました。',
      el('br', {}),
      '・入力フォームをクリック → 右上の ',
      code('式 (fx)'),
      ' タブを開く → 表内のコードを丸ごとコピペ → 「OK」または「追加」',
      el('br', {}),
      '・SP の選択肢 (Choice) 列は ',
      code("?['Value']"),
      ' を後ろに付けて文字列として取り出す (例: ',
      code("triggerOutputs()?['body/Status']?['Value']"),
      ')',
      el('br', {}),
      '・テナントによって path の大小 (例: ',
      code('body/Id'),
      ' vs ',
      code('body/id'),
      ') が違う場合があるので、保存実行 → 出力 JSON を確認 → 差し替えで対応。',
    ]),
    p('下の各セクションをクリックして手順を表示できます。'),
  ]);

  const prereq = el('div', {}, [
    h('1. 必要なもの'),
    ol([
      el('div', {}, ['SharePoint サイト (Spira を入れたサイトと同じテナント)']),
      el('div', {}, [
        '取り込み対象のメールが届く ',
        el('strong', {}, ['担当者個人の Outlook メールボックス']),
        ' (問い合わせ用 ML を To/Cc で受信できる設定であること)。共有メールボックス前提ではない。',
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
    h('2. フロー本体の作成'),
    p('Power Automate を開き「+ 作成」 → 「自動化したクラウド フロー」を選択。フロー名 (例: Spira – Inbox Ingest) を入力し、以下のステップを順番に追加していきます。'),
    stepCard({
      num: 1,
      title: '受信メールをトリガーする',
      connector: 'Microsoft 365 Outlook',
      action: 'When a new email arrives (V3)',
      note: '★ 個人メールボックスを対象。To/Cc 条件で問い合わせ用 ML 宛のものだけ通すこと。',
      params: [
        { field: 'Folder', value: 'Inbox', type: 'choose', hint: '取り込み対象のフォルダ。サブフォルダ運用なら該当パスを選択。' },
        { field: 'To', value: '<対応 ML のメールアドレス>', type: 'static', hint: '★ 重要。問い合わせ受付 ML のアドレスを指定。空欄にすると全メールが流れ込む。' },
        { field: 'CC', value: '<同上 (To と OR で通したい場合)>', type: 'static', hint: 'To だけだと CC で来た問い合わせを取りこぼすので、可能なら CC にも同じ ML を指定。' },
        { field: 'Importance', value: 'Any', type: 'choose' },
        { field: 'Include Attachments', value: 'No', type: 'choose', hint: '添付の中身までは SP に保存しないため No 推奨。HasAttachments フラグだけ立つ。' },
        { field: 'Only with Attachments', value: 'No', type: 'choose' },
        { field: 'Subject Filter', value: '(空欄)', type: 'static', hint: '全件取り込みたい場合は空。特定タグだけ取り込むなら "[#" 等。' },
      ],
    }),
  ]);

  // Column mapping table — matches inboxFieldSpecs() in api/sp.ts
  // ★ すべての値は fx タブにそのまま貼り付け可能な式で記述している。
  //   動的コンテンツ名は環境差で揺れるが、fx 式なら誰でも同じ設定を
  //   再現できる (テナント差で path が違うときは hint 側の代替を試す)。
  const mappingTable = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:var(--s-2)',
  }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['列名 (SP)']),
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['fx 式 (値の入力欄 → 式タブに貼り付け)']),
      ]),
    ]),
    el('tbody', {}, [
      row('Title', "triggerOutputs()?['body/Subject']", '実質ダミー (SP の必須列)。Subject と同じ値で OK。'),
      row('Subject', "triggerOutputs()?['body/Subject']", 'メール件名そのまま。'),
      row('BodyHtml', "triggerOutputs()?['body/Body']", 'HTML 形式の本文。Spira がサニタイズして表示。'),
      row('BodyText', "triggerOutputs()?['body/BodyPreview']", 'プレーン テキスト本文 (短縮版で OK)。'),
      row('FromEmail', "triggerOutputs()?['body/From']", '差出人アドレス。内部/外部判定にも使う。'),
      row('FromName', "coalesce(triggerOutputs()?['body/From'], '')", '★ V3 トリガでは「From - Name」を fx で安定して取る path が無い。とりあえずアドレスを入れておけば、Spira 側が AD 表示名にフォールバックして補完する。表示名が必要なら「メールの取得 (V2)」を挟んで body(\'メールの取得\')?[\'From\']?[\'EmailAddress\']?[\'Name\'] 等を試す。'),
      row('HasAttachments', "triggerOutputs()?['body/HasAttachment']", 'true/false。'),
      row('ConversationId', "triggerOutputs()?['body/ConversationId']", 'スレッド ID。受信パネルで会話単位の紐付けに使用。'),
      row('ReceivedAt', "triggerOutputs()?['body/DateTimeReceived']", 'このメールボックスにメールが到着した時刻。表示・ソート用。テナントによっては body/ReceivedDateTime / body/receivedDateTime も。'),
      row('SentAt', "body('メールの取得')?['DateTimeSent']", '★ STEP 2 「メールの取得 (V2)」の出力から取る前提。SentAt は Spira の重複起票判定 (送信者+送信時刻一致) の主キー。空でも動くが、別人の同タイミングメールで誤判定の可能性。アクション名を変えた場合は body(\'<アクション名>\')?[\'DateTimeSent\'] に合わせる。トリガ直挿しなら triggerOutputs()?[\'body/sentDateTime\'] / triggerOutputs()?[\'body/DateTimeSent\'] を順に試す。'),
      row('OwaLink', "concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))", 'メッセージ ID から OWA URL を構築。V3 トリガでは「Web Link」動的コンテンツが出ないので fx 必須。'),
      row('IsProcessed', 'false', 'Spira 側で取り込み完了時に true に更新。値タブに直接入力でも fx に false を貼り付けでも可。'),
      row('IsHidden', 'false', '非表示フラグ。同上。'),
      row('InternetMessageId', "triggerOutputs()?['body/InternetMessageId']", 'メールの一意 ID。重複防止に使用 (必須)。'),
    ]),
  ]);

  const action = el('div', {}, [
    stepCard({
      num: 2,
      title: 'SentAt (送信時刻) を取得 — 推奨',
      connector: 'Microsoft 365 Outlook',
      action: 'メールの取得 (V2) — Get email (V2)',
      note: 'V3 トリガの body には sentDateTime が含まれないことが多いので、トリガー直後にこのアクションを挟むと安定して取得できます。SentAt は Spira の重複起票判定 (送信者 + 送信時刻一致) に使う主キーなので入れることを推奨。空でも動作はしますが、別人の同タイミングメールで誤判定の可能性あり。',
      params: [
        { field: 'Message Id', value: "triggerOutputs()?['body/Id']", type: 'expression', hint: 'fx タブに貼り付け (動的コンテンツ「Message Id」と同義)。' },
      ],
    }),
    stepCard({
      num: 3,
      title: 'InboxMails リストに行を作成',
      connector: 'SharePoint',
      action: '項目の作成 (Create item)',
      note: 'これが本フローのメインアクションです。受信メールの内容を SP に保存して Spira に流します。',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose', hint: 'Spira を導入した SP サイト。一覧から選択するか「カスタム値を入力」で直接 URL 入力。' },
        { field: 'List Name', value: 'InboxMails', type: 'choose' },
      ],
      extra: [
        el('h5', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)' },
          ['「項目の作成」で表示される各列への入力値:']),
        el('p', { style: 'margin:0 0 var(--s-2);font-size:var(--fs-xs);color:var(--ink-3)' },
          ['※ 列名は大文字小文字含めて完全一致。動的コンテンツパネル / 式タブのどちらに入力するかは右端の色バッジで判別。']),
        mappingTable,
        el('h5', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)' },
          ['補足情報']),
        pn('OwaLink の式 (動的コンテンツに「Web Link」が出ないため): '),
        codeBlock("concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))"),
        pn('別形式の OWA リンクを使いたい場合: '),
        codeBlock("concat('https://outlook.office365.com/owa/?ItemID=', encodeUriComponent(triggerOutputs()?['body/Id']), '&exvsurl=1&viewmodel=ReadMessageItem')"),
        pn('SentAt の動的コンテンツに「Sent Time」が見える場合はそれをバインド可。見えない場合は ',
          code("triggerOutputs()?['body/sentDateTime']"),
          ' / ',
          code("triggerOutputs()?['body/DateTimeSent']"),
          ' を「式」タブから試す。'),
      ],
    }),
  ]);

  const verify = el('div', {}, [
    h('3. 動作確認'),
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
    h('4. トラブルシューティング'),
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

  // ============================================================
  // PA フロー ② — Teams スレッド作成
  // ============================================================
  const teamsTable = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:var(--s-2)',
  }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['列名 (SP)']),
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['内容']),
      ]),
    ]),
    el('tbody', {}, [
      row('TicketId', '対象チケットの Id (Number)', '完了後に DeepLink を書き戻す対象。'),
      row('ThreadType', "'internal' または 'user'", "internal=社内議論用 / user=顧客向けチャネル。Spira 側で `IsInternal` ボタンを押した側に応じて書き分け。"),
      row('ChannelId', 'Teams チャネル ID', 'Spira 設定の「Teams channels」で登録した値が起票時に埋め込まれる。'),
      row('TeamId', 'Teams チーム ID (= Group Id)', '同上。'),
      row('RequestedAt', '起票時刻 (DateTime)', '監視・タイムアウト判定用。'),
      row('Status', "'Pending' / 'Completed' / 'Failed'", '初期は Pending。PA 完了で Completed (= 行削除) または Failed に。'),
      row('ErrorMessage', 'Note', 'Failed 時に Teams API のエラーメッセージを記録。'),
      row('Subject', '起票モーダルで編集した件名', 'Teams 親メッセージの subject に直接渡す。空なら PA 側のテンプレ任せ。'),
      row('BodyHtml', '起票モーダルで編集した本文 (HTML)', 'Teams 親メッセージの body にそのまま使う。空なら PA 側のテンプレ任せ。'),
      row('MentionedEmails', "メンション対象のメール (CSV)", '例: alice@example.com,bob@example.com。PA は「Get user profile (V2)」で AAD ObjectId を解決し、 <at> タグ + mentions[] を組み立てる。'),
    ]),
  ]);

  const teamsFlow = el('div', {}, [
    pn('Spira でチケットの「Teams スレッド起票」ボタンを押すと、SP の ', code('TeamsPostRequests'), ' リストに 1 行追加されます。PA フロー ② はその行を検知して Teams に投稿し、Tickets リストに DeepLink を書き戻します。'),

    h('1. 前提'),
    el('ul', { style: 'margin:0 0 var(--s-3);padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, ['Spira 設定 → ', el('em', {}, ['Teams channels']), ' で内部用/ユーザー用チャネルを登録済みであること']),
      el('li', {}, ['Microsoft Teams コネクタの認証アカウントがチャネルに投稿権限を持つこと']),
      el('li', {}, [code('TeamsPostRequests'), ' リストが Spira 初回起動で作成済みであること (', code('ensureLists'), ' が自動作成)']),
    ]),

    h('2. 入力データ (TeamsPostRequests リスト) のスキーマ'),
    pn('Spira が起票時に下記スキーマで 1 行 INSERT します。PA 側ではこれらの列を ',
      code("triggerOutputs()?['body/<列名>']"),
      ' で参照できます。'),
    teamsTable,

    h('3. フロー本体の作成'),
    p('「+ 作成」 → 「自動化したクラウド フロー」。フロー名 (例: Spira – Teams Thread Create)。以下のステップを順番に追加:'),

    stepCard({
      num: 1,
      title: 'TeamsPostRequests への INSERT をトリガー',
      connector: 'SharePoint',
      action: '項目が作成されたとき (When an item is created)',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'TeamsPostRequests', type: 'choose' },
      ],
    }),

    stepCard({
      num: 2,
      title: 'Pending 行のみ処理する (再投稿防止)',
      action: 'コントロール / 条件 (Condition)',
      note: '同じ行への再実行・誤投稿を防ぐため、Status が Pending のときだけ続行。以降のステップは全て「はいの場合」分岐内に配置。\n\n⚠ Status は SP の Choice (選択肢) 列です。動的コンテンツから取り出すときに 必ず「Status Value」を選んでください (= 文字列を返す)。「Status」を選ぶと {Value: "Pending"} のオブジェクトが返り、比較に失敗します。',
      params: [
        { field: '左辺 (Choose a value)', value: "triggerOutputs()?['body/Status']?['Value']", type: 'expression', hint: 'fx タブに貼り付け。SP の Choice 列は {Value: "Pending"} のオブジェクトを返すので必ず ?[\'Value\'] で文字列を取り出す。新デザイナーで body/Status が解決できないテナントは triggerBody()?[\'Status\']?[\'Value\'] を試す。' },
        { field: '比較演算子', value: 'is equal to', type: 'choose' },
        { field: '右辺 (Choose a value)', value: 'Pending', type: 'static' },
      ],
    }),

    stepCard({
      num: 3,
      title: 'Tickets リストからチケット情報を取得',
      connector: 'SharePoint',
      action: '項目の取得 (Get item)',
      note: 'Teams 投稿の本文に件名・説明・影響度・ステータスを埋め込むためにチケット行を取得。',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'Tickets', type: 'choose' },
        { field: 'Id', value: "triggerOutputs()?['body/TicketId']", type: 'expression', hint: 'fx タブに貼り付け。' },
      ],
    }),

    stepCard({
      num: '3a',
      title: 'メンション組み立て用の変数を 3 つ初期化 — 任意',
      connector: 'コントロール',
      action: '変数を初期化する (Initialize variable) ×3',
      note: 'メンション機能を使う場合のみ必要。フロー先頭 (トリガーの直後) に「変数を初期化する」を 3 つ並べる。後段の Apply to each で順次 append していくため、ループの外で空状態を作っておく。\n\n名前 (Name) はコピペ前提のため厳密一致させること。STEP 3c / STEP 4 の式で同じ名前を参照する。',
      params: [
        { field: '#1 Name',  value: 'mentionsArray', type: 'static', hint: '型 (Type) = Array、Value = 空欄 (= 空配列)' },
        { field: '#2 Name',  value: 'mentionsHtml',  type: 'static', hint: '型 (Type) = String、Value = 空欄 (= 空文字列)' },
        { field: '#3 Name',  value: 'idx',           type: 'static', hint: '型 (Type) = Integer、Value = 0' },
      ],
    }),

    stepCard({
      num: '3b',
      title: 'メンション対象 (MentionedEmails) を配列化 — 任意',
      connector: 'Data Operation',
      action: '作成 (Compose) — 名前は「MentionEmails」にリネーム必須',
      note: 'Spira が MentionedEmails 列にメール CSV を入れてくる。後段の Apply to each で配列展開するために、ここで split() しておく。\n\n空のときは空配列を返すので、メンション無しの場合も安全に処理が進む。',
      params: [
        { field: 'アクション名 (リネーム)', value: 'MentionEmails', type: 'static' },
        { field: '入力 (fx)', value: "if(empty(triggerOutputs()?['body/MentionedEmails']), createArray(), split(triggerOutputs()?['body/MentionedEmails'], ','))", type: 'expression', hint: 'カンマ区切り文字列 → 配列。空文字なら空配列。' },
      ],
    }),

    stepCard({
      num: '3c',
      title: 'Apply to each で 1 ユーザずつ AAD 解決 + 変数に追記 — 任意',
      connector: 'コントロール',
      action: 'Apply to each (内側に 4 アクション)',
      note: 'MentionEmails の配列を 1 件ずつループし、ループ内で「AAD 解決」+「mentions[] に追記」+「<at> タグを HTML 文字列に追記」+「idx を +1」を行う。\n\nループ後には variables(\'mentionsArray\') と variables(\'mentionsHtml\') が STEP 4 (Teams 投稿) で使える形に組み上がる。',
      params: [
        { field: 'Apply to each / 入力', value: "outputs('MentionEmails')", type: 'expression', hint: 'fx タブに貼り付け。' },
      ],
      extra: [
        el('p', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)' }, [
          'Apply to each の内側に置くアクション (順番厳守):',
        ]),
        // ループ内 ① Get user profile (V2)
        el('div', {
          style: 'border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0;background:var(--paper-2)',
        }, [
          el('div', { style: 'font-size:var(--fs-sm);font-weight:600;color:var(--ink);margin-bottom:6px' }, [
            '内側 ① ', el('code', { style: 'background:transparent;color:#c7254e' }, ['Office 365 ユーザー / ユーザー プロファイル (V2) の取得']),
          ]),
          el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' }, [
            el('tbody', {}, [
              row('User (UPN)', "items('Apply_to_each')", 'fx タブに貼り付け。ループの現在の email が渡る。アクション名はそのまま (= 後段で body(\'ユーザー_プロファイル__V2__の取得\') で参照する想定)。'),
            ]),
          ]),
        ]),
        // ループ内 ② Append to array variable (mentionsArray)
        el('div', {
          style: 'border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0;background:var(--paper-2)',
        }, [
          el('div', { style: 'font-size:var(--fs-sm);font-weight:600;color:var(--ink);margin-bottom:6px' }, [
            '内側 ② ', el('code', { style: 'background:transparent;color:#c7254e' }, ['コントロール / 配列変数に追加 (Append to array variable)']),
          ]),
          el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' }, [
            el('tbody', {}, [
              row('Name', 'mentionsArray', 'プルダウンから選択 (STEP 3a で初期化した配列変数)。'),
              row('Value (fx)', "json(concat('{\\\"id\\\":', variables('idx'), ',\\\"mentionText\\\":\\\"', body('ユーザー_プロファイル__V2__の取得')?['displayName'], '\\\",\\\"mentioned\\\":{\\\"user\\\":{\\\"id\\\":\\\"', body('ユーザー_プロファイル__V2__の取得')?['id'], '\\\",\\\"displayName\\\":\\\"', body('ユーザー_プロファイル__V2__の取得')?['displayName'], '\\\",\\\"userIdentityType\\\":\\\"aadUser\\\"}}}'))",
                'fx タブに貼り付け (改行せず 1 行で OK)。json(concat(...)) で文字列を組み立てて JSON オブジェクトとしてパース。配列変数の Value にはオブジェクトを渡せる。'),
            ]),
          ]),
          el('p', {
            style: 'margin:var(--s-2) 0 0;font-size:var(--fs-xs);color:var(--ink-3);line-height:1.6',
          }, [
            '※ 整形して読みやすくしたバージョン:',
          ]),
          codeBlock(
            "json(concat(\n" +
            "  '{\"id\":', variables('idx'),\n" +
            "  ',\"mentionText\":\"', body('ユーザー_プロファイル__V2__の取得')?['displayName'],\n" +
            "  '\",\"mentioned\":{\"user\":{\"id\":\"', body('ユーザー_プロファイル__V2__の取得')?['id'],\n" +
            "  '\",\"displayName\":\"', body('ユーザー_プロファイル__V2__の取得')?['displayName'],\n" +
            "  '\",\"userIdentityType\":\"aadUser\"}}}'\n" +
            "))"
          ),
        ]),
        // ループ内 ③ Append to string variable (mentionsHtml)
        el('div', {
          style: 'border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0;background:var(--paper-2)',
        }, [
          el('div', { style: 'font-size:var(--fs-sm);font-weight:600;color:var(--ink);margin-bottom:6px' }, [
            '内側 ③ ', el('code', { style: 'background:transparent;color:#c7254e' }, ['コントロール / 文字列変数に追加 (Append to string variable)']),
          ]),
          el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' }, [
            el('tbody', {}, [
              row('Name', 'mentionsHtml', 'プルダウンから選択 (STEP 3a の文字列変数)。'),
              row('Value (fx)', "concat('<at id=\"', variables('idx'), '\">', body('ユーザー_プロファイル__V2__の取得')?['displayName'], '</at> ')",
                'fx タブに貼り付け。<at id="N">表示名</at> + 半角スペースを 1 件ぶん追記。'),
            ]),
          ]),
        ]),
        // ループ内 ④ Increment variable (idx)
        el('div', {
          style: 'border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0;background:var(--paper-2)',
        }, [
          el('div', { style: 'font-size:var(--fs-sm);font-weight:600;color:var(--ink);margin-bottom:6px' }, [
            '内側 ④ ', el('code', { style: 'background:transparent;color:#c7254e' }, ['コントロール / 変数の値を増やす (Increment variable)']),
          ]),
          el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' }, [
            el('tbody', {}, [
              row('Name', 'idx', 'プルダウンから選択。'),
              row('Value', '1', '直接入力 (静的整数)。これで次のループの id が 1 つ進む。'),
            ]),
          ]),
        ]),
        // 完成イメージ
        el('p', {
          style: 'margin:var(--s-4) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)',
        }, ['ループ完了後の状態 (メール 2 件 alice@..., bob@... の場合):']),
        codeBlock(
          "variables('mentionsArray') = [\n" +
          "  { id: 0, mentionText: \"Alice\", mentioned: { user: { id: \"<aad-A>\", displayName: \"Alice\", userIdentityType: \"aadUser\" }}},\n" +
          "  { id: 1, mentionText: \"Bob\",   mentioned: { user: { id: \"<aad-B>\", displayName: \"Bob\",   userIdentityType: \"aadUser\" }}}\n" +
          "]\n" +
          "variables('mentionsHtml') = '<at id=\"0\">Alice</at> <at id=\"1\">Bob</at> '\n" +
          "variables('idx') = 2"
        ),
      ],
    }),

    stepCard({
      num: 4,
      title: 'Teams チャネルにメッセージ投稿',
      connector: 'Microsoft Teams',
      action: 'チャネル内でメッセージを投稿する (Post message in a chat or channel)',
      params: [
        { field: 'Post as', value: 'Flow bot', type: 'choose', hint: 'もしくは「ユーザー」(自分の名前で投稿したい場合)。' },
        { field: 'Post in', value: 'Channel', type: 'choose' },
        { field: 'Team', value: "triggerOutputs()?['body/TeamId']", type: 'expression', hint: 'チームの一覧から選ぶのではなく、「カスタム値を入力」タブで TeamId を直接渡す。' },
        { field: 'Channel', value: "triggerOutputs()?['body/ChannelId']", type: 'expression', hint: '同上 — カスタム値タブで ChannelId を渡す。' },
        { field: 'Subject', value: "if(empty(triggerOutputs()?['body/Subject']), concat('[#', triggerOutputs()?['body/TicketId'], '] ', body('項目の取得')?['Title']), triggerOutputs()?['body/Subject'])", type: 'expression', hint: 'Spira 起票モーダルで入力された Subject 列があればそれを優先、空ならチケットタイトルからテンプレ生成。fx タブから入力。' },
        { field: 'Message (HTML)', value: "if(empty(triggerOutputs()?['body/BodyHtml']), '<下記サンプル参照>', concat(variables('mentionsHtml'), triggerOutputs()?['body/BodyHtml']))", type: 'expression', hint: 'BodyHtml 列 (起票モーダルで編集された本文) を使い、先頭に mentionsHtml (<at> タグ列) を連結する。空のときは下のサンプル HTML をテンプレに使う構成も可。' },
        { field: 'Mentions (詳細オプション)', value: "variables('mentionsArray')", type: 'expression', hint: 'STEP 3c で組み立てた mentions オブジェクトの配列。空配列でも OK。' },
      ],
      extra: [
        el('p', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);color:var(--ink-2)' }, [
          '投稿本文 HTML サンプル (BodyHtml が空のときのフォールバック):',
        ]),
        codeBlock(
          '<h3>[#@{triggerOutputs()?[\'body/TicketId\']}] @{body(\'項目の取得\')?[\'Title\']}</h3>\n' +
          '<p><b>影響度:</b> @{body(\'項目の取得\')?[\'Priority\']} / <b>ステータス:</b> @{body(\'項目の取得\')?[\'Status\']}</p>\n' +
          '<p>@{body(\'項目の取得\')?[\'Description\']}</p>\n' +
          '<hr><p><i>このメッセージは Spira から自動投稿されています。</i></p>'
        ),
        el('p', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);color:var(--ink-2)' }, [
          'mentionsHtml の組み立て (フロー先頭で文字列変数として初期化、STEP 3c のループ内で <at> タグを追記):',
        ]),
        codeBlock(
          '<!-- variables(\'mentionsHtml\') の中身イメージ -->\n' +
          '<at id="0">山田 太郎</at> <at id="1">佐藤 花子</at> '
        ),
      ],
    }),

    stepCard({
      num: 5,
      title: 'ThreadType で分岐 — 内部 / ユーザー',
      action: 'コントロール / Switch',
      note: 'ThreadType が internal / user で書き戻す列名が変わるため、Switch で分岐させると見通しが良い。各分岐の中に次のステップ (項目の更新) を配置。\n\n⚠ ThreadType も Choice (選択肢) 列です。スイッチ対象は必ず「ThreadType Value」 (文字列) を使うこと。',
      params: [
        { field: 'スイッチ対象 (On)', value: "triggerOutputs()?['body/ThreadType']?['Value']", type: 'expression', hint: 'fx タブに貼り付け。SP の Choice 列なので必ず ?[\'Value\'] で文字列を取り出す。' },
        { field: 'Case 1 — 等しい', value: 'internal', type: 'static', hint: 'この中で Tickets を InternalThreadId / InternalChannelId / InternalDeepLink で更新。' },
        { field: 'Case 2 — 等しい', value: 'user', type: 'static', hint: 'この中で Tickets を UserThreadId / UserChannelId / UserDeepLink で更新。' },
      ],
    }),

    stepCard({
      num: 6,
      title: 'Tickets リストに DeepLink を書き戻す (Switch の各分岐内)',
      connector: 'SharePoint',
      action: '項目の更新 (Update item)',
      note: 'ThreadType=internal の分岐では Internal* 列、ThreadType=user の分岐では User* 列を更新する (項目の更新アクションを 2 つ作って分岐に配置)。',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'Tickets', type: 'choose' },
        { field: 'Id', value: "triggerOutputs()?['body/TicketId']", type: 'expression' },
        { field: 'Title', value: "body('項目の取得')?['Title']", type: 'expression', hint: 'Title は SP 必須列なので既存値を渡し直す。' },
        { field: 'InternalThreadId (internal 分岐のみ)', value: "outputs('チャネル内でメッセージを投稿する')?['body/messageId']", type: 'expression' },
        { field: 'InternalChannelId (internal 分岐のみ)', value: "triggerOutputs()?['body/ChannelId']", type: 'expression' },
        { field: 'InternalDeepLink (internal 分岐のみ)', value: "outputs('チャネル内でメッセージを投稿する')?['body/linkToMessage']", type: 'expression' },
        { field: 'UserThreadId (user 分岐のみ)', value: "outputs('チャネル内でメッセージを投稿する')?['body/messageId']", type: 'expression' },
        { field: 'UserChannelId (user 分岐のみ)', value: "triggerOutputs()?['body/ChannelId']", type: 'expression' },
        { field: 'UserDeepLink (user 分岐のみ)', value: "outputs('チャネル内でメッセージを投稿する')?['body/linkToMessage']", type: 'expression' },
      ],
    }),

    stepCard({
      num: 7,
      title: 'TeamsPostRequests 行を削除 (キュー消化)',
      connector: 'SharePoint',
      action: '項目の削除 (Delete item)',
      note: 'これでキュー行が消えて、Spira 側のボタンが「スレッドを開く」に変わる (=DeepLink 書き戻し完了の合図)。',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'TeamsPostRequests', type: 'choose' },
        { field: 'Id', value: "triggerOutputs()?['body/ID']", type: 'expression', hint: '※ ID は大文字 (Title と同じ自動採番列)。fx タブに貼り付け。' },
      ],
    }),

    stepCard({
      num: '⚠',
      title: 'エラー時の分岐 (オプション)',
      action: 'コントロール / Configure run after — Failed 経路',
      note: 'ステップ 4 (Teams 投稿) が失敗したときに、TeamsPostRequests 行を更新するパスを別途用意。「Configure run after」で「has failed」「has timed out」を ON にして繋ぐ。',
      params: [
        { field: '対象アクション', value: '項目の更新 (TeamsPostRequests)', type: 'choose' },
        { field: 'Id', value: "triggerOutputs()?['body/ID']", type: 'expression' },
        { field: 'Status', value: 'Failed', type: 'static' },
        { field: 'ErrorMessage', value: "outputs('チャネル内でメッセージを投稿する')?['body']", type: 'expression', hint: 'Teams API のエラー本文。手動確認後に行を削除 or 再 Pending に戻す運用が安全。' },
      ],
    }),

    h('4. 動作確認'),
    ol([
      el('div', {}, ['Spira でチケットを開き「🏢 内部スレッド起票」または「👥 外部スレッド起票」をクリック']),
      el('div', {}, ['PA の実行履歴で成功を確認 → Teams チャネルに投稿が出る']),
      el('div', {}, ['Spira のボタン表示が「スレッドを開く」に変われば DeepLink 書き戻し成功']),
    ]),

    h('5. トラブルシューティング'),
    el('ul', { style: 'margin:0;padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [
        el('strong', {}, ['条件 (Condition) の「Status equals Pending」が常に False になる']),
        ': SP の Choice 列は ',
        code('{Value: "Pending"}'),
        ' のオブジェクトを返すため。動的コンテンツから ',
        el('strong', {}, ['「Status Value」']),
        ' を選び直すか、式タブで ',
        code("triggerOutputs()?['body/Status']?['Value']"),
        ' (新デザイナーなら ',
        code("triggerBody()?['Status']?['Value']"),
        ') と書く。同様に ThreadType も「ThreadType Value」を使う。',
      ]),
      el('li', {}, [
        el('strong', {}, ['「式には、デバッガーで解決できない動的な関数...」の警告が出る']),
        ': トリガー出力の動的コンテンツを式の中で使うと出る警告。フローを実際に保存して 1 回実行すれば動く (デバッガ未対応というだけ)。',
      ]),
      el('li', {}, [
        el('strong', {}, ['Teams 投稿が「権限がない」で失敗する']),
        ': PA の Teams コネクタの認証アカウントが、対象チャネルのメンバーかどうか確認。Flow bot として投稿する場合でも、認証アカウントの権限が要る。',
      ]),
      el('li', {}, [
        el('strong', {}, ['linkToMessage が空で書き戻される']),
        ': Teams 投稿アクションの出力スキーマで ',
        code('linkToMessage'),
        ' を参照しているか確認。コネクタ世代により ',
        code('webUrl'),
        ' / ',
        code('link'),
        ' の名前で来る場合があるので、実行履歴の Outputs で実際のキー名を確認。',
      ]),
      el('li', {}, [
        el('strong', {}, ['TeamsPostRequests 行が消えない (=Spira のボタンが変わらない)']),
        ': 最後のステップ「項目の削除」の Id 引数が ',
        code("triggerOutputs()?['body/ID']"),
        ' (大文字) になっているか確認。',
        code('id'),
        ' (小文字) では SP は受け取らない。',
      ]),
    ]),
  ]);

  // ============================================================
  // PA フロー ③ — Microsoft Forms 取り込み
  // ============================================================
  const formsTable = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:var(--s-2)',
  }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['列名 (InboxMails)']),
        el('th', { style: 'text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase' }, ['値']),
      ]),
    ]),
    el('tbody', {}, [
      row('Title', "concat('[Forms] ', outputs('応答の詳細を取得')?['body/<件名相当の質問の internal name>'])", 'SP 必須列。Subject と同じで OK。<件名相当の質問> 部分はテスト実行 → Outputs JSON で実際の internal name に置換。'),
      row('Subject', "concat('[Forms] ', outputs('応答の詳細を取得')?['body/<件名相当の質問の internal name>'])", 'Spira の受信メール一覧に表示される件名。'),
      row('BodyHtml', "outputs('BodyHtml を組み立てる')", '★ STEP 4 で組み立てた Compose の出力を fx で直参照。Compose のアクション名と一致させる。'),
      row('BodyText', "outputs('BodyHtml を組み立てる')", 'フォールバック用。Compose の HTML をそのまま入れても、Spira は HTML/text 両対応。別途プレーン用 Compose を作って参照しても可。'),
      row('FromEmail', "outputs('応答の詳細を取得')?['body/responder']", '回答者のメール (UPN)。匿名 Form なら空文字 \'\' を fx に貼る。'),
      row('FromName', "body('ユーザー_プロファイル__V2__の取得')?['displayName']", 'STEP 3 のユーザー プロファイル (V2) 出力から表示名。アクション名は実物に合わせる (日本語ローカライズでは「ユーザー プロファイル (V2) の取得」だが内部識別子は空白がアンスコ化される)。匿名 Form なら空文字 \'\'。'),
      row('ReceivedAt', 'utcNow()', '受信時刻として PA 実行時を入れる。'),
      row('SentAt', "triggerOutputs()?['body/submitDate']", '応答送信時刻。出ない場合は triggerOutputs()?[\'body/resourceData/submitDate\'] や outputs(\'応答の詳細を取得\')?[\'body/submitDate\'] を試す。'),
      row('ConversationId', "concat('forms-', triggerOutputs()?['body/formsId'], '-', triggerOutputs()?['body/resourceData/responseId'])", '★ 必須。Spira はこの forms- プレフィクスで Forms 経由を判別し、起票モーダルにフォーム回答を自動展開。'),
      row('InternetMessageId', "concat('forms-', triggerOutputs()?['body/resourceData/responseId'], '@', 'forms.office.com')", '重複防止用の擬似 Message-Id。responseId 単体でユニークなのでテナント値は固定文字列で OK。'),
      row('HasAttachments', 'false', 'Forms 応答に添付がある場合は別途処理 (基本 false)。'),
      row('IsProcessed', 'false', '初期値。Spira が起票時に true に更新。'),
      row('IsHidden', 'false', '通常は false。'),
    ]),
  ]);

  const formsFlow = el('div', {}, [
    pn('Microsoft Forms の応答を Spira の「受信メール」に流し込むフローです。Forms はチケットタグを件名に持たないので、Spira は ', code('ConversationId'), ' が ', code('forms-'), ' で始まるかどうかで Forms 経由メールを識別し、起票モーダルでフォーム回答 (カテゴリ・影響度) を自動マッピングします。'),

    h('1. 前提'),
    el('ul', { style: 'margin:0 0 var(--s-3);padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, ['Forms フォームに ', el('strong', {}, ['「カテゴリ」']), ' (選択肢)・', el('strong', {}, ['「影響度」']), ' (High / Medium / Low) の質問を含めることを推奨。値を BodyHtml に含めると、Spira が起票モーダルで自動選択します。']),
      el('li', {}, ['カテゴリの選択肢は Spira 設定 → ', el('em', {}, ['問い合わせ種別の選択肢']), ' と揃えるとマッピングが完全一致']),
      el('li', {}, ['Forms 応答取り込みは Standard ライセンスで完結 (Graph API 不要)']),
    ]),

    h('2. フロー本体の作成'),
    p('「+ 作成」 → 「自動化したクラウド フロー」。フロー名 (例: Spira – Forms Ingest)。以下のステップを順番に追加:'),

    stepCard({
      num: 1,
      title: 'Forms 応答送信をトリガー',
      connector: 'Microsoft Forms',
      action: '新しい応答が送信されるとき (When a new response is submitted)',
      params: [
        { field: 'Form Id', value: '(対象フォームを選択)', type: 'choose', hint: 'プルダウンから対象の Forms フォームを選ぶ。' },
      ],
    }),

    stepCard({
      num: 2,
      title: '応答の詳細を取得',
      connector: 'Microsoft Forms',
      action: '応答の詳細を取得 (Get response details)',
      note: 'これを通すことで、各質問の回答が動的コンテンツとして個別に参照できるようになる。',
      params: [
        { field: 'Form Id', value: '(同じフォームを選択)', type: 'choose' },
        { field: 'Response Id', value: "triggerOutputs()?['body/resourceData/responseId']", type: 'expression', hint: 'fx タブに貼り付け。テナントによっては body/responseId に変えて試す。' },
      ],
    }),

    stepCard({
      num: 3,
      title: '回答者のプロファイルを取得 (任意)',
      connector: 'Office 365 ユーザー',
      action: 'ユーザー プロファイル (V2) を取得 — Get user profile (V2)',
      note: 'FromName 列に AD の displayName を入れたい場合のみ。匿名 Form では不要。',
      params: [
        { field: 'User (UPN)', value: "outputs('応答の詳細を取得')?['body/responder']", type: 'expression', hint: '応答者の UPN (メール) を渡すと AD から表示名・部署等を取得できる。' },
      ],
    }),

    stepCard({
      num: 4,
      title: 'BodyHtml を組み立てる',
      action: 'コントロール / 作成 (Compose)',
      note: 'Q&A を HTML で整形。Spira が <strong>カテゴリ:</strong> / <strong>影響度:</strong> のラベルを正規表現で抽出するので、ラベルは厳密に日本語の「カテゴリ:」「影響度:」を使うこと。',
      params: [
        { field: '入力 (Inputs)', value: '(下記サンプル参照)', type: 'static' },
      ],
      extra: [
        el('p', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);color:var(--ink-2)' }, ['BodyHtml サンプル (Compose の「入力」欄):']),
        codeBlock(
          '<p><strong>カテゴリ:</strong> @{outputs(\'応答の詳細を取得\')?[\'body/<カテゴリ質問の internal name>\']}</p>\n' +
          '<p><strong>影響度:</strong> @{outputs(\'応答の詳細を取得\')?[\'body/<影響度質問の internal name>\']}</p>\n' +
          '<p><strong>内容:</strong></p>\n' +
          '<p>@{outputs(\'応答の詳細を取得\')?[\'body/<本文質問の internal name>\']}</p>'
        ),
        el('p', { style: 'margin:var(--s-2) 0;font-size:var(--fs-xs);color:var(--ink-3);line-height:1.6' }, [
          '※ 質問の internal name は「応答の詳細を取得」アクションを一度テスト実行して、Outputs の JSON で確認するのが確実。',
        ]),
      ],
    }),

    stepCard({
      num: 5,
      title: 'InboxMails リストに行を作成',
      connector: 'SharePoint',
      action: '項目の作成 (Create item)',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'InboxMails', type: 'choose' },
      ],
      extra: [
        el('h5', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)' },
          ['各列の入力値:']),
        el('p', { style: 'margin:0 0 var(--s-2);font-size:var(--fs-xs);color:var(--ink-3)' }, [
          '※ ★が付いた列は Spira の Forms 判別に必須 — 必ず値を入れること。',
        ]),
        formsTable,
        el('h5', { style: 'margin:var(--s-3) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink)' },
          ['ConversationId の生成式 (最重要):']),
        pn(code('forms-'), ' プレフィクスは Spira の判別キーなので必ず含めること。'),
        codeBlock("concat('forms-', triggerOutputs()?['body/formsId'], '-', triggerOutputs()?['body/resourceData/responseId'])"),
        pn('テナントによって動的コンテンツ名が異なる場合は ',
          code("triggerOutputs()?['body/resourceData/responseId']"),
          ' を ',
          code("triggerOutputs()?['body/responseId']"),
          ' に置き換えて試してください。'),
      ],
    }),

    h('3. 動作確認'),
    ol([
      el('div', {}, ['対象 Forms フォームから 1 件テスト送信']),
      el('div', {}, ['PA の実行履歴で成功を確認 → SP の ', code('InboxMails'), ' リストに行が追加されているか確認']),
      el('div', {}, [code('ConversationId'), ' 列が ', code('forms-...'), ' で始まっているか必ず確認 (このプレフィクスが無いと Spira がタグ無しメールと同じ扱いになり、Forms 用の特別処理が動きません)']),
      el('div', {}, ['Spira の「受信メール」に Forms 経由のメールが表示され、件名横に ', el('strong', {}, ['Forms バッジ']), ' が付いていれば成功']),
      el('div', {}, ['受信メールから「起票」をクリック → 起票モーダルでカテゴリ/影響度が自動選択されることを確認']),
    ]),

    h('4. トラブルシューティング'),
    el('ul', { style: 'margin:0;padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [
        el('strong', {}, ['カテゴリ/影響度が自動選択されない']),
        ': BodyHtml に ', code('<strong>カテゴリ:</strong> 値'), ' / ', code('<strong>影響度:</strong> High'),
        ' のフォーマットで含まれているか確認。',
      ]),
      el('li', {}, [
        el('strong', {}, ['Forms バッジが付かない']),
        ': ', code('ConversationId'), ' が ', code('forms-'), ' で始まっていない可能性。PA で必ず ',
        code("concat('forms-', ...)"), ' を使うこと。',
      ]),
      el('li', {}, [
        el('strong', {}, ['応答の詳細が空 (動的コンテンツが拾えない)']),
        ': トリガーの Response Id ではなく、「応答の詳細を取得」の Response Id 引数に渡しているか確認。動的コンテンツ名は ',
        code('triggerOutputs()?[\'body/responseId\']'), ' が一般的。',
      ]),
    ]),
  ]);

  // ============================================================
  // ============================================================
  // PA フロー ④ — Teams 返信同期
  // ============================================================
  const teamsSyncFlow = el('div', {}, [
    pn('Spira が起票時に Teams へ投稿したスレッドへの ',
       el('strong', {}, ['返信']), ' を、',
       el('strong', {}, ['同じチャネルから自動収集']), ' して該当チケットの ',
       '受信スレッドに反映するフロー。'),
    pn('内部スレッド / 外部スレッドの両方が同じ管理チャネル群に居る前提。'),
    pn('動作の流れ:'),
    el('ol', { style: 'margin:0 0 var(--s-3);padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, ['Teams チャネルにメッセージ投稿 → PA フロー④ が起動 (統合トリガー、Graph 変更通知のメタデータのみ受信)']),
      el('li', {}, ['「メッセージ詳細を取得する」で本文・差出人・日時など完全なメッセージ内容を Graph から取得']),
      el('li', {}, ['Compose (ReplyLen) で `length(replyToId)` を計算']),
      el('li', {}, ['条件 (2 行 AND): ReplyLen > 0 (= 返信) AND userIdentityType = aadUser (= 人間ユーザー)']),
      el('li', {}, ['返信を InboxMails に 1 行 INSERT (ConversationId = ', code("teams-<parentMessageId>"), ')']),
      el('li', {}, ['Spira の syncInbox が InternalThreadId / UserThreadId と照合']),
      el('li', {}, ['ヒット → Comments に追加 + InboxMails 行を物理削除 (= 受信一覧に出ない、自動でチケット詳細に反映)']),
      el('li', {}, ['ハズレ (チャネル外の議論・完了済前の議題等) → 受信一覧に Teams バッジ付きで残置、手動トリアージ']),
    ]),

    h('1. 前提'),
    el('ul', { style: 'margin:0 0 var(--s-3);padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [code('PA フロー②'), ' で Spira がチケット起票時に Teams へ親メッセージを投稿していること (InternalThreadId / UserThreadId が Tickets に保存される)']),
      el('li', {}, ['Spira 用の管理 Teams チャネル群が用意されている (1 つ以上)']),
      el('li', {}, ['Microsoft Teams コネクタの認証アカウントが対象チャネルのメンバーであること']),
    ]),

    h('2. フロー本体の作成'),
    pn('1 つのフローで ', el('strong', {}, ['同一チーム内の複数チャネルをまとめて監視できる']),
       '。トリガーの「チャネル」欄は配列入力なので「+ 新しいアイテム」で対象チャネルを追加していく。',
       '別チームのチャネルを監視したい場合のみフローを分ける。'),
    pn('構成は ', el('strong', {}, ['5 ステップ']), ': トリガー → メッセージ詳細を取得 → Compose (長さ計算) → 条件 (2 行) → SP 項目の作成。',
       '★ 統合トリガーは Graph 変更通知のメタデータしか返さない (`messageId`, `replyToMessageId`, `teamId`, `channelId` のみ。本文・差出人・日時はなし) ため、',
       el('strong', {}, ['先に「メッセージ詳細を取得する」で完全なメッセージを取ってから判定/書き込みを行う']), '。',
       'この順にすると条件式が GetMessage の動的コンテンツで素直に書ける。'),

    stepCard({
      num: 1,
      title: 'Teams メッセージをトリガーする',
      connector: 'Microsoft Teams',
      action: 'チャットまたはチャネルに新しいメッセージが作成されたとき (When a new message is added to a chat or channel)',
      note: '★ 統合トリガー。親メッセージ + 返信 + DM がすべて入ってくるので、後段の条件で「返信のみ」に絞り込む。',
      params: [
        { field: 'メッセージの種類', value: 'チャネル', type: 'choose', hint: 'Chat は対象外。必ず「チャネル」を選ぶ。' },
        { field: 'チーム', value: '(監視対象の Team を選択)', type: 'choose', hint: 'ドロップダウンが「利用できるコンテンツはありません」のときは、Spira 設定 → Teams チャネル設定 の teamId (GUID) を fx タブで `\'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\'` の形で貼り付け。' },
        { field: 'チャネル (Item - 1 / -2 / -3 ...)', value: '(監視対象のチャネルを 1 つ以上選択)', type: 'choose', hint: '★ 「+ 新しいアイテム」で複数チャネル追加可。チャネル ID は Spira 設定 → Teams チャネル設定 の channelId (`19:xxx@thread.tacv2`) を fx で貼り付けると確実。Spira 側の登録チャネルと一致させること。' },
      ],
    }),

    stepCard({
      num: 2,
      title: 'メッセージ詳細を取得する (Get message details)',
      connector: 'Microsoft Teams',
      action: 'メッセージ詳細を取得する (Get message details)',
      note: '★ トリガー直後に配置。アクション名を `GetMessage` のように ASCII にリネームしておくと後段で参照しやすい (アクションタイトルをダブルクリック)。これでメッセージ本文・差出人・日時を含む完全オブジェクトが取れる。',
      params: [
        { field: 'アクション名 (リネーム推奨)', value: 'GetMessage', type: 'static' },
        { field: 'メッセージ ID (Message id)', value: "triggerOutputs()?['body/value']?[0]?['messageId']", type: 'expression', hint: 'fx タブで貼り付け。スキーマ警告が出ても保存実行で通る。' },
        { field: 'メッセージの種類 (Message type)', value: 'チャネル (Channel)', type: 'choose' },
        { field: 'チーム (Team)', value: "triggerOutputs()?['body/value']?[0]?['teamId']", type: 'expression' },
        { field: 'チャネル (Channel)', value: "triggerOutputs()?['body/value']?[0]?['channelId']", type: 'expression' },
        { field: '親メッセージ ID (Parent message id)', value: "triggerOutputs()?['body/value']?[0]?['replyToMessageId']", type: 'expression', hint: '返信を取得するために必須。空でも入れておけば親メッセージのときは GetMessage がエラーを返してフロー終了 (取り込み無し) になる。' },
      ],
    }),

    stepCard({
      num: 3,
      title: 'Compose (作成) — replyToId の長さを計算 (ReplyLen)',
      connector: 'Data Operation',
      action: '作成 (Compose)',
      note: '★ 新デザイナーの条件アクションは使える関数が制限されており `length()` `coalesce()` `empty()` などを条件内で直接書くと「template function is not defined」エラーになる。そこで Compose に長さ計算を逃がし、後段の条件は単純な数値比較だけにする。',
      params: [
        { field: 'アクション名 (リネーム推奨)', value: 'ReplyLen', type: 'static', hint: 'アクションタイトルをダブルクリックして ASCII にリネーム。後段の条件 (動的コンテンツ) で参照しやすくなる。' },
        { field: '入力 (fx タブで式入力)', value: "length(coalesce(body('GetMessage')?['replyToId'], ''))", type: 'expression', hint: '返信なら replyToId に親メッセージ ID が入っているので length > 0。親メッセージなら replyToId が null なので coalesce で空文字 → length = 0。' },
      ],
    }),

    stepCard({
      num: 4,
      title: '条件 — 返信メッセージかつ aadUser のみ通す (2 行 AND)',
      connector: 'Control',
      action: '条件 (Condition)',
      note: '行 (Row) を 2 つ作り「すべての条件 (And)」で連結。新デザイナーは条件内で式直書きすると評価不能になるので、参照は動的コンテンツ + 単純比較で組む。',
      params: [
        { field: '行 1 / 値 1', value: "outputs('ReplyLen')", type: 'expression', hint: 'fx タブに貼り付け。STEP 3 のアクション名 (リネーム後の ReplyLen) と一致させる。' },
        { field: '行 1 / 演算子', value: '次の値より大きい (is greater than)', type: 'choose' },
        { field: '行 1 / 値 2', value: '0', type: 'static', hint: '直接入力。返信なら length > 0、親なら length = 0 で除外される。' },
        { field: '行 2 / 値 1 (fx タブ)', value: "body('GetMessage')?['from']?['user']?['userIdentityType']", type: 'expression', hint: '動的コンテンツに「User identity type」が出ていればそれをクリックでも可。' },
        { field: '行 2 / 演算子', value: '次の値に等しい (is equal to)', type: 'choose' },
        { field: '行 2 / 値 2', value: 'aadUser', type: 'static', hint: '文字列。クォート不要で直接入力。Bot / Application / anonymousGuest 投稿はここで除外。' },
        { field: '行同士の結合', value: 'すべての条件 (And)', type: 'choose' },
      ],
    }),

    stepCard({
      num: 5,
      title: 'InboxMails に行を作成 — Spira 側で自動振り分け',
      connector: 'SharePoint',
      action: '項目の作成 (Create item)',
      note: '★ STEP 4 の条件の「はい (True)」ブランチ内に配置 (「いいえ」ブランチは空のまま = フロー終了)。各値は fx タブで貼るのが確実だが、GetMessage の動的コンテンツ (Display name, Content, Created date time 等) があればクリックで OK。',
      params: [
        { field: 'Site Address', value: 'https://<tenant>.sharepoint.com/sites/<site>', type: 'choose' },
        { field: 'List Name', value: 'InboxMails', type: 'choose' },
        { field: 'Title', value: "concat('[Teams] ', coalesce(body('GetMessage')?['from']?['user']?['displayName'], '(不明)'))", type: 'expression', hint: 'SP 必須列。' },
        { field: 'Subject', value: "concat('[Teams] ', coalesce(body('GetMessage')?['from']?['user']?['displayName'], '(不明)'), ': ', substring(coalesce(body('GetMessage')?['body']?['plainTextContent'], ''), 0, min(60, length(coalesce(body('GetMessage')?['body']?['plainTextContent'], '')))))", type: 'expression', hint: '冒頭 60 字。plainTextContent が null の返信があるので coalesce() 必須。' },
        { field: 'BodyHtml', value: "body('GetMessage')?['body']?['content']", type: 'expression', hint: 'GetMessage の動的コンテンツ「Content」でも可。Spira が isHtml=true で取り込む。' },
        { field: 'BodyText', value: "coalesce(body('GetMessage')?['body']?['plainTextContent'], '')", type: 'expression' },
        { field: 'FromName', value: "body('GetMessage')?['from']?['user']?['displayName']", type: 'expression', hint: '動的コンテンツ「Display name」でも可。' },
        { field: 'FromEmail', value: "''", type: 'expression', hint: 'Teams から email は直接取れない (Graph API なし)。空文字を入れておけば Spira 側で fromName から AD ルックアップして補完される。' },
        { field: 'ReceivedAt', value: "body('GetMessage')?['createdDateTime']", type: 'expression', hint: '動的コンテンツ「Created date time」でも可。' },
        { field: 'SentAt', value: "body('GetMessage')?['createdDateTime']", type: 'expression' },
        { field: 'ConversationId', value: "concat('teams-', body('GetMessage')?['replyToId'])", type: 'expression', hint: '★ 必須。"teams-" プレフィクス + 親メッセージ ID。Spira はこの値で auto-link する。トリガー側の `replyToMessageId` を使っても同じ値が取れる。' },
        { field: 'InternetMessageId', value: "body('GetMessage')?['id']", type: 'expression', hint: '重複防止用。Teams メッセージ ID。同 ID が既存なら Spira 側で skip する。' },
        { field: 'HasAttachments', value: 'false', type: 'static' },
        { field: 'IsProcessed', value: 'false', type: 'static' },
        { field: 'IsHidden', value: 'false', type: 'static' },
      ],
    }),

    el('div', {
      style: 'background:var(--bg-soft);border-left:3px solid var(--accent);padding:var(--s-2) var(--s-3);margin:var(--s-2) 0;border-radius:4px;font-size:var(--fs-sm);line-height:1.7;color:var(--ink)',
    }, [
      el('strong', {}, ['★ なぜ GetMessage を先にやって Compose で長さ計算するのか']),
      el('br', {}),
      '統合トリガー (When a new message is added to a chat or channel) は内部的に Microsoft Graph の変更通知を受け取っているため、',
      el('strong', {}, ['本文・差出人・日時を含まないメタデータだけ']),
      ' が来る。実際のトリガー出力 JSON 例:',
      el('pre', { style: 'background:#fff;padding:8px;border-radius:4px;margin:6px 0;font-size:11px;overflow-x:auto;border:1px solid var(--border)' }, [
        `{
  "body": {
    "value": [{
      "subscriptionId": "...",
      "changeType": "created",
      "resourceData": { "id": "...", "@odata.type": "#Microsoft.Graph.chatMessage" },
      "tenantId": "...",
      "teamId": "...",
      "channelId": "19:...@thread.tacv2",
      "messageId": "1779184403531",
      "replyToMessageId": "1779179591244"
    }]
  }
}`
      ]),
      '本文を見るには「メッセージ詳細を取得する」で Graph に再問い合わせが必要 (Teams 標準コネクタの無料アクション)。GetMessage 後は次の構造になる:',
      el('pre', { style: 'background:#fff;padding:8px;border-radius:4px;margin:6px 0;font-size:11px;overflow-x:auto;border:1px solid var(--border)' }, [
        `body('GetMessage') = {
  "id": "1779184403531",
  "replyToId": "1779179591244",
  "messageType": "message",
  "createdDateTime": "2026-05-19T09:53:23Z",
  "from": { "user": { "displayName": "...", "userIdentityType": "aadUser" } },
  "body": { "contentType": "html", "content": "<p>test</p>", "plainTextContent": "test" }
}`
      ]),
      el('strong', {}, ['なぜこの順か:']),
      ' GetMessage を先にやると条件・SP書き込み両方で `body(\'GetMessage\')?[...]` の動的コンテンツが使え、トリガー出力 (`body/value/0/...`) を辿る必要がなくなる。さらに長さ計算を Compose に逃がせば、新デザイナーの条件アクションが嫌う `length()` `coalesce()` 直書きを回避できる。',
      el('br', {}),
      el('br', {}),
      el('strong', {}, ['★ fx タブの使い方']),
      el('br', {}),
      '各入力欄クリック → 右ペイン「式 (fx)」タブ → 入力欄に式を貼って「追加」。',
      el('br', {}),
      '・GetMessage の値: ', code("body('GetMessage')?['from']?['user']?['displayName']"), ' のように `body(\'アクション名\')` で参照',
      el('br', {}),
      '・動的コンテンツに「Display name」「Content」「Created date time」「Reply to id」「User identity type」等が出ていればクリックでも可',
      el('br', {}),
      '・トリガー入力 (`triggerOutputs()`) は GetMessage の入力に使うだけ、後段ではほぼ使わない',
      el('br', {}),
      el('br', {}),
      el('strong', {}, ['実出力を確認したいとき:']),
      ' フローを一度実行 → 実行履歴 → 各 STEP の「未加工出力の表示」で JSON 構造を目視確認 → 環境差があれば式の `body/...` 部分を実物に合わせて差し替え。',
    ]),

    h('3. 動作確認'),
    ol([
      el('div', {}, ['Spira でチケット起票 → 「🏢 内部スレッド起票」or 「👥 外部スレッド起票」をクリック']),
      el('div', {}, ['対象 Teams チャネル に親メッセージが投稿される']),
      el('div', {}, ['そのメッセージへ ', el('strong', {}, ['返信']), ' を投稿']),
      el('div', {}, ['1〜3 分以内に Spira 側のチケット詳細スレッドに返信内容が反映される']),
      el('div', {}, ['受信一覧には Teams バッジ付きの行が一瞬出るが、自動紐付け後に消える (auto-link 成功)']),
    ]),

    h('4. トラブルシューティング'),
    el('ul', { style: 'margin:0;padding-left:1.2em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)' }, [
      el('li', {}, [
        el('strong', {}, ['受信一覧に Teams バッジ付き行が残る']),
        ': その返信は ',
        el('em', {}, ['チケット紐付け先が見つからなかった']),
        '。原因は (a) PA フロー②でまだ起票してないチケットへの返信、(b) チケット側に InternalThreadId / UserThreadId が未保存、(c) 何かの理由で ID が不一致。手動で「既存に紐付け」可能。',
      ]),
      el('li', {}, [
        el('strong', {}, ['同じ返信が複数同期される']),
        ': PA フロー側で ',
        code('InternetMessageId'),
        ' に Teams の `messageId` を入れているか確認。Spira 側は同 ID の Comments が既にあれば skip するので、ここが空だと重複の原因に。',
      ]),
      el('li', {}, [
        el('strong', {}, ['ReplyLen (Compose) が常に 0 になる → 全て除外される']),
        ': GetMessage の出力に `replyToId` が無い可能性。実行履歴 → GetMessage →「未加工出力の表示」で `body.replyToId` に値が入っているか確認。トリガー側は `replyToMessageId` (長い名前) だが GetMessage 側は `replyToId` (短い) なので混同注意。',
      ]),
      el('li', {}, [
        el('strong', {}, ['Spira からの自動投稿 (PA フロー②) が自分自身を起こす']),
        ': フロー②の投稿は「親メッセージ」なので ReplyLen = 0 → 条件 No ブランチ送りで無視されるはず。さらに STEP 4 行 2 で `userIdentityType = aadUser` を強制しているので Bot 投稿も除外される。',
      ]),
      el('li', {}, [
        el('strong', {}, ['条件で「the template function "length" is not defined or not valid」エラー']),
        ': 新デザイナーの条件アクションは内部で使える関数が制限されており、条件式に ',
        code('length()'),
        '・', code('empty()'),
        '・', code('coalesce()'),
        ' などを直接書くとこのエラーになる。本ヘルプの構成どおり、長さ計算は STEP 3 の Compose に逃がし、条件は単純な数値比較 ',
        code('ReplyLen > 0'),
        ' にしておくこと。',
      ]),
      el('li', {}, [
        el('strong', {}, ['条件の値 2 を空欄にすると評価エラー']),
        ': 新デザイナーは「次の値に等しい / 異なる」で値 2 を空欄のままにすると評価不能になる。本ヘルプは長さ比較 (',
        code('> 0'),
        ') を採用しているのでこの罠を踏まない。`null` 比較で書きたい場合は値 2 を fx タブで ',
        code('null'),
        ' (クォート無し) と入れる。',
      ]),
      el('li', {}, [
        el('strong', {}, ['GetMessage アクションがエラーで失敗する']),
        ': 「Parent message id (親メッセージ ID)」を空のままにしていないか確認。返信を取得するときは ',
        code("triggerOutputs()?['body/value']?[0]?['replyToMessageId']"),
        ' を必ず入れる。親メッセージのときはこの値が空で GetMessage がエラー → フロー終了 (取り込みされない、これは正常動作)。',
      ]),
      el('li', {}, [
        el('strong', {}, ['動的コンテンツに GetMessage の Display name や Content が出ない']),
        ': GetMessage アクションを保存してフロー全体を一度保存し直すと候補が出てくる。それでも出ない場合は fx タブで ',
        code("body('GetMessage')?['from']?['user']?['displayName']"),
        ' のように直書き (アクション名は STEP 2 で設定したリネーム後の名前を使う)。',
      ]),
      el('li', {}, [
        el('strong', {}, ['requestBody/channels は操作スキーマに存在しません系のスキーマ警告']),
        ': fx タブで ',
        code("triggerOutputs()?['body/value']?[0]?['...']"),
        ' を書くと新デザイナーの静的バリデータが警告を出すが、実行時は通る。警告は無視して保存実行で OK。',
      ]),
      el('li', {}, [
        el('strong', {}, ['チャネル選択で「利用できるコンテンツはありません」と出る']),
        ': チーム選択を一度別に切り替えて戻す → ページ再読み込み → それでもダメなら ',
        el('strong', {}, ['fx タブ']),
        ' で Spira 設定 → Teams チャネル設定 の channelId (',
        code("'19:xxx@thread.tacv2'"),
        ') を直接貼り付け。シングルクォート必須。',
      ]),
      el('li', {}, [
        el('strong', {}, ["InvalidTemplate: length / substring parameter to be ... 'Null'"]),
        ': Teams の返信に ',
        code('plainTextContent'),
        ' が null のもの (画像/絵文字/添付のみの返信など) があるとこのエラーになる。',
        el('br', {}),
        '上の Subject / BodyText 例のように ',
        code("coalesce(triggerOutputs()?['body/body/plainTextContent'], '')"),
        ' で空文字フォールバックを噛ませること。',
        el('br', {}),
        '※ SP 側で BodyText 列を「必須」にしている場合も Null で 400 になるので、',
        code('coalesce'),
        ' か既定値のどちらかで必ず非 null にする。',
      ]),
    ]),
  ]);

  // 組み立て — 4 セクションをトグルで配置
  // ============================================================
  const flow1 = el('div', {}, [prereq, trigger, action, verify, trouble]);

  const body = el('div', {
    style: 'max-width:920px;line-height:1.7',
  }, [
    intro,
    toggle('① メール取り込み', '(必須) Outlook → InboxMails', [flow1], true),
    toggle('② Teams スレッド作成', '(任意) チケット起票 → Teams 投稿 + DeepLink', [teamsFlow], false),
    toggle('③ Microsoft Forms 取り込み', '(任意) Forms 応答 → InboxMails', [formsFlow], false),
    toggle('④ Teams 返信同期', '(任意) チャネル返信 → InboxMails (自動でチケットに紐付け)', [teamsSyncFlow], false),
  ]);

  return body;
}

/** PA フロー作成手順の HTMLElement を返す (aboutModal / 旧 openHelpModal が利用)。 */
export function buildPaFlowsHelpBody(root: HTMLElement): HTMLElement {
  return buildPaFlowsBodyImpl(root);
}

function openHelpModal(root: HTMLElement): void {
  const body = buildPaFlowsBodyImpl(root);
  openModal(root, {
    title: 'ヘルプ — Power Automate フロー作成手順',
    body,
    size: 'xl',
    primaryLabel: '閉じる',
    hideCancel: true,
  });
}

export function openResetConfirmModal(root: HTMLElement): void { onResetLists(root); }
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

  const item = (label: string, view: 'tickets' | 'inbox' | 'trash' | 'dashboard' | 'help', iconName: string, count?: number) => {
    const isActive = s.view === view;
    const node = el('div', {
      class: `spira-side-item${isActive ? ' active' : ''}`,
      'data-side-item': view,                // silent 自動同期がバッジを直接書き換える際の目印
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

  // Tickets グループ見出しの右に虫眼鏡アイコン (検索モーダルを開く)。
  // Cmd/Ctrl+K でも開ける。
  const searchIconBtn = el('button', {
    type: 'button',
    class: 'spira-side-search-icon',
    'aria-label': '検索 (⌘K / Ctrl+K)',
    title: '検索 (⌘K / Ctrl+K)',
    onclick: () => openSearchModal(),
    style:
      'margin-left:auto;display:inline-flex;align-items:center;justify-content:center;' +
      'width:22px;height:22px;border:0;background:transparent;color:var(--ink-3);' +
      'border-radius:var(--r-2);cursor:pointer;padding:0',
    html: icon('search'),
  });

  return el('aside', { class: 'spira-side', 'aria-label': 'サイドバー' }, [
    el('div', { class: 'spira-side-group' }, [
      el('div', {
        class: 'spira-side-group-title',
        style: 'display:flex;align-items:center',
      }, [
        el('span', { style: 'flex:1' }, ['Tickets']),
        searchIconBtn,
      ]),
      item('ダッシュボード', 'dashboard', 'sparkles'),
      item('チケット一覧', 'tickets', 'list'),
      item('受信', 'inbox', 'inbox', s.inboxCount),
    ]),
    el('div', { class: 'spira-side-group' }, [
      el('div', { class: 'spira-side-group-title' }, ['その他']),
      item('ヘルプ', 'help', 'help'),
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
      // アプリ全体を閉じる (overlay を DOM から remove)。topbar の × と同じ動作。
      el('button', {
        class: 'spira-btn spira-btn--ghost',
        style: 'width:100%;margin-top:var(--s-2);color:var(--ink-3)',
        title: 'Spira を閉じる',
        onclick: () => {
          const r = document.querySelector<HTMLElement>('#spira-root');
          r?.remove();
          // bookmarklet の再注入用フラグもリセット
          (window as unknown as { __SPIRA_MOUNTED__?: boolean }).__SPIRA_MOUNTED__ = false;
        },
      }, [
        el('span', { html: icon('x'), style: 'display:inline-flex;width:14px;height:14px' }),
        'アプリを閉じる',
      ]),
    ]),
  ]);
}
