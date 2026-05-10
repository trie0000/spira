// Ticket-ID tag formatting & parsing — single source of truth.
//
// Two surfaces:
//   - SUBJECT tag: stitched into outgoing mail subject lines so PA can
//     match replies to the right ticket. Format is fixed as
//     `[<prefix>#NNNNN]`. Only the prefix (A-Za-z0-9_-, ≤ 12 chars) is
//     user-configurable from Settings; an empty prefix produces `[#NNNNN]`.
//   - UI display: shown next to ticket titles in the list / detail view.
//     Always `#NNNNN` (just the id), independent of subject format.
//
// Padding is fixed at 5 digits — the user explicitly requested it.
//
// Parsing is intentionally forgiving: `parseTicketTag` accepts any
// `[<prefix>#NNN+]` shape AND a few legacy variants (`[CASE-NNN]`,
// `(#NNN)`, `<#NNN>`) so subjects sent before the format was changed
// continue to auto-link.

export const TICKET_ID_PAD = 5;

const STORAGE_KEY = 'spira:ticketIdPrefix';
const DEFAULT_PREFIX = '';
const PREFIX_MAX = 12;
const PREFIX_RE = /^[A-Za-z0-9_-]*$/;

function pad(n: number): string {
  return String(n).padStart(TICKET_ID_PAD, '0');
}

/** Sanitize a prefix to the allowed character set, trimmed and length-capped. */
export function sanitizePrefix(input: string): string {
  const stripped = input.replace(/[^A-Za-z0-9_-]/g, '').slice(0, PREFIX_MAX);
  return stripped;
}

/** Selected prefix from localStorage. Defaults to empty string (→ `[#NNNNN]`). */
export function getTicketIdPrefix(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v != null && PREFIX_RE.test(v) && v.length <= PREFIX_MAX) return v;
  } catch { /* private mode etc. */ }
  return DEFAULT_PREFIX;
}

export function setTicketIdPrefix(prefix: string): void {
  const safe = sanitizePrefix(prefix);
  try { localStorage.setItem(STORAGE_KEY, safe); } catch { /* noop */ }
}

/** Subject tag for an outgoing mail. Honors the configured prefix. */
export function formatTicketTag(id: number): string {
  return formatTicketTagWith(id, getTicketIdPrefix());
}

/** Subject tag with a specific prefix — used by the settings preview. */
export function formatTicketTagWith(id: number, prefix: string): string {
  const safe = sanitizePrefix(prefix);
  return `[${safe}#${pad(id)}]`;
}

/** UI display form, e.g. `#00001`. Always `#` + zero-padded id. */
export function formatTicketIdShort(id: number): string {
  return `#${pad(id)}`;
}

/** Strip prefix noise from a subject string and return the "core" title.
 *  Removes (repeatedly, in any order):
 *    - Reply / forward markers: `RE:`, `Re:`, `FW:`, `Fwd:`, `返信:`, `転送:`
 *    - Any leading `[...]` bracket blocks. This covers:
 *        * Spira ticket tags (we'll re-add the current one ourselves)
 *        * Mailing-list numbers like `[ML-1234]`, `[support:5678]`, etc.
 *        * Any other vendor-injected prefix tags
 *  Anything inside `[]` past the LAST closing bracket on the leading run
 *  is preserved — only the leading prefix run is stripped. */
export function cleanSubjectCore(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim();
  // Loop because real-world subjects often stack:  `RE: [ML-1] RE: [#5] foo`
  while (true) {
    const before = s;
    s = s.replace(/^\s*(re|fw|fwd|返信|転送)\s*[:：]\s*/i, '');
    if (s.startsWith('[')) {
      const close = s.indexOf(']');
      if (close > 0) s = s.slice(close + 1).trimStart();
    }
    if (s === before) break;
  }
  return s.trim();
}

/** Subject string suitable for pasting into a fresh outgoing mail.
 *  Format: `<currentTag> <cleaned core title>` — drops any ML / reply
 *  noise from the original subject, then prepends the active Spira tag. */
export function buildCopyableSubject(id: number, rawTitleOrSubject: string | null | undefined): string {
  const core = cleanSubjectCore(rawTitleOrSubject);
  const tag = formatTicketTag(id);
  return core ? `${tag} ${core}` : tag;
}

// Primary shape: [<prefix>#NNN+]. Prefix may be empty.
const PRIMARY_RE = /\[([A-Za-z0-9_-]{0,12})#(\d+)\]/;
// Legacy fallbacks — accepted on read so subjects sent under earlier
// settings still auto-link. Order doesn't matter; first match wins.
const LEGACY_RES: RegExp[] = [
  /\[CASE-(\d+)\]/i,    // earlier "bracket-case" preset
  /\(#(\d+)\)/,          // earlier "paren-hash" preset
  /<#(\d+)>/,            // earlier "angle-hash" preset
];

/** Extract the ticket id embedded in a mail subject, or null if none. */
export function parseTicketTag(subject: string): number | null {
  const m = PRIMARY_RE.exec(subject);
  if (m) {
    const n = Number(m[2]);
    return Number.isFinite(n) ? n : null;
  }
  for (const re of LEGACY_RES) {
    const lm = re.exec(subject);
    if (lm) {
      const n = Number(lm[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
