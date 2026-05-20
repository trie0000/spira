// Forms 連携設定。フォーム 1 件前提で、回答一覧 (Analysis) ページの URL を
// SpiraSettings に保存する。チケット詳細で source='forms' のときに
// 「📋 Forms 回答一覧を開く」リンクとして表示される。

import { getRepo } from '../api/repo';

const KEY = 'forms.analytics.url';

/** 保存されている回答一覧 URL を取得。未設定なら null。 */
export async function getFormsAnalyticsUrl(): Promise<string | null> {
  try {
    const v = await getRepo().getSetting(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 回答一覧 URL を保存。空文字 / null で削除。 */
export async function setFormsAnalyticsUrl(url: string | null): Promise<void> {
  const v = (url ?? '').trim();
  await getRepo().setSetting(KEY, v || null);
}

/** URL から Form ID を抽出 (`id=<...>` クエリ)。失敗時は null。
 *  Forms 管理画面 / 分析ページ / 共有ページ等の URL パターンに対応。 */
export function extractFormId(url: string): string | null {
  if (!url) return null;
  // 1) URL オブジェクトでパース (絶対 URL)
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get('id');
    if (fromQuery) return fromQuery;
    // fragment 内に FormId が入るパターン (DesignPageV2 等)
    const m = u.hash.match(/FormId(?:=|%3D)([^&%]+)/i);
    if (m) return decodeURIComponent(m[1]!);
  } catch { /* fallthrough */ }
  // 2) 直接正規表現フォールバック
  const m = url.match(/[?&]id=([^&#]+)/);
  if (m) return m[1]!;
  return null;
}

/** AnalysisPage 形式の URL に整形。未パース時はそのまま返す。 */
export function normalizeAnalyticsUrl(url: string): string {
  const formId = extractFormId(url);
  if (!formId) return url;
  return `https://forms.office.com/Pages/AnalysisPage.aspx?id=${formId}`;
}
