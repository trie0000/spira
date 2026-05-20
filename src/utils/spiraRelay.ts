// Spira ローカル中継 (spira-ai-relay.ps1 / spira-relay.ps1) への HTTP クライアント。
//
// AI 中継 (Azure OpenAI 互換 forwarding) と同じ常駐サーバの上に、Outlook
// クライアントを操作する 2 つのローカル エンドポイントを乗せている:
//   POST /spira/outlook/reply  — 既存メールへの正規 Reply 下書きを開く
//   POST /spira/outlook/new    — 新規メール下書きを開く (テンプレ件名・本文・宛先)
//
// ベース URL:
//   - AI 設定の「ベース URL」(getCorpAiBaseUrl) の loopback origin を再利用。
//   - AI 未設定なら http://127.0.0.1:18080 を既定。
//
// 全関数は副作用無し / 例外を投げない設計 (呼び出し側が errorCode を見て
// UI フィードバックを出す)。

import { getCorpAiBaseUrl } from '../api/aiSettings';

const DEFAULT_RELAY_ORIGIN = 'http://127.0.0.1:18080';

/** AI 設定のベース URL から origin (scheme + host + port) だけを抽出。
 *  失敗時 / 未設定時はデフォルト loopback を返す。 */
export function getRelayOrigin(): string {
  const ai = getCorpAiBaseUrl();
  if (ai) {
    try {
      const u = new URL(ai);
      // loopback 系のみ relay とみなす。
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        return `${u.protocol}//${u.host}`;
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_RELAY_ORIGIN;
}

/** relay が起動しているかどうかの軽量ヘルス確認 (タイムアウト 1 秒)。 */
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

export type RelayErrorCode =
  | 'relay-unreachable'
  | 'message-not-found'
  | 'outlook-not-running'
  | 'bad-request'
  | 'other';

export interface RelayResult {
  ok: boolean;
  error?: string;
  errorCode?: RelayErrorCode;
}

/** /spira/outlook/reply: 既存メールへの正規 Reply 下書きを Outlook で開く。
 *
 *  メール検索キーは「送信時刻 (sentAtIso) + 送信者 (fromEmail)」の組み合わせ。
 *  Outlook の MAPI も Spira の sentAt も秒精度で揃うので完全一致で照合。
 *  InternetMessageId は不要。 */
export async function openOutlookReplyDraft(input: {
  /** 元メールの送信時刻 (ISO 8601 文字列)。 */
  sentAtIso: string;
  /** 元メールの送信者メールアドレス (= 申請者の email)。 */
  fromEmail: string;
  /** 返信本文 (HTML)。Outlook の引用部分の上に prepend される。 */
  bodyHtml: string;
  /** 追加 Cc アドレス (任意)。元メールから引き継いだ Cc に追記される。 */
  cc?: string[];
  /** Reply-To として下書きにセットする ML アドレス (任意、複数可)。
   *  relay 側で MailItem.ReplyRecipientNames に '; ' 区切りで入れる。 */
  replyTo?: string[];
}): Promise<RelayResult> {
  const url = `${getRelayOrigin()}/spira/outlook/reply`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentAtIso: input.sentAtIso,
        fromEmail: input.fromEmail,
        bodyHtml: input.bodyHtml,
        cc: input.cc ?? [],
        replyTo: input.replyTo ?? [],
      }),
    });
  } catch {
    return {
      ok: false,
      errorCode: 'relay-unreachable',
      error: `ローカル中継 (${getRelayOrigin()}) に接続できません。spira-ai-relay.ps1 が起動しているか確認してください。`,
    };
  }
  if (res.ok) return { ok: true };
  return classifyError(res);
}

/** /spira/outlook/new: 新規メール下書きを Outlook で開く。
 *
 *  外部対応経緯にメール source の履歴が無いチケット (= Forms / 手動起票) で、
 *  申請者に「新規問い合わせ回答メール」として送るときに使う。
 *  In-Reply-To ヘッダは付かない (新規メール扱い) が、件名にチケット ID
 *  タグを入れておけば次の返信で PA フロー① に拾われて auto-link する。 */
export async function openOutlookNewDraft(input: {
  /** 宛先 To (必須)。 */
  to: string;
  /** 件名 (必須)。チケット ID タグを含むテンプレ済み文字列を渡す想定。 */
  subject: string;
  /** 本文 (HTML)。テンプレ回答文をある程度書いた状態で渡す。 */
  bodyHtml: string;
  /** Cc (任意)。 */
  cc?: string[];
  /** Reply-To として下書きにセットする ML アドレス (任意、複数可)。 */
  replyTo?: string[];
}): Promise<RelayResult> {
  const url = `${getRelayOrigin()}/spira/outlook/new`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: input.to,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        cc: input.cc ?? [],
        replyTo: input.replyTo ?? [],
      }),
    });
  } catch {
    return {
      ok: false,
      errorCode: 'relay-unreachable',
      error: `ローカル中継 (${getRelayOrigin()}) に接続できません。spira-ai-relay.ps1 が起動しているか確認してください。`,
    };
  }
  if (res.ok) return { ok: true };
  return classifyError(res);
}

async function classifyError(res: Response): Promise<RelayResult> {
  let body: { error?: { code?: string; detail?: string } } = {};
  try { body = await res.json(); } catch { /* ignore */ }
  const code = (body.error?.code ?? '').toLowerCase();
  const detail = body.error?.detail ?? `HTTP ${res.status}`;
  let errorCode: RelayErrorCode = 'other';
  if (code === 'message_not_found' || /not.?found/.test(detail)) {
    errorCode = 'message-not-found';
  } else if (code === 'outlook_not_available' || /outlook/i.test(detail)) {
    errorCode = 'outlook-not-running';
  } else if (res.status === 400) {
    errorCode = 'bad-request';
  }
  return { ok: false, errorCode, error: detail };
}
