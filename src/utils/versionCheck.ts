// バージョン管理。
//
// Spira は bookmarklet として配布されるため、ユーザーが古い bookmarklet
// を持ち続けるとバグ修正が伝わらない。SpiraSettings に「最新バージョン」
// と「更新先 URL」を登録しておき、起動時に現在のビルドと比較して、
// 古ければバナーで更新を促す。
//
// 最新バージョンの設定は dev / 管理者が新版公開時に手動で更新する想定
// (設定モーダルから登録)。

import { getRepo } from '../api/repo';

const KEY_LATEST = 'app:latest-build-id';
const KEY_UPDATE_URL = 'app:update-url';

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateUrl: string | null;
}

/** 現在ロードされている bookmarklet のビルド ID。
 *  esbuild の define で文字列リテラルに展開される。 */
export function currentBuildId(): string {
  return typeof __SPIRA_BUILD_ID__ === 'string' ? __SPIRA_BUILD_ID__ : '(unknown)';
}

export async function loadVersionInfo(): Promise<VersionInfo> {
  let latest: string | null = null;
  let updateUrl: string | null = null;
  try {
    [latest, updateUrl] = await Promise.all([
      getRepo().getSetting(KEY_LATEST),
      getRepo().getSetting(KEY_UPDATE_URL),
    ]);
  } catch { /* ignore */ }
  return { current: currentBuildId(), latest, updateUrl };
}

export async function saveLatestBuildId(id: string | null): Promise<void> {
  await getRepo().setSetting(KEY_LATEST, id);
}

export async function saveUpdateUrl(url: string | null): Promise<void> {
  await getRepo().setSetting(KEY_UPDATE_URL, url);
}

/** ビルド ID 末尾の ISO 日時を抽出する。
 *  例: "0.0.1-cdf7476+ (2026-05-17T05:44:08Z)" → 1731... (ms)
 *  抽出失敗時は null。 */
function buildTimestampMs(id: string | null): number | null {
  if (!id) return null;
  const m = id.match(/\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\)/);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : null;
}

/** current が latest より新しいか。タイムスタンプ比較で判定。 */
export function isCurrentNewer(info: VersionInfo): boolean {
  const c = buildTimestampMs(info.current);
  const l = buildTimestampMs(info.latest);
  if (c == null) return false;
  if (l == null) return true; // latest が未登録 → current を登録すべき
  return c > l;
}

/** current が latest より古いか (ユーザーへ更新案内バナーを出す条件)。 */
export function isOutdated(info: VersionInfo): boolean {
  if (!info.latest) return false;
  if (info.current === info.latest) return false;
  const c = buildTimestampMs(info.current);
  const l = buildTimestampMs(info.latest);
  if (c == null || l == null) {
    // タイムスタンプ無しの旧形式 ID は厳密一致で判定
    return info.current !== info.latest;
  }
  return c < l;
}
