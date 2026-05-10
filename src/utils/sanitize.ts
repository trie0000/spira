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
