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
 *  シンプルに from + sent (送信日) の AND だけ。
 *  - subject: 件名はテストメール等で重複するので絞り込みキーにしない
 *  - messageid: は OWA 検索バーで動かない (Microsoft の手抜き)
 *  - sent: 受信日と違いメール固有でメンバー間ブレなし
 */
export function buildOwaSearchQuery(args: BuildOwaReplyArgs): string {
  const { comment } = args;
  const day = (comment.sentAt ?? new Date().toISOString()).slice(0, 10);

  const parts: string[] = [];
  if (comment.fromEmail) parts.push(`from:${comment.fromEmail}`);
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
