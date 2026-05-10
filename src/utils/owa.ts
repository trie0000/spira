// OWA helpers — open Outlook on the Web in a state useful for replying.
//
// 設計方針:
// 1. compose deeplink (新規メール) はスレッドが切れるので使わない
// 2. 代わりに OWA の検索画面を「from + subject + 受信日」 で pre-filled で開く。
//    その人の受信箱に届いていれば結果に出るので、本物の Reply ボタンが押せて
//    In-Reply-To / References が正しく付いた純粋な返信になる。
import type { Ticket, Comment } from '../types';

const OWA_SEARCH = 'https://outlook.office.com/mail/search';

export interface BuildOwaReplyArgs {
  ticket: Ticket;
  comment: Comment;
}

/** Build an OWA search URL that narrows the user's mailbox to (ideally) the one email. */
export function buildOwaReplyUrl(args: BuildOwaReplyArgs): string {
  const { ticket, comment } = args;
  const tag = `[#${String(ticket.id).padStart(3, '0')}]`;

  // Subject term: prefer the canonical [#XXX] tag (works on both outbound and replies
  // that preserved the tag). If the comment is the very first untagged received mail,
  // fall back to the raw subject.
  const subjectTerm = subjectHasTag(ticket, comment) ? tag : (ticket.rawSubject ?? ticket.title);

  const day = (comment.sentAt ?? new Date().toISOString()).slice(0, 10); // YYYY-MM-DD

  // KQL terms — implicitly AND-joined.
  const q = [
    comment.fromEmail ? `from:${comment.fromEmail}` : '',
    `subject:${quoteIfNeeded(subjectTerm)}`,
    `received:${day}`,
  ].filter(Boolean).join(' ');

  return `${OWA_SEARCH}?q=${encodeURIComponent(q)}`;
}

function subjectHasTag(t: Ticket, _c: Comment): boolean {
  // We always include the tag once a ticket is created, so by definition any comment
  // whose subject we control matches. The only mail that *might* not carry the tag
  // is the first received message before ticket creation — but at this point we have
  // a ticket id, so the tag is set. Default true.
  void t;
  return true;
}

function quoteIfNeeded(s: string): string {
  // KQL needs quotes around multi-word subject terms.
  if (/\s/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/** Always false now — kept for backward compatibility with the old compose-deeplink callers. */
export function bodyWouldBeTruncated(_args: BuildOwaReplyArgs): boolean {
  return false;
}
