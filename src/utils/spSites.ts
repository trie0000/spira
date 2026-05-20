// SharePoint サイト選択。
//
// Spira は通常、bookmarklet が動いている SP ページの `_spPageContextInfo`
// から siteUrl を取得するが、運用上はユーザーが複数の SP サイトを
// 切り替えて使いたいケースがある。本モジュールは:
//   - ユーザーがアクセス可能な SP サイト一覧を取得する (Search API)
//   - 直近選択したサイトを localStorage に記憶する
//   - 選択サイトに Spira のリストが既に作成されているかチェックする

const STORAGE_KEY = 'spira:selected-site-url';

export interface SpSite {
  url: string;
  title: string;
}

/** ユーザーがアクセス可能な SP サイト一覧を取得。
 *  SP Search API (contentclass:STS_Site) を叩く。失敗時は空配列。 */
export async function listAccessibleSites(originUrl: string): Promise<SpSite[]> {
  // originUrl は `https://tenant.sharepoint.com` 形式 (tenant root)。
  // /_api はサイト相対だが、検索は tenant 全体を対象に投げてくれる。
  const url =
    `${originUrl}/_api/search/query?querytext='contentclass:STS_Site'` +
    `&trimduplicates=false&rowlimit=500` +
    `&selectproperties='Title,Path,SPSiteUrl'`;
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      PrimaryQueryResult?: {
        RelevantResults?: {
          Table?: {
            Rows?: Array<{ Cells: Array<{ Key: string; Value: string }> }>;
          };
        };
      };
    };
    const rows = data.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
    const out: SpSite[] = [];
    for (const row of rows) {
      const cells = new Map(row.Cells.map(c => [c.Key, c.Value]));
      const siteUrl = cells.get('SPSiteUrl') ?? cells.get('Path') ?? '';
      const title = cells.get('Title') ?? siteUrl;
      if (!siteUrl) continue;
      // ルートサイト (/) は除外しても良いが、ユーザーが選びたい場合もあるので残す
      out.push({ url: siteUrl, title });
    }
    // 重複排除 + アルファベット順
    const seen = new Set<string>();
    const dedup = out.filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });
    dedup.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    return dedup;
  } catch {
    return [];
  }
}

/** 選択された SP サイト URL を取得 (なければ null)。 */
export function getSelectedSiteUrl(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
}

/** 選択された SP サイト URL を保存。 */
export function setSelectedSiteUrl(url: string): void {
  try { localStorage.setItem(STORAGE_KEY, url); }
  catch { /* noop */ }
}

/** 指定サイトに Spira の基本リスト (Tickets) が既に存在するかチェック。
 *  存在 = 初期化済み、なし = まだ Spira を導入していないサイト。 */
export async function hasSpiraLists(siteUrl: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${siteUrl}/_api/web/lists/getbytitle('Tickets')?$select=Id`,
      { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** SP サイトの表示名 (web.Title) を REST で取得。失敗時は null。 */
export async function fetchSiteTitle(siteUrl: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${siteUrl}/_api/web?$select=Title`,
      { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } },
    );
    if (!res.ok) return null;
    const json = await res.json() as { Title?: string };
    return json.Title?.trim() || null;
  } catch {
    return null;
  }
}

/** location から現在の SP サイト URL を推定 (フォールバック用)。 */
export function detectCurrentSiteUrl(): string {
  const ctx = (window as unknown as { _spPageContextInfo?: { webAbsoluteUrl?: string } })._spPageContextInfo;
  if (ctx?.webAbsoluteUrl) return ctx.webAbsoluteUrl;
  const m = location.pathname.match(/^(\/sites\/[^/]+|\/teams\/[^/]+)/i);
  return location.origin + (m ? m[0] : '');
}
