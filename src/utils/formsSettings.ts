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

/** Forms の認可された host 一覧。テナント環境によって新ドメイン
 *  forms.cloud.microsoft も使われるためどちらも許可する。 */
const FORMS_HOSTS = new Set<string>([
  'forms.office.com',
  'forms.cloud.microsoft',
]);

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

/** AnalysisPage 形式の URL に整形。未パース時はそのまま返す。
 *  L2: 入力 URL の origin が認可された Forms ドメイン (forms.office.com /
 *  forms.cloud.microsoft) のときはそれを保持。それ以外は forms.office.com
 *  に正規化 (旧挙動のフォールバック)。 */
export function normalizeAnalyticsUrl(url: string): string {
  const formId = extractFormId(url);
  if (!formId) return url;
  let origin = 'https://forms.office.com';
  try {
    const u = new URL(url);
    if (FORMS_HOSTS.has(u.hostname.toLowerCase())) {
      origin = `${u.protocol}//${u.hostname}`;
    }
  } catch { /* fall back to forms.office.com */ }
  return `${origin}/Pages/AnalysisPage.aspx?id=${formId}`;
}
