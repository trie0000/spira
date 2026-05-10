// OWA helpers — open OWA + put a usable search query on the clipboard.
//
// 設計方針:
//  OWA Web の URL に `?q=...` を付けても、新しい cloud.microsoft 系では
//  検索が自動実行されない (URL に q が残るだけで search box が空)。
//  そのため検索クエリをクリップボードにコピーして、OWA を開いて
//  ユーザに ⌘/Ctrl+V → Enter してもらうフローを採る。
//  これだと差出人 + 件名 + 受信日 で確実に絞り込まれ、本物の Reply
//  ボタンを押せば In-Reply-To が付いてスレッドが維持される。
import type { Ticket, Comment } from '../types';

export const OWA_INBOX_URL = 'https://outlook.office.com/mail/';

export interface BuildOwaReplyArgs {
  ticket: Ticket;
  comment: Comment;
}

/** Build a KQL search string usable in OWA's search bar.
 *  - `received:` は受信側 (mailbox 持ち主) の到着時刻なのでメンバー毎にブレる。
 *    マルチユーザで誰が検索しても同じメールに辿り着くために `sent:` (送信日時、
 *    メールヘッダの Date) を使う。送信日時はメール自体の属性なので
 *    全員一致する。
 *  - 件名タグ [#XXX] は最初の問い合わせメールには含まれないので検索条件から除外。
 *    代わりに rawSubject (RE:/FW: と [#XXX] を除去した素の件名) を入れて
 *    返信スレッドも精度よく絞る。
 *  - OWA 検索は時刻レベルの絞り込みを公式サポートしないため day 精度。
 */
export function buildOwaSearchQuery(args: BuildOwaReplyArgs): string {
  const { ticket, comment } = args;
  const day = (comment.sentAt ?? new Date().toISOString()).slice(0, 10); // YYYY-MM-DD

  const parts: string[] = [];
  if (comment.fromEmail) parts.push(`from:${comment.fromEmail}`);

  // Subject (cleaned) で件名絞り込み
  const subjRaw = ticket.rawSubject ?? ticket.title ?? '';
  const subjClean = subjRaw
    .replace(/^(RE:|Re:|FW:|Fw:)\s*/gi, '')
    .replace(/\[#\d+\]\s*/g, '')
    .trim();
  if (subjClean) parts.push(`subject:${quoteIfNeeded(subjClean)}`);

  parts.push(`sent:${day}`);
  return parts.join(' ');
}

function quoteIfNeeded(s: string): string {
  // KQL で複数語の値を扱うときは引用符で囲む。引用符自体はエスケープ。
  if (/[\s"]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/** Best-effort URL with embedded query for envs where it does work. Kept for completeness. */
export function buildOwaReplyUrl(args: BuildOwaReplyArgs): string {
  const q = buildOwaSearchQuery(args);
  return `${OWA_INBOX_URL}?q=${encodeURIComponent(q)}`;
}

export function bodyWouldBeTruncated(_args: BuildOwaReplyArgs): boolean {
  return false;
}
