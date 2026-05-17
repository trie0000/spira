// Teams chat clipboard parser.
//
// Teams desktop/web does NOT include sender info when you press Cmd+C on a
// range (its custom copy handler strips author / timestamp). However, the
// OS-level "right-click → コピー" path bypasses Teams' handler and produces
// a flat plain-text serialization of the DOM + aria-labels — which DOES
// contain sender name and timestamp for every message EXCEPT the very
// first one in the selected range. Teams renders the topmost message's
// header above the selection rectangle in the DOM (separator / "Today"
// pill region), so even starting the drag at the speaker name doesn't
// catch the header text. Callers can pass `opts.leadingAuthor` to attribute
// the orphan body to a manually-specified sender.
//
// The format observed is roughly:
//
//   <orphan body for first message — no header>
//                                         ← blank
//   13:49                                 ← HH:MM
//   trie0000                              ← sender name
//                                         ← blank
//   これはテストです。                       ← body (may span multiple lines)
//                                         ← blank
//   testが受信しました。、test test が作成     ← meta line for NEXT msg (noise)
//   test test                             ← next sender
//   13:49                                 ← next HH:MM
//                                         ← blank
//   testが受信しました。                       ← next body
//   ...
//   コンテキスト メニューあり               ← trailing UI label (noise)

export interface ParsedTeamsMessage {
  author: string;
  /** Raw time string from the clipboard, e.g. "13:49". */
  time: string;
  /** Plain-text body, may contain "\n" for multi-line messages. */
  body: string;
}

const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const META_RE = /^.+、.+ が作成$/;
const NOISE_RE = /^(コンテキスト メニューあり|リアクション.*|返信|編集済み|その他のアクション|.+ が作成)$/;

function isSenderLine(s: string): boolean {
  if (!s) return false;
  if (s.length > 50) return false;
  if (TIME_RE.test(s)) return false;
  if (META_RE.test(s)) return false;
  if (NOISE_RE.test(s)) return false;
  // Body lines often end with a sentence-terminating punctuation; treat
  // those as bodies, not senders.
  if (/[。！？!?…]$/.test(s)) return false;
  return true;
}

/** Options for `parseTeamsPaste`.
 *
 *  Teams' right-click copy reliably reproduces sender/time headers for
 *  every message *except the first one*: the topmost message's header is
 *  rendered above the selection rectangle in the DOM, so even starting
 *  the drag at the speaker name doesn't include it in the clipboard.
 *  Callers that want to recover the orphan first message can pass
 *  `leadingAuthor` (and optionally `leadingTime`) — the parser then
 *  attributes any body content appearing before the first detected
 *  header to that author. */
export interface ParseOptions {
  /** Author for any orphan body before the first detected header.
   *  When omitted, the orphan is dropped. */
  leadingAuthor?: string;
  /** Time string for the orphan message. Defaults to the first detected
   *  message's time so they sort adjacently. */
  leadingTime?: string;
}

function normalizeWhitespace(text: string): string[] {
  //   nbsp → regular space so trim() works and detection is stable.
  return text.replace(/ /g, ' ').split(/\r?\n/).map(l => l.trim());
}

function collectBody(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const l = lines[i] ?? '';
    if (META_RE.test(l)) continue;
    if (NOISE_RE.test(l)) continue;
    out.push(l);
  }
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function findHeaders(lines: string[]): { idx: number; time: string; sender: string }[] {
  const headers: { idx: number; time: string; sender: string }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (TIME_RE.test(a) && isSenderLine(b)) {
      headers.push({ idx: i, time: a, sender: b });
      i++;
    } else if (isSenderLine(a) && TIME_RE.test(b)) {
      headers.push({ idx: i, time: b, sender: a });
      i++;
    }
  }
  return headers;
}

export function parseTeamsPaste(text: string, opts: ParseOptions = {}): ParsedTeamsMessage[] {
  const lines = normalizeWhitespace(text);
  const headers = findHeaders(lines);
  const msgs: ParsedTeamsMessage[] = [];

  // Orphan body BEFORE the first detected header. Recover it when the
  // caller supplied a leading-author hint.
  const firstHeaderIdx = headers[0]?.idx ?? lines.length;
  const orphan = collectBody(lines, 0, firstHeaderIdx);
  const leader = opts.leadingAuthor?.trim();
  if (orphan && leader) {
    msgs.push({
      author: leader,
      time: opts.leadingTime?.trim() || headers[0]?.time || '',
      body: orphan,
    });
  }

  for (let k = 0; k < headers.length; k++) {
    const h = headers[k]!;
    const end = headers[k + 1]?.idx ?? lines.length;
    const body = collectBody(lines, h.idx + 2, end);
    if (body) msgs.push({ author: h.sender, time: h.time, body });
  }

  return msgs;
}

/** Inspect a paste to determine whether there's an orphan body before
 *  the first detected header. Used by the UI to nudge the user toward
 *  filling the "先頭の発言者" field. Returns the orphan body text or
 *  an empty string when nothing needs attribution. */
export function detectLeadingOrphan(text: string): string {
  const lines = normalizeWhitespace(text);
  const headers = findHeaders(lines);
  const firstHeaderIdx = headers[0]?.idx ?? lines.length;
  return collectBody(lines, 0, firstHeaderIdx);
}

/** Resolve a Teams time string ("HH:MM" or "YYYY/MM/DD HH:MM") to an
 *  ISO timestamp, anchored to `baseDate` when only a time is present.
 *
 *  Multiple messages with the same HH:MM are spread across consecutive
 *  seconds by the caller (via the `seq` parameter) so chronological
 *  sorting stays stable when several messages share the minute. */
export function resolveTeamsTimeToISO(time: string, baseDate: Date, seq = 0): string {
  const hhmmOnly = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hhmmOnly) {
    const d = new Date(baseDate);
    d.setHours(Number(hhmmOnly[1]), Number(hhmmOnly[2]), Number(hhmmOnly[3] ?? '0') + seq, 0);
    return d.toISOString();
  }
  const full = time.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (full) {
    const d = new Date(
      Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      Number(full[4]), Number(full[5]), Number(full[6] ?? '0') + seq,
    );
    return d.toISOString();
  }
  // Unparseable — fall back to baseDate + seq seconds.
  const d = new Date(baseDate);
  d.setSeconds(d.getSeconds() + seq);
  return d.toISOString();
}

/** Normalize a string for duplicate-detection comparison. Collapses all
 *  whitespace (newlines, tabs, multiple spaces, full-width spaces) into a
 *  single space and trims. Used to compare a freshly-parsed body against
 *  an existing comment's stored content. */
export function normalizeForDedup(s: string): string {
  return s.replace(/[\s　]+/g, ' ').trim();
}
