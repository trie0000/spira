// Minimal RFC 822 / RFC 2822 parser for `.eml` files dragged from Outlook
// onto the new-ticket modal. We only care about a few headers (Subject,
// From, Date) plus the first text/plain body part — enough to pre-fill the
// ticket form. We deliberately avoid a full MIME parser; Outlook for Mac
// and Outlook for Windows both emit reasonably clean .eml files for drag
// operations and the parts we need live near the top.
//
// Edge cases we handle:
//   - MIME encoded-words in headers:  =?UTF-8?B?...?= and =?UTF-8?Q?...?=
//     (Japanese subjects are commonly base64-encoded UTF-8).
//   - Header folding (continuation lines starting with space/tab).
//   - quoted-printable / base64 transfer encoding on the body.
//   - multipart/alternative — pick the first text/plain part.
//
// What we do NOT handle (out of scope for drag-prefill):
//   - Nested multipart, attachments, signed/encrypted blobs.
//   - Non-UTF-8 / non-ISO-2022-JP charsets are decoded best-effort with
//     TextDecoder; if the charset is unknown we fall back to UTF-8.

export interface ParsedEml {
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  /** ISO 8601 date string (UTC). Undefined when Date header is missing/invalid. */
  dateISO?: string;
  /** Plain-text body (decoded). Newlines normalised to \n. */
  body?: string;
}

/** Outlook for Windows のメール drag テキスト判定。
 *  Windows 版 Outlook はドラッグ時に .eml ファイルではなく、以下の形式の
 *  text/plain だけを渡してくる:
 *
 *    From: 田中太郎 <tanaka@x.com>           (or 差出人:)
 *    Sent: 2026年5月17日 10:30              (or 送信日時:)
 *    To: someone@y.com                       (or 宛先:)
 *    Subject: テストメール                   (or 件名:)
 *
 *    (本文)
 *
 *  RFC 822 (.eml) ほど厳密でなく、locale により日本語キー or 英語キー混在。
 *  「From: または 差出人:」「Subject: または 件名:」の両方が見つかれば
 *  Outlook drag と判定する。 */
export function looksLikeOutlookDrag(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 2000);
  const hasFrom = /(^|\n)\s*(From|差出人|送信者)\s*[::]\s*\S/i.test(head);
  const hasSubject = /(^|\n)\s*(Subject|件名)\s*[::]\s*\S/i.test(head);
  return hasFrom && hasSubject;
}

/** Best-effort detect: does this string look like an .eml file?
 *  Cheap and tolerant — we just look for an obvious mail header at the top. */
export function looksLikeEml(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 4096);
  return /(^|\r?\n)(Subject|From|To|Date|Message-ID|MIME-Version):/i.test(head);
}

/** Decode a MIME encoded-word `=?charset?encoding?text?=` to plain text.
 *  Handles a single token; the caller is responsible for handling whitespace
 *  between multiple consecutive encoded-words (which per RFC must be removed). */
function decodeEncodedWord(token: string): string | null {
  const m = token.match(/^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/);
  if (!m) return null;
  const charset = m[1]!.toLowerCase();
  const enc = m[2]!.toUpperCase();
  const data = m[3]!;
  try {
    let bytes: Uint8Array;
    if (enc === 'B') {
      const bin = atob(data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      // Q-encoding: '=XX' → byte, '_' → space
      const out: number[] = [];
      for (let i = 0; i < data.length; i++) {
        const ch = data.charCodeAt(i);
        if (ch === 0x5f /* _ */) { out.push(0x20); continue; }
        if (ch === 0x3d /* = */ && i + 2 < data.length) {
          const hex = data.slice(i + 1, i + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            out.push(parseInt(hex, 16));
            i += 2;
            continue;
          }
        }
        out.push(ch);
      }
      bytes = new Uint8Array(out);
    }
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decode any encoded-words in a header value. Per RFC 2047, whitespace
 *  *between* two encoded-words is ignored — that matters for Japanese
 *  subjects split across multiple `=?UTF-8?B?...?=` tokens. */
function decodeHeader(value: string): string {
  // First pass: split on encoded-word boundaries while keeping the words.
  const re = /=\?[^?]+\?[BbQq]\?[^?]*\?=/g;
  let out = '';
  let last = 0;
  let lastWasEW = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const between = value.slice(last, m.index);
    // Per RFC 2047, whitespace between encoded-words is discarded.
    if (!(lastWasEW && /^\s*$/.test(between))) out += between;
    const decoded = decodeEncodedWord(m[0]) ?? m[0];
    out += decoded;
    last = m.index + m[0].length;
    lastWasEW = true;
  }
  out += value.slice(last);
  return out;
}

/** Parse the From header into display-name and email.
 *  Accepts: `"Name" <a@b>`, `Name <a@b>`, `<a@b>`, `a@b`. */
function parseFromHeader(raw: string): { fromName?: string; fromEmail?: string } {
  const decoded = decodeHeader(raw).trim();
  const m = decoded.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1]!.trim().replace(/^"|"$/g, '').trim();
    const email = m[2]!.trim();
    return { fromName: name || undefined, fromEmail: email || undefined };
  }
  if (/^[^@\s]+@[^@\s]+$/.test(decoded)) return { fromEmail: decoded };
  return { fromName: decoded || undefined };
}

