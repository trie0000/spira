// SharePoint サイト選択。
//
// Spira は通常、bookmarklet が動いている SP ページの `_spPageContextInfo`
// から siteUrl を取得するが、運用上はユーザーが複数の SP サイトを
// 切り替えて使いたいケースがある。本モジュールは:
//   - ユーザーがアクセス可能な SP サイト一覧を取得する (Search API)
//   - 直近選択したサイトを localStorage に記憶する
//   - 選択サイトに Spira のリストが既に作成されているかチェックする

const STORAGE_KEY = 'spira:selected-site-url';
// 過去に Spira を起動したサイトの履歴 (新しい順、最大 RECENT_LIMIT 件)。
// Search API がそのサイトを返してくれないテナントでも、ユーザーが「前回開いた
// サイト」をモーダルのリストから 1 クリックで選び直せるようにするために使う。
const RECENT_KEY = 'spira:recent-site-urls';
const RECENT_LIMIT = 8;

export interface SpSite {
  url: string;
  title: string;
}

export interface RecentSite extends SpSite {
  /** 最終利用時刻 (ISO)。ソート用。 */
  lastUsedAt: string;
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

/** 選択された SP サイト URL を保存 (+ recent 履歴にも追記)。 */
export function setSelectedSiteUrl(url: string, title?: string): void {
  try { localStorage.setItem(STORAGE_KEY, url); }
  catch { /* noop */ }
  // 同時に recent 履歴へ最新利用として記録 (重複は捨てて先頭に持ってくる)。
  // title が分かっていなければ後から fetchSiteTitle で書き戻す呼び出し側に任せる。
  pushRecentSite(url, title ?? url);
}

/** recent 履歴を取得 (新しい順)。 */
export function getRecentSites(): RecentSite[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentSite[] = [];
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue;
      const r = it as Partial<RecentSite>;
      if (!r.url) continue;
      out.push({
        url: String(r.url),
        title: String(r.title ?? r.url),
        lastUsedAt: String(r.lastUsedAt ?? ''),
      });
    }
    // 安全のため新しい順にソート
    out.sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
    return out;
  } catch { return []; }
}

/** recent 履歴に 1 件追記 (重複 url は捨てて先頭に)。 */
function pushRecentSite(url: string, title: string): void {
  try {
    const existing = getRecentSites().filter(s => s.url !== url);
    const next: RecentSite[] = [
      { url, title, lastUsedAt: new Date().toISOString() },
      ...existing,
    ].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* noop */ }
}

/** 表示用タイトルを後から更新する (起動完了後に fetchSiteTitle で取得できた
 *  ときに recent の title を上書きするための補助)。 */
export function refreshRecentSiteTitle(url: string, title: string): void {
  try {
    const list = getRecentSites();
    let changed = false;
    for (const r of list) {
      if (r.url === url && r.title !== title) { r.title = title; changed = true; }
    }
    if (changed) localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* noop */ }
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
