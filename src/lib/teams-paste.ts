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

// 時刻ヘッダの検出。Teams は locale / バージョンによって複数フォーマットを
// 出すため、できるだけ広く受け入れる:
//   - 24h:  "13:49" / "13:49:05"
//   - 12h:  "1:49 PM" / "1:49 午後" / "午後 1:49" (Teams JP 12h 設定)
//   - JP 専用: "13時49分" / "13時49分05秒"
//   - 末尾の "編集済み" / "Edited" 等のタグ付き: "13:49 編集済み"
// 後方互換のため厳格マッチは TIME_STRICT_RE で、緩いマッチは TIME_LOOSE_RE。
const TIME_STRICT_RE = /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}時\d{1,2}分(?:\d{1,2}秒)?)$/;
const TIME_AMPM_RE = /^(?:午前|午後|AM|PM|A\.?M\.?|P\.?M\.?)\s*\d{1,2}:\d{2}(?::\d{2})?$|^\d{1,2}:\d{2}(?::\d{2})?\s*(?:午前|午後|AM|PM|A\.?M\.?|P\.?M\.?)$/i;
const TIME_RE = new RegExp(`${TIME_STRICT_RE.source.slice(1, -1)}|${TIME_AMPM_RE.source.slice(1, -1)}`);

const META_RE = /^.+、.+ が作成$/;
// ヘッダ周辺に現れる非本文行を弾く。日付ピル (今日 / 昨日 / Today / Yesterday /
// "MM/DD" / "May 19" 等) もここで吸収して header pair の検出を妨げないようにする。
const NOISE_RE = /^(コンテキスト メニューあり|リアクション.*|返信|編集済み|Edited|その他のアクション|.+ が作成|今日|昨日|今週|先週|Today|Yesterday|This week|Last week|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2}|[A-Z][a-z]+ \d{1,2}(?:, \d{4})?)$/;

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
    // 隣接 2 行ペアを優先 (旧仕様 / Teams JP の典型形)。
    const b = lines[i + 1]!;
    if (TIME_RE.test(a) && isSenderLine(b)) {
      headers.push({ idx: i, time: a, sender: b });
      i++;
      continue;
    }
    if (isSenderLine(a) && TIME_RE.test(b)) {
      headers.push({ idx: i, time: b, sender: a });
      i++;
      continue;
    }
    // 空行 / 日付ピルが間に挟まる Teams バージョン (例: 送信者 → 空 → 時刻)
    // にも対応。最大 2 行先まで遡って組み合わせを試す。
    const c = lines[i + 2] ?? '';
    if (TIME_RE.test(a) && (!b || NOISE_RE.test(b)) && isSenderLine(c)) {
      headers.push({ idx: i, time: a, sender: c });
      i += 2;
      continue;
    }
    if (isSenderLine(a) && (!b || NOISE_RE.test(b)) && TIME_RE.test(c)) {
      headers.push({ idx: i, time: c, sender: a });
      i += 2;
      continue;
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
  // 24h HH:MM
  const hhmmOnly = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hhmmOnly) {
    const d = new Date(baseDate);
    d.setHours(Number(hhmmOnly[1]), Number(hhmmOnly[2]), Number(hhmmOnly[3] ?? '0') + seq, 0);
    return d.toISOString();
  }
  // JP: "13時49分" / "13時49分05秒"
  const jp = time.match(/^(\d{1,2})時(\d{1,2})分(?:(\d{1,2})秒)?$/);
  if (jp) {
    const d = new Date(baseDate);
    d.setHours(Number(jp[1]), Number(jp[2]), Number(jp[3] ?? '0') + seq, 0);
    return d.toISOString();
  }
  // 12h with AM/PM (English / 日本語): "1:49 PM" / "午後 1:49" / "1:49 午後"
  const ampm = time.match(/^(?:(午前|午後|AM|PM|A\.?M\.?|P\.?M\.?)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(午前|午後|AM|PM|A\.?M\.?|P\.?M\.?))?$/i);
  if (ampm) {
    const marker = (ampm[1] ?? ampm[5] ?? '').toUpperCase();
    let h = Number(ampm[2]);
    const m = Number(ampm[3]);
    const s = Number(ampm[4] ?? '0');
    const isPm = /^(P\.?M\.?|午後)$/i.test(marker);
    const isAm = /^(A\.?M\.?|午前)$/i.test(marker);
    if (isPm && h < 12) h += 12;
    else if (isAm && h === 12) h = 0;
    const d = new Date(baseDate);
    d.setHours(h, m, s + seq, 0);
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