/** Parse RFC 2822 Date header → ISO 8601. Browsers' Date.parse handles
 *  RFC 2822 well enough for our use; we just normalize the output. */
function parseDateHeader(raw: string): string | undefined {
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/** Decode quoted-printable text. Used for headers and bodies. */
function decodeQuotedPrintable(s: string, charset: string): string {
  // Join soft-line-breaks first ('=' at EOL)
  const joined = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    if (ch === 0x3d /* = */ && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (ch <= 0xff) out.push(ch);
    else {
      // Already-decoded multibyte (shouldn't happen for true QP, but be safe)
      out.push(...new TextEncoder().encode(joined[i]!));
    }
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(new Uint8Array(out));
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(out));
  }
}

/** Decode base64 body. */
function decodeBase64Body(s: string, charset: string): string {
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return s;
  }
}

/** Split RFC 822 headers + body. Body may be undefined (header-only). */
function splitHeadersBody(src: string): { headerBlock: string; body: string } {
  // Normalise CRLF/CR → LF for predictable splitting, then look for blank line.
  const norm = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const idx = norm.indexOf('\n\n');
  if (idx === -1) return { headerBlock: norm, body: '' };
  return { headerBlock: norm.slice(0, idx), body: norm.slice(idx + 2) };
}

/** Parse the header block into a case-insensitive map. Folds continuation
 *  lines (lines starting with space/tab belong to the previous header). */
function parseHeaders(block: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = block.split('\n');
  let current: { name: string; value: string } | null = null;
  const flush = (): void => {
    if (!current) return;
    map.set(current.name.toLowerCase(), current.value);
    current = null;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      // continuation
      current.value += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (!m) continue;
    flush();
    current = { name: m[1]!, value: m[2]! };
  }
  flush();
  return map;
}

/** Parse Content-Type into { mediaType, params }. */
function parseContentType(raw: string | undefined): { mediaType: string; params: Record<string, string> } {
  if (!raw) return { mediaType: 'text/plain', params: {} };
  const parts = raw.split(';').map(s => s.trim());
  const mediaType = (parts.shift() ?? '').toLowerCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const m = p.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    let val = m[2]!.trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { mediaType, params };
}

/** Decode a body part given its headers + raw text. */
function decodeBody(rawBody: string, headers: Map<string, string>): string {
  const ct = parseContentType(headers.get('content-type'));
  const charset = (ct.params['charset'] || 'utf-8').toLowerCase();
  const cte = (headers.get('content-transfer-encoding') || '7bit').toLowerCase();
  if (cte === 'base64') return decodeBase64Body(rawBody, charset);
  if (cte === 'quoted-printable') return decodeQuotedPrintable(rawBody, charset);
  // 7bit / 8bit / binary — assume already a string of the right charset.
  // If charset isn't utf-8, try to re-decode by reinterpreting code units as bytes.
  if (charset !== 'utf-8' && charset !== 'us-ascii' && charset !== 'ascii') {
    try {
      const bytes = new Uint8Array(rawBody.length);
      for (let i = 0; i < rawBody.length; i++) bytes[i] = rawBody.charCodeAt(i) & 0xff;
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return rawBody;
    }
  }
  return rawBody;
}

