// メール送信関連の全社共通設定。
//
// チケット管理を共有 ML (= 問い合わせ受付窓口) 経由で運用する場合、返信
// メール作成時に常に決まった ML を「Cc」と「Reply-To」に入れたい運用が
// 多い。これを各 operator のローカルではなく Spira 全体で揃えるため、
// SpiraSettings リストに 1 件保存する形にする。
//
// 値はカンマ区切りの email 文字列 (1〜数件、通常は ML 1 件)。

import { getRepo } from '../api/repo';

const KEY_REPLY_ML = 'mail.reply-ml';

/** 設定済みの「返信用 ML」をカンマ区切り文字列で取得 (未設定なら空文字)。 */
export async function getReplyMlRaw(): Promise<string> {
  try {
    const v = await getRepo().getSetting(KEY_REPLY_ML);
    return (v ?? '').trim();
  } catch {
    return '';
  }
}

/** 設定済みの「返信用 ML」を配列で取得 (重複・空白除去済)。 */
export async function getReplyMlAddresses(): Promise<string[]> {
  const raw = await getReplyMlRaw();
  if (!raw) return [];
  return parseAddressList(raw);
}

/** 「返信用 ML」を保存。空文字 / null で削除。 */
export async function setReplyMlRaw(raw: string | null): Promise<void> {
  const v = (raw ?? '').trim();
  await getRepo().setSetting(KEY_REPLY_ML, v || null);
}

/** カンマ / セミコロン / 空白区切りのアドレス羅列を、重複除去した配列に。
 *  email として最低限ありうる形 (`@` を含む) だけ通す。 */
export function parseAddressList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[,;\s]+/)) {
    const v = tok.trim();
    if (!v) continue;
    if (!v.includes('@')) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
