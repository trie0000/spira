// OWA deeplink helpers — open a pre-filled draft compose in Outlook on the Web.
// NOTE: OWA's `body` query parameter is interpreted as PLAIN TEXT (not HTML).
// Quoted reply is built in classic mail-client text format with "> " prefix.
import type { Ticket, Comment } from '../types';

const OWA_COMPOSE = 'https://outlook.office.com/mail/deeplink/compose';
// URL length cap. OWA truncates somewhere around ~10K; stay conservative.
const MAX_URL_LEN = 7500;

export interface BuildOwaReplyArgs {
  ticket: Ticket;
  comment: Comment;
}

export function buildOwaReplyUrl(args: BuildOwaReplyArgs): string {
  const { ticket, comment } = args;
  const to = comment.fromEmail ?? '';
  const subject = buildReplySubject(ticket);
  const body = buildReplyBodyText(ticket, comment);
  return assembleUrl(to, subject, body);
}

function buildReplySubject(t: Ticket): string {
  const tag = `[#${String(t.id).padStart(3, '0')}]`;
  const base = (t.rawSubject ?? t.title)
    .replace(/^(RE:|Re:|RE:|FW:|Fw:|FW:)\s*/gi, '')
    .replace(/\[#\d+\]\s*/g, '')
    .trim();
  return `RE: ${tag} ${base}`;
}

function buildReplyBodyText(t: Ticket, c: Comment): string {
  const fromLine = c.fromName
    ? `${c.fromName}${c.fromEmail ? ` <${c.fromEmail}>` : ''}`
    : (c.fromEmail ?? '(unknown)');
  const subj = (t.rawSubject ?? t.title);

  const original = c.isHtml ? htmlToPlain(c.content) : c.content;
  const quoted = quoteLines(original.trim());

  // Standard mail-client quote format (Outlook / Thunderbird convention).
  const lines = [
    '',
    '',
    '',
    '-----Original Message-----',
    `From: ${fromLine}`,
    `Sent: ${c.sentAt}`,
    `Subject: ${subj}`,
    '',
    quoted,
  ];
  return lines.join('\r\n');
}

function htmlToPlain(html: string): string {
  // Drop inline images (often base64 — bloats URL).
  let s = html.replace(/<img[^>]*>/gi, '[画像]');
  // Insert newlines on block boundaries so structure survives stripping.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '- ');
  s = s.replace(/<\s*hr[^>]*>/gi, '\n----\n');
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode common HTML entities via a textarea round-trip (DOM-safe).
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    s = ta.value;
  }
  // Normalize whitespace: collapse 3+ blank lines to 2.
  s = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function quoteLines(text: string): string {
  if (!text) return '> ';
  return text.split('\n').map(line => `> ${line}`).join('\r\n');
}

function assembleUrl(to: string, subject: string, body: string): string {
  const baseUrl = `${OWA_COMPOSE}?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}`;
  const fullUrl = `${baseUrl}&body=${encodeURIComponent(body)}`;
  if (fullUrl.length <= MAX_URL_LEN) return fullUrl;
  // Body too large — try truncating quoted body and retry.
  const truncated = body.slice(0, 4000) + '\r\n\r\n...(本文が長いため以下省略)';
  const truncUrl = `${baseUrl}&body=${encodeURIComponent(truncated)}`;
  if (truncUrl.length <= MAX_URL_LEN) return truncUrl;
  return baseUrl;
}

export function bodyWouldBeTruncated(args: BuildOwaReplyArgs): boolean {
  const url = buildOwaReplyUrl(args);
  return !url.includes('&body=') || url.includes('...(本文が長いため以下省略)');
}