/** Recursively find the first text/plain part in a multipart body.
 *  Returns the decoded text. */
function findTextPart(rawBody: string, ct: { mediaType: string; params: Record<string, string> }, headers: Map<string, string>): string | undefined {
  if (ct.mediaType.startsWith('multipart/')) {
    const boundary = ct.params['boundary'];
    if (!boundary) return undefined;
    const sep = '--' + boundary;
    // Split on the boundary; each part is `headers\n\nbody`.
    const parts = rawBody.split(sep);
    // First chunk is the preamble; last is the closing `--`. Iterate the middle.
    for (let i = 1; i < parts.length; i++) {
      let chunk = parts[i]!;
      if (chunk.startsWith('--')) break; // closing boundary
      // Strip leading \n after the boundary
      chunk = chunk.replace(/^\r?\n/, '');
      const { headerBlock, body: partBody } = splitHeadersBody(chunk);
      const partHeaders = parseHeaders(headerBlock);
      const partCt = parseContentType(partHeaders.get('content-type'));
      if (partCt.mediaType === 'text/plain') {
        return decodeBody(partBody.replace(/\r?\n--$/, ''), partHeaders);
      }
      if (partCt.mediaType.startsWith('multipart/')) {
        const nested = findTextPart(partBody, partCt, partHeaders);
        if (nested) return nested;
      }
    }
    // Fall back to first text/html part if no text/plain found
    for (let i = 1; i < parts.length; i++) {
      let chunk = parts[i]!;
      if (chunk.startsWith('--')) break;
      chunk = chunk.replace(/^\r?\n/, '');
      const { headerBlock, body: partBody } = splitHeadersBody(chunk);
      const partHeaders = parseHeaders(headerBlock);
      const partCt = parseContentType(partHeaders.get('content-type'));
      if (partCt.mediaType === 'text/html') {
        const html = decodeBody(partBody, partHeaders);
        // Strip tags for textarea use
        return html.replace(/<style[\s\S]*?<\/style>/gi, '')
                   .replace(/<script[\s\S]*?<\/script>/gi, '')
                   .replace(/<[^>]+>/g, '')
                   .replace(/&nbsp;/g, ' ')
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"');
      }
    }
    return undefined;
  }
  if (ct.mediaType === 'text/plain') return decodeBody(rawBody, headers);
  if (ct.mediaType === 'text/html') {
    const html = decodeBody(rawBody, headers);
    return html.replace(/<style[\s\S]*?<\/style>/gi, '')
               .replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, '')
               .replace(/&nbsp;/g, ' ');
  }
  return undefined;
}

/** Parse a full `.eml` file content into structured fields. */
export function parseEml(src: string): ParsedEml {
  const { headerBlock, body } = splitHeadersBody(src);
  const headers = parseHeaders(headerBlock);
  const ct = parseContentType(headers.get('content-type'));

  const subjectRaw = headers.get('subject');
  const fromRaw = headers.get('from');
  const dateRaw = headers.get('date');

  const subject = subjectRaw ? decodeHeader(subjectRaw).trim() : undefined;
  const from = fromRaw ? parseFromHeader(fromRaw) : {};
  const dateISO = dateRaw ? parseDateHeader(dateRaw) : undefined;
  const bodyText = findTextPart(body, ct, headers);

  return {
    subject,
    fromName: from.fromName,
    fromEmail: from.fromEmail,
    dateISO,
    body: bodyText?.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
  };
}

// ─── Outlook (Windows) drag-text parser ───────────────────────────────────
//
// Outlook for Windows はメールをブラウザにドラッグした際、`.eml` 本体では
// なく以下のような text/plain だけを渡してくる:
//
//   差出人: 田中太郎 <tanaka@x.com>
//   送信日時: 2026年5月17日 (火) 10:30
//   宛先: someone@y.com
//   件名: テストメール
//
//   (本文)
//
// あるいは英語ロケール:
//
//   From: John Doe <john@x.com>
//   Sent: Monday, May 17, 2026 10:30 AM
//   To: ...
//   Subject: Test email
//
//   (body)
//
// parseEml と同じ ParsedEml シェイプで返し、UI 側 (inbox.ts /
// ticketDetail.ts) からは parseEml と同じ感覚で扱える。

