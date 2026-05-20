// Spira ローカル中継 (spira-ai-relay.ps1 / spira-relay.ps1) への HTTP クライアント。
//
// AI 中継 (Azure OpenAI 互換 forwarding) と同じ常駐サーバの上に、Outlook
// クライアントの返信下書きを開く `/spira/outlook/reply` エンドポイントを
// 追加した想定。スクリプトは scripts/spira-ai-relay.ps1 を参照。
//
// ベース URL:
//   - AI 設定の「ベース URL」(getCorpAiBaseUrl) の origin を再利用する
//     (例: http://localhost:18080/myapi → http://localhost:18080)。
//   - AI 未設定なら http://127.0.0.1:18080 を既定値として使う。
//
// すべての関数は副作用無し / 例外を投げない設計 (呼び出し側で結果を見て
// フォールバック UI を出すため)。

import { getCorpAiBaseUrl } from '../api/aiSettings';

const DEFAULT_RELAY_ORIGIN = 'http://127.0.0.1:18080';

/** AI 設定のベース URL から origin (scheme + host + port) だけを抽出。
 *  失敗時 / 未設定時はデフォルト loopback を返す。 */
export function getRelayOrigin(): string {
  const ai = getCorpAiBaseUrl();
  if (ai) {
    try {
      const u = new URL(ai);
      // loopback 系のみ relay とみなす。リモート AI gateway の URL を
      // そのまま relay に流用するのは誤動作のもとなので避ける。
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        return `${u.protocol}//${u.host}`;
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_RELAY_ORIGIN;
}

/** relay が起動しているかどうかの軽量ヘルス確認 (タイムアウト 1 秒)。
 *  起動していなければ false。Spira UI 側のフォールバック判定に使う。 */
export async function pingRelay(): Promise<boolean> {
  const url = `${getRelayOrigin()}/spira/health`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface OutlookReplyInput {
  /** 元メールの RFC 822 InternetMessageId (Comments テーブルに保存済みの値)。
   *  これで Outlook 側を検索 → .Reply() で正規返信下書きを生成する。 */
  inReplyTo: string;
  /** 返信本文 (HTML)。relay 側で .HTMLBody の冒頭に prepend される。 */
  bodyHtml: string;
  /** 追加 Cc アドレス (任意)。元メールの Reply が組み立てる Cc に
   *  さらに追記される。 */
  cc?: string[];
}

export interface OutlookReplyResult {
  ok: boolean;
  /** ok=false のときのエラーメッセージ (UI 表示用)。 */
  error?: string;
  /** 詳細分類 (UI のフォールバック判定用):
   *   - 'relay-unreachable': relay が起動していない / 接続できない
   *   - 'message-not-found': InternetMessageId に一致するメールが見つからない
   *   - 'outlook-not-running': Outlook デスクトップが起動していない
   *   - 'other': その他 */
  errorCode?: 'relay-unreachable' | 'message-not-found' | 'outlook-not-running' | 'other';
}

/** Outlook デスクトップに「特定メールへの返信下書き」を開かせる。
 *  内部では localhost 中継サーバ (PowerShell) が COM 経由で
 *  Outlook.Application.GetItemFromID 相当を実行し、.Reply() → .Display()。 */
export async function openOutlookReplyDraft(
  input: OutlookReplyInput,
): Promise<OutlookReplyResult> {
  const url = `${getRelayOrigin()}/spira/outlook/reply`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inReplyTo: input.inReplyTo,
        bodyHtml: input.bodyHtml,
        cc: input.cc ?? [],
      }),
    });
  } catch (e) {
    // ネットワーク到達失敗 = relay が起動していない / ポート違い
    return {
      ok: false,
      errorCode: 'relay-unreachable',
      error: `relay に接続できません (${getRelayOrigin()})。spira-relay.ps1 が起動しているか確認してください。`,
    };
  }
  if (res.ok) return { ok: true };

  // エラー本文を読みつつ分類
  let body: { error?: { code?: string; detail?: string }; ok?: boolean } = {};
  try { body = await res.json(); } catch { /* ignore */ }
  const code = body?.error?.code ?? '';
  const detail = body?.error?.detail ?? `HTTP ${res.status}`;
  let errorCode: OutlookReplyResult['errorCode'] = 'other';
  if (/not.?found|見つかりません/i.test(code) || /not.?found|見つかりません/i.test(detail)) {
    errorCode = 'message-not-found';
  } else if (/outlook|COM/i.test(detail)) {
    errorCode = 'outlook-not-running';
  }
  return { ok: false, errorCode, error: detail };
}
