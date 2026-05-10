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

/** Build a KQL search string usable in OWA's search bar. */
export function buildOwaSearchQuery(args: BuildOwaReplyArgs): string {
  const { ticket, comment } = args;
  const tag = `[#${String(ticket.id).padStart(3, '0')}]`;
  const day = (comment.sentAt ?? new Date().toISOString()).slice(0, 10); // YYYY-MM-DD

  const parts: string[] = [];
  if (comment.fromEmail) parts.push(`from:${comment.fromEmail}`);
  parts.push(`subject:${tag}`);
  parts.push(`received:${day}`);
  return parts.join(' ');
}

/** Best-effort URL with embedded query for envs where it does work. Kept for completeness. */
export function buildOwaReplyUrl(args: BuildOwaReplyArgs): string {
  const q = buildOwaSearchQuery(args);
  return `${OWA_INBOX_URL}?q=${encodeURIComponent(q)}`;
}

export function bodyWouldBeTruncated(_args: BuildOwaReplyArgs): boolean {
  return false;
}