interface HeaderKey {
  canon: 'from' | 'to' | 'cc' | 'subject' | 'sent';
  /** Lowercase aliases that map to this canonical key. */
  aliases: string[];
}
const OUTLOOK_KEYS: HeaderKey[] = [
  { canon: 'from',    aliases: ['from', '差出人', '送信者'] },
  { canon: 'to',      aliases: ['to', '宛先'] },
  { canon: 'cc',      aliases: ['cc'] },
  { canon: 'subject', aliases: ['subject', '件名'] },
  { canon: 'sent',    aliases: ['sent', 'date', '送信日時', '日付'] },
];

function matchHeaderKey(raw: string): HeaderKey['canon'] | null {
  const lc = raw.trim().toLowerCase();
  for (const h of OUTLOOK_KEYS) {
    if (h.aliases.includes(lc)) return h.canon;
  }
  return null;
}

/** 日本語日付「2026年5月17日 (火) 10:30」/「2026年5月17日 10:30」を ISO へ。
 *  曜日カッコ部分は無視。失敗時 undefined。 */
function parseJpDate(s: string): string | undefined {
  const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const dt = new Date(y, mo, d, h, mi);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt.toISOString();
}

/** Outlook drag テキストをパースして ParsedEml に変換する。 */
export function parseOutlookDragText(text: string): ParsedEml {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // ヘッダ部分: 上から見て連続する「キー: 値」行を集め、空行で打ち切る。
  // 最初の 30 行までしか見ない (それ以上は本文)。
  const headers: Partial<Record<HeaderKey['canon'], string>> = {};
  let i = 0;
  const headerLimit = Math.min(30, lines.length);
  let lastCanon: HeaderKey['canon'] | null = null;
  for (; i < headerLimit; i++) {
    const line = lines[i] ?? '';
    // 空行 → ヘッダ終了
    if (!line.trim()) { i++; break; }
    // 継続行 (空白始まり) → 直前のキーに連結
    if (/^[ \t]/.test(line) && lastCanon) {
      headers[lastCanon] = ((headers[lastCanon] ?? '') + ' ' + line.trim()).trim();
      continue;
    }
    // 「キー: 値」または「キー:値」(半角・全角コロン両対応)
    const m = line.match(/^([A-Za-z぀-ヿ一-鿿]+)\s*[::]\s*(.*)$/);
    if (m) {
      const canon = matchHeaderKey(m[1] ?? '');
      if (canon) {
        headers[canon] = (m[2] ?? '').trim();
        lastCanon = canon;
        continue;
      }
    }
    // 認識できない行が来たら、ヘッダ終了とみなして抜ける
    break;
  }

  // ヘッダが 1 つも取れなかったら諦めて空シェイプ
  if (!headers.from && !headers.subject) {
    return {};
  }

  // From: 名前 + email 分離
  let fromName: string | undefined;
  let fromEmail: string | undefined;
  if (headers.from) {
    const m = headers.from.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, '').trim();
      fromName = name || undefined;
      fromEmail = m[2].trim();
    } else if (/^[^@\s]+@[^@\s]+$/.test(headers.from)) {
      fromEmail = headers.from;
    } else {
      fromName = headers.from;
    }
  }

  // 日付パース: 日本語 → JS Date.parse → undefined
  let dateISO: string | undefined;
  if (headers.sent) {
    dateISO = parseJpDate(headers.sent);
    if (!dateISO) {
      const t = Date.parse(headers.sent);
      if (!Number.isNaN(t)) dateISO = new Date(t).toISOString();
    }
  }

  // 本文: i 以降の全行を結合 (前後の空行は trim)
  const body = lines.slice(i).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');

  return {
    subject: headers.subject?.trim(),
    fromName,
    fromEmail,
    dateISO,
    body: body || undefined,
  };
}
