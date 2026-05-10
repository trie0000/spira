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
 *  - `internetMessageId` (RFC 822 Message-Id) があれば `messageid:<id>` 1 条件で
 *    ピンポイント特定できる (世界で一意なので絶対に 1 件)。これを最優先で使う。
 *  - 無い場合のみ from + sent (日付) のフォールバック。日付は受信時刻 (人ごとに
 *    ブレる) ではなく送信時刻 (メール固有) を使う。
 *  - 件名は重複しがちなので検索キーとしては当てにしない。
 */
export function buildOwaSearchQuery(args: BuildOwaReplyArgs): string {
  const { comment } = args;

  // 1. Internet Message-Id があれば、それだけで一意特定できる
  if (comment.internetMessageId) {
    const id = comment.internetMessageId.replace(/^<|>$/g, ''); // 角括弧を剥がす
    return `messageid:${quoteIfNeeded(id)}`;
  }

  // 2. フォールバック: 送信元 + 送信日 (day 精度)
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
