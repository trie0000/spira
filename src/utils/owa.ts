// OWA deeplink helpers — open a pre-filled draft compose in Outlook on the Web.
// Reference: https://outlook.office.com/mail/deeplink/compose?to=...&subject=...&body=...
import type { Ticket, Comment } from '../types';

const OWA_COMPOSE = 'https://outlook.office.com/mail/deeplink/compose';
// URL length cap. Edge / Chrome handle ~32K, but OWA itself silently truncates around ~10K.
const MAX_URL_LEN = 7500;

export interface BuildOwaReplyArgs {
  ticket: Ticket;
  comment: Comment;
  toName?: string;
}

/** Build an OWA compose deeplink with reply-style quoted body. Returns the URL. */
export function buildOwaReplyUrl(args: BuildOwaReplyArgs): string {
  const { ticket, comment } = args;
  const to = comment.fromEmail ?? '';
  const subject = buildReplySubject(ticket);
  const body = buildReplyBody(ticket, comment);
  return assembleUrl(to, subject, body);
}

function buildReplySubject(t: Ticket): string {
  const tag = `[#${String(t.id).padStart(3, '0')}]`;
  // Strip leading RE:/Fw: and any existing [#NNN] tag, then prepend canonical "RE: [#NNN]".
  const base = (t.rawSubject ?? t.title)
    .replace(/^(RE:|Re:|RE：|FW:|Fw:|FW：)\s*/gi, '')
    .replace(/\[#\d+\]\s*/g, '')
    .trim();
  return `RE: ${tag} ${base}`;
}

function buildReplyBody(t: Ticket, c: Comment): string {
  const fromLine = c.fromName
    ? `${c.fromName}${c.fromEmail ? ` &lt;${escapeHtml(c.fromEmail)}&gt;` : ''}`
    : (c.fromEmail ?? '(unknown)');
  const date = c.sentAt;
  const subj = (t.rawSubject ?? t.title);

  // Strip base64 inline images from the quoted body — they bloat the URL massively
  // and OWA typically truncates anyway. Replace with a placeholder.
  const sanitized = stripInlineImages(c.isHtml ? c.content : escapeHtml(c.content).replace(/\n/g, '<br>'));

  const reply = [
    '<p>&nbsp;</p>',
    '<p>&nbsp;</p>',
    '<hr>',
    `<div style="font-size:12px;color:#666"><b>差出人:</b> ${escapeHtml(fromLine)}</div>`,
    `<div style="font-size:12px;color:#666"><b>送信日時:</b> ${escapeHtml(date)}</div>`,
    `<div style="font-size:12px;color:#666"><b>件名:</b> ${escapeHtml(subj)}</div>`,
    '<br>',
    `<blockquote style="margin:0 0 0 12px;border-left:2px solid #ccc;padding-left:12px">${sanitized}</blockquote>`,
  ].join('');

  return reply;
}

function assembleUrl(to: string, subject: string, body: string): string {
  const baseUrl = `${OWA_COMPOSE}?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}`;
  // Try with body; if too long, drop body.
  const fullUrl = `${baseUrl}&body=${encodeURIComponent(body)}`;
  if (fullUrl.length <= MAX_URL_LEN) return fullUrl;
  // Body too large — omit (user will see empty draft with subject/to).
  return baseUrl;
}

function stripInlineImages(html: string): string {
  // Drop <img src="data:..."> entirely (replacing with [画像]),
  // and shorten plain <img> to a placeholder for URL-size sanity.
  return html
    .replace(/<img[^>]*src=["']data:[^"']*["'][^>]*>/gi, '[画像]')
    .replace(/<img[^>]*>/gi, '[画像]');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** True if the URL would exceed the safe OWA length when including body. */
export function bodyWouldBeTruncated(args: BuildOwaReplyArgs): boolean {
  const url = buildOwaReplyUrl(args);
  return !url.includes('&body=');
}
