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
