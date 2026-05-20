// SP サイト選択モーダル (Spira 起動時)。
//
// ユーザーがアクセス可能な SP サイト一覧を表示し、Spira を動作させる
// サイトを選択させる。前回選択サイトを localStorage に記憶しており、
// 2 回目以降はそれが初期選択になっている。
//
// 未初期化サイト (Spira リストが未作成) を選択した場合は確認を取る。

import { el } from '../utils/dom';
import { icon } from '../icons';
import {
  listAccessibleSites,
  getSelectedSiteUrl,
  setSelectedSiteUrl,
  getRecentSites,
  hasSpiraLists,
  detectCurrentSiteUrl,
  type SpSite,
  type RecentSite,
} from '../utils/spSites';

export interface SiteSelectionResult {
  /** 選択された SP サイト URL */
  siteUrl: string;
  /** Spira リストが既に存在するか (false なら ensureLists が必要) */
  initialized: boolean;
}

/** モーダルを開いて、ユーザーが選択した SP サイトの URL を Promise で返す。
 *  ユーザーがキャンセルした場合は null を返す (呼び出し側は Spira の起動を
 *  停止して何もせず終了する想定)。 */
export function openSiteSelectionModal(): Promise<SiteSelectionResult | null> {
  return new Promise((resolve) => {
    const current = detectCurrentSiteUrl();
    const saved = getSelectedSiteUrl();
    const tenantOrigin = (() => {
      try { return new URL(current).origin; } catch { return location.origin; }
    })();
    // 最近 Spira を起動したサイト履歴 (新しい順)。
    // Search API が返してくれないテナントでも前回サイトをワンクリックで
    // 選び直せるようリスト先頭に固定で出す。
    const recents: RecentSite[] = getRecentSites();

    let selectedUrl = saved ?? current;
    let sites: SpSite[] = [];

    // モーダル要素を組み立て
    const backdrop = el('div', {
      style:
        'position:fixed;inset:0;background:rgba(0,0,0,0.5);' +
        'z-index:2147483700;display:flex;align-items:center;justify-content:center;' +
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    });

    const modal = el('div', {
      style:
        'background:#fff;color:#1f1f1f;border-radius:8px;' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.25);' +
        'min-width:520px;max-width:720px;max-height:80vh;' +
        'display:flex;flex-direction:column;overflow:hidden',
    });

    const head = el('div', {
      style: 'padding:16px 20px;border-bottom:1px solid #e5e5e5;' +
             'display:flex;align-items:center;gap:8px;font-weight:600;font-size:16px',
    }, [
      el('span', { html: icon('list'), style: 'display:inline-flex;width:18px;height:18px' }),
      'Spira を起動する SP サイトを選択',
    ]);

    const note = el('div', {
      style: 'padding:12px 20px;background:#f5f5f3;color:#555;font-size:13px;line-height:1.6;border-bottom:1px solid #e5e5e5',
    }, [
      saved
        ? `前回は ${saved} を使用しました。同じサイトで続ける場合はそのまま「決定」を押してください。`
        : 'アクセス可能な SP サイトを以下から選択してください。リスト未作成のサイトを選んだ場合は初期化の確認が表示されます。',
    ]);

    const listHost = el('div', {
      style: 'flex:1;overflow-y:auto;padding:8px 0;min-height:200px',
    });

    /** 1 行 (radio + ラベル) を組み立て。 */
    const buildRow = (site: SpSite, marker?: HTMLElement | null): HTMLElement => {
      const id = `spira-site-${Math.random().toString(36).slice(2)}`;
      const radio = el('input', {
        type: 'radio', name: 'spira-site', id, value: site.url,
        style: 'margin:0 10px 0 0;flex-shrink:0',
      }) as HTMLInputElement;
      if (site.url === selectedUrl) radio.checked = true;
      radio.addEventListener('change', () => {
        if (radio.checked) {
          selectedUrl = site.url;
          manualInput.value = '';
        }
      });
      const row = el('label', {
        for: id,
        style:
          'display:flex;align-items:center;gap:0;padding:8px 20px;' +
          'cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0',
      }, [
        radio,
        el('span', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:500;display:flex;align-items:center;flex-wrap:wrap;gap:6px' }, [
            el('span', {}, [site.title]),
            ...(marker ? [marker] : []),
            ...(site.url === current ? [
              el('span', {
                style: 'font-size:11px;color:#4a7c59;font-weight:400',
              }, ['(現在のページ)']),
            ] : []),
          ]),
          el('div', {
            style: 'color:#888;font-size:11px;font-family:ui-monospace,monospace;word-break:break-all',
          }, [site.url]),
        ]),
      ]);
      row.addEventListener('click', (e) => {
        if (e.target !== radio) radio.click();
      });
      return row;
    };

    /** セクションヘッダ。 */
    const sectionHead = (label: string): HTMLElement => el('div', {
      style:
        'padding:6px 20px;font-size:11px;color:#777;text-transform:uppercase;' +
        'letter-spacing:0.04em;font-weight:600;background:#fafafa;border-bottom:1px solid #f0f0f0',
    }, [label]);

    /** リスト全体を再描画。 recents + (取得済なら) search results をマージ表示。 */
    const renderList = (fetched: SpSite[] | null): void => {
      listHost.replaceChildren();
      const recentUrlSet = new Set(recents.map(r => r.url));

      // ── recents セクション (取得待ちでも先に出る) ──
      if (recents.length > 0) {
        listHost.appendChild(sectionHead('最近開いたサイト'));
        for (const r of recents) {
          const recentBadge = el('span', {
            style:
              'font-size:10px;color:#4a7c59;background:#e8f0ea;padding:1px 6px;' +
              'border-radius:8px;font-weight:500',
          }, ['前回']);
          // 最新 (recents[0]) 以外は「前回」バッジを付けない
          const marker = r === recents[0] ? recentBadge : null;
          listHost.appendChild(buildRow(r, marker));
        }
      }

      // ── search API セクション ──
      if (fetched === null) {
        // 取得中
        listHost.appendChild(el('div', {
          style: 'padding:16px 20px;color:#777;font-size:13px',
        }, ['アクセス可能なサイト一覧を取得中…']));
        return;
      }
      const others = fetched.filter(s => !recentUrlSet.has(s.url));
      if (recents.length > 0 && others.length > 0) {
        listHost.appendChild(sectionHead('アクセス可能なサイト'));
      }
      if (others.length === 0 && recents.length === 0) {
        listHost.appendChild(el('div', {
          style: 'padding:16px 20px;color:#777;font-size:13px;line-height:1.6',
        }, [
          'アクセス可能なサイトを検索 API から取得できませんでした。',
          el('br', {}, []),
          '下の入力欄に SP サイトの URL を直接貼り付けてください。',
        ]));
        return;
      }
      // current が含まれていれば先頭へ
      const ordered = [...others];
      const cIdx = ordered.findIndex(s => s.url === current);
      if (cIdx > 0) ordered.unshift(ordered.splice(cIdx, 1)[0]!);
      for (const site of ordered) listHost.appendChild(buildRow(site, null));
    };

    // 初期描画 (recents だけ、search 結果は取得中)
    renderList(null);

    // 手入力 URL (Search API でヒットしないテナント外サイト等の fallback)
    const manualInput = el('input', {
      type: 'url',
      placeholder: 'または URL を直接入力 (例: https://tenant.sharepoint.com/sites/xxx)',
      style:
        'width:100%;padding:8px 12px;border:1px solid #d4d4d4;border-radius:4px;' +
        'font-size:13px;font-family:ui-monospace,Menlo,monospace;box-sizing:border-box',
    }) as HTMLInputElement;
    manualInput.addEventListener('input', () => {
      const v = manualInput.value.trim();
      if (v) {
        selectedUrl = v;
        // ラジオ選択を解除
        listHost.querySelectorAll('input[type=radio]').forEach((r) => {
          (r as HTMLInputElement).checked = false;
        });
      }
    });

    const manualBox = el('div', {
      style: 'padding:12px 20px;border-top:1px solid #e5e5e5;background:#fafafa',
    }, [manualInput]);

    const errorLine = el('div', {
      style: 'padding:8px 20px;color:#c53030;font-size:13px;display:none',
    });

    const decideBtn = el('button', {
      style:
        'padding:8px 18px;background:#4a7c59;color:#fff;border:0;' +
        'border-radius:4px;cursor:pointer;font-weight:500;font-size:14px',
    }, ['決定']);
    decideBtn.addEventListener('click', async () => {
      const url = (selectedUrl || '').trim().replace(/\/+$/, '');
      if (!url) {
        errorLine.textContent = 'サイトを選択するか URL を入力してください';
        errorLine.style.display = 'block';
        return;
      }
      try {
        new URL(url);
      } catch {
        errorLine.textContent = '正しい URL 形式で入力してください';
        errorLine.style.display = 'block';
        return;
      }
      errorLine.style.display = 'none';
      decideBtn.setAttribute('disabled', '');
      decideBtn.textContent = 'チェック中…';
      const initialized = await hasSpiraLists(url);
      decideBtn.removeAttribute('disabled');
      decideBtn.textContent = '決定';

      // 未初期化サイト → 確認
      if (!initialized) {
        const ok = window.confirm(
          `このサイト (${url}) には Spira のリストがまだ作成されていません。\n\n` +
          `「OK」を押すと、Tickets / Comments / InboxMails / TeamsPostRequests / SpiraSettings リストを自動作成します。\n\n` +
          `初期化して続行しますか？`,
        );
        if (!ok) return;
      }

      // 表示用のタイトルを recent / search から拾えれば一緒に保存。
      // 見つからない場合は URL を仮タイトルにし、起動完了後に
      // fetchSiteTitle で書き戻す前提 (main.ts 側で refreshRecentSiteTitle)。
      const title =
        recents.find(r => r.url === url)?.title
        ?? sites.find(s => s.url === url)?.title
        ?? url;
      setSelectedSiteUrl(url, title);
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve({ siteUrl: url, initialized });
    });

    const cancelBtn = el('button', {
      style:
        'padding:8px 18px;background:#fff;color:#555;border:1px solid #d4d4d4;' +
        'border-radius:4px;cursor:pointer;font-size:14px',
    }, ['キャンセル']);
    const onCancel = (): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(null);
    };
    cancelBtn.addEventListener('click', onCancel);

    // Esc キーでもキャンセル可能に。背景クリックは誤操作防止のため無効。
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);

    const foot = el('div', {
      style:
        'padding:12px 20px;border-top:1px solid #e5e5e5;background:#fff;' +
        'display:flex;justify-content:flex-end;gap:8px',
    }, [cancelBtn, decideBtn]);

    modal.append(head, note, listHost, errorLine, manualBox, foot);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // サイト一覧を非同期取得 → 取れたら再描画
    void listAccessibleSites(tenantOrigin).then((fetched) => {
      sites = fetched;
      renderList(sites);
    }).catch(() => {
      renderList([]);
    });
  });
}
