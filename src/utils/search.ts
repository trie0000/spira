// Search helpers — normalization, highlight extraction.
//
// Used by both the mock repo (in-memory filter) and the search view's
// UI (snippet generation + highlighting). Keeping the normalization
// rule shared ensures the displayed highlight matches the underlying
// search hit.

/** Normalize a string for case- and width-insensitive substring search.
 *  - Full-width digits / latin letters → ASCII (Japanese IME compat)
 *  - Lowercase
 *  - NFD → NFC composition (Mac filename quirk)
 *  - Strip HTML tags so comment HTML matches on visible text only */
export function normalizeForSearch(s: string): string {
  if (!s) return '';
  return s
    // Strip simple HTML tags. Good enough for matching purposes; doesn't
    // need to be a real parser.
    .replace(/<[^>]*>/g, ' ')
    // FW digit / latin → ASCII
    .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .normalize('NFC')
    .toLowerCase();
}

/** Build a short excerpt around the first match in `text` with the
 *  matched substring wrapped in `<mark>` tags. Returns plain text +
 *  the highlighted HTML. `radius` = chars of context on each side. */
export function makeSnippet(
  text: string,
  query: string,
  radius = 60,
): string {
  if (!text || !query) return '';
  const normQuery = normalizeForSearch(query);
  if (!normQuery) return text.slice(0, radius * 2);

  // Find the FIRST match in normalized space — index maps roughly to
  // the original since our normalization preserves length (FW→HW is
  // 1:1, HTML strip changes length so we strip first then search).
  const stripped = text.replace(/<[^>]*>/g, ' ');
  const normStripped = normalizeForSearch(text); // same operation
  const idx = normStripped.indexOf(normQuery);
  if (idx < 0) return stripped.slice(0, radius * 2);

  const start = Math.max(0, idx - radius);
  const end = Math.min(stripped.length, idx + normQuery.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < stripped.length ? '…' : '';
  const beforeMatch = stripped.slice(start, idx);
  const matchText = stripped.slice(idx, idx + normQuery.length);
  const afterMatch = stripped.slice(idx + normQuery.length, end);
  // Escape HTML to prevent XSS, then wrap match in <mark>.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${prefix}${esc(beforeMatch)}<mark>${esc(matchText)}</mark>${esc(afterMatch)}${suffix}`;
}
