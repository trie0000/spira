// HTML sanitizer — DOMPurify wrapper for received email body.
// Keeps base64 inline images, rewrites <a> to open in new tab.
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'a', 'b', 'i', 'em', 'strong', 'u', 'br', 'p', 'div', 'span',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img', 'hr',
  'small', 'sub', 'sup',
];

const ALLOWED_ATTR = [
  'href', 'title', 'alt', 'src', 'colspan', 'rowspan', 'style',
  'width', 'height', 'align', 'border', 'cellpadding', 'cellspacing',
];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeMailHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'style'],
  });
}

// Note-mode rendering allows our editor-specific structures: class names for
// .spira-callout / .spira-todo styling, plus a disabled checkbox for todo
// display. Used for the read-only render in renderNoteCard's view mode.
const NOTE_ALLOWED_TAGS = [...ALLOWED_TAGS, 'input', 's', 'del'];
const NOTE_ALLOWED_ATTR = [...ALLOWED_ATTR, 'class', 'type', 'checked', 'disabled'];

export function sanitizeNoteHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: NOTE_ALLOWED_TAGS,
    ALLOWED_ATTR: NOTE_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'button', 'meta', 'link', 'style'],
  });
}

/** Render a mail body into a host element using whichever of bodyHtml /
 *  bodyText is most useful.
 *
 *  PA's Office 365 Outlook connector hands plain-text mails to us as
 *  "HTML" that's actually just escaped text with literal `\n` line
 *  breaks (no `<br>` / `<p>`). innerHTML then collapses those newlines
 *  to whitespace and the body renders as one long unreadable line.
 *
 *  This helper detects that case (HTML body without any block-level
 *  tags) and rewrites `\n` to `<br>` before sanitization, so the
 *  user-perceived line breaks survive. Genuine HTML bodies (with
 *  `<p>` / `<br>` / `<div>` / `<table>` / etc.) are sanitized as-is.
 *
 *  Falls back to `<pre>`-style rendering of bodyText when bodyHtml is
 *  absent or empty.
 */
const HTML_BLOCK_RE = /<(br|p|div|table|tr|td|th|li|ul|ol|h[1-6]|blockquote|pre|hr|section|article)\b/i;

export function renderMailBody(
  el: HTMLElement,
  bodyHtml: string | null | undefined,
  bodyText: string | null | undefined,
): void {
  const html = (bodyHtml ?? '').trim();
  if (html) {
    const looksPlain = !HTML_BLOCK_RE.test(html);
    const prepared = looksPlain ? html.replace(/\r?\n/g, '<br>') : html;
    el.innerHTML = sanitizeMailHtml(prepared);
    return;
  }
  const text = bodyText ?? '';
  if (text) {
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = text;
    return;
  }
  el.textContent = '(本文なし)';
}
