// Markdown ↔ HTML round-trip used by the note editor.
//
// Pure conversion functions — no DOM mutation outside a temp <div> for
// parsing, no external dependencies. The editor stores its content as
// Markdown and round-trips it through this module on load/save.
//
// The HTML uses `.ne-*` class names so the matching CSS in editor.css
// can style both the live editor surface and any read-only renderer
// (just apply `.ne-prose` to the host's display container).

// ---------- SharePoint Office for the Web rewriter ----------

/** Rewrite a SharePoint direct-file URL into the Office for the Web
 *  viewer URL so clicking the chip opens Excel / Word / PowerPoint
 *  Online in a new tab instead of triggering a download.
 *
 *  SP serves direct attachment URLs with `Content-Disposition:
 *  attachment` for Office content types, which the browser interprets
 *  as a download. The viewer URLs `https://<tenant>/:x:/r/<path>` (or
 *  `:w:`, `:p:`) ask SP to render the file in Office for the Web.
 *
 *  Idempotent — re-running on an already-rewritten URL is a no-op.
 *  Returns the input unchanged for non-Office extensions, non-HTTP
 *  URLs (e.g. mock data URLs), or unparseable input. */
export function toOfficeViewerUrl(rawUrl: string, filename: string): string {
  if (!rawUrl) return rawUrl;
  const ext = (filename.toLowerCase().match(/\.([^.]+)$/)?.[1]) || '';
  const officePrefix: Record<string, string> = {
    xlsx: 'x', xls: 'x', xlsm: 'x', xlsb: 'x', csv: 'x',
    docx: 'w', doc: 'w', docm: 'w', rtf: 'w',
    pptx: 'p', ppt: 'p', pptm: 'p',
  };
  const prefix = officePrefix[ext];
  if (!prefix) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.protocol.startsWith('http')) return rawUrl;
    if (/^\/:[a-z]:\//.test(u.pathname)) return rawUrl; // already rewritten
    const path = u.pathname.replace(/^\/+/, '');
    return `${u.origin}/:${prefix}:/r/${path}${u.search}${u.hash}`;
  } catch {
    return rawUrl;
  }
}

// ---------- HTML -> Markdown ----------

const ESCAPE_RE = /([\\`*_{}\[\]()#+\-.!|])/g;
function escapeMd(s: string): string {
  return s.replace(ESCAPE_RE, '\\$1');
}

function inlineToMd(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  const inner = Array.from(el.childNodes).map(inlineToMd).join('');
  switch (tag) {
    case 'STRONG':
    case 'B':
      return inner ? `**${inner}**` : '';
    case 'EM':
    case 'I':
      return inner ? `*${inner}*` : '';
    case 'S':
    case 'DEL':
      return inner ? `~~${inner}~~` : '';
    case 'CODE':
      return inner ? `\`${inner.replace(/`/g, '\\`')}\`` : '';
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      // File-attachment chip: serialize as `[<icon> <filename>](url)` so
      // the markdownToHtml pass can rehydrate it back into a chip on load.
      if (el.classList.contains('ne-file')) {
        const ic = el.querySelector('.ne-file-ic')?.textContent ?? '📎';
        const nm = el.querySelector('.ne-file-name')?.textContent ?? (el.getAttribute('download') ?? 'file');
        return `[${ic} ${nm}](${href})`;
      }
      return `[${inner}](${href})`;
    }
    case 'BR':
      return '  \n';
    case 'IMG': {
      const alt = el.getAttribute('alt') ?? '';
      const src = el.getAttribute('src') ?? '';
      return `![${alt}](${src})`;
    }
    case 'SPAN':
      return inner;
    default:
      return inner;
  }
}

function blockToMd(el: HTMLElement): string {
  const tag = el.tagName;
  if (tag === 'H1') return '# ' + inlineToMd(el);
  if (tag === 'H2') return '## ' + inlineToMd(el);
  if (tag === 'H3') return '### ' + inlineToMd(el);
  if (tag === 'H4') return '#### ' + inlineToMd(el);
  if (tag === 'H5') return '##### ' + inlineToMd(el);
  if (tag === 'H6') return '###### ' + inlineToMd(el);
  if (tag === 'BLOCKQUOTE') {
    const lines = inlineToMd(el).split('\n');
    return lines.map((l) => '> ' + l).join('\n');
  }
  if (tag === 'PRE') {
    const code = el.querySelector('code');
    const text = code ? code.textContent ?? '' : el.textContent ?? '';
    return '```\n' + text + '\n```';
  }
  if (tag === 'UL') {
    return Array.from(el.children)
      .filter((c) => c.tagName === 'LI')
      .map((li) => '- ' + inlineToMd(li))
      .join('\n');
  }
  if (tag === 'OL') {
    return Array.from(el.children)
      .filter((c) => c.tagName === 'LI')
      .map((li, i) => `${i + 1}. ` + inlineToMd(li))
      .join('\n');
  }
  if (tag === 'HR') return '---';
  if (el.classList.contains('ne-todo')) {
    const cb = el.querySelector<HTMLInputElement>('.ne-todo-cb');
    const txt = el.querySelector('.ne-todo-txt');
    const checked = cb?.checked ? 'x' : ' ';
    return `- [${checked}] ` + (txt ? inlineToMd(txt) : '');
  }
  if (el.classList.contains('ne-callout')) {
    const body = el.querySelector('.ne-callout-body');
    const text = body ? inlineToMd(body) : inlineToMd(el);
    return text.split('\n').map((l) => '> 💡 ' + l).join('\n');
  }
  if (tag === 'DIV' && el.querySelector('table.ne-table')) {
    const tbl = el.querySelector('table.ne-table') as HTMLElement | null;
    if (tbl) return tableToMd(tbl);
  }
  if (tag === 'TABLE') return tableToMd(el);
  if (tag === 'P' || tag === 'DIV') return inlineToMd(el);
  return inlineToMd(el);
}

function tableToMd(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const cells = rows.map((tr) =>
    Array.from(tr.querySelectorAll('td,th')).map((c) => inlineToMd(c).trim().replace(/\|/g, '\\|')),
  );
  const cols = Math.max(...cells.map((r) => r.length));
  for (const r of cells) while (r.length < cols) r.push('');
  const head = cells[0]!;
  const body = cells.slice(1);
  const sep = head.map(() => '---');
  const lines = [
    '| ' + head.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...body.map((r) => '| ' + r.join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const out: string[] = [];
  for (const child of Array.from(tmp.children)) {
    out.push(blockToMd(child as HTMLElement));
  }
  return out.filter(Boolean).join('\n\n').trim();
}

// ---------- Markdown -> HTML ----------

function inlineMdToHtml(s: string): string {
  // strict order: code -> bold -> italic -> strike -> link -> img
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  out = out.replace(/\*([^*]+)\*/g, (_, c) => `<em>${c}</em>`);
  out = out.replace(/~~([^~]+)~~/g, (_, c) => `<s>${c}</s>`);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" class="ne-img"/>`);
  // Link rewriting. A link whose text starts with one of our recognized
  // file-icon emojis (📎/📊/📕/📝/📈/📦) becomes a `.ne-file` chip so
  // the editor & read-only renderer style it consistently. Everything
  // else stays as a plain anchor.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => {
    const m = /^(📎|📊|📕|📝|📈|📦)\s+(.+)$/.exec(t);
    if (m) {
      const icon = m[1];
      const name = m[2];
      // Rewrite Office file URLs to Office for the Web so clicks open
      // the file in Excel / Word / PowerPoint Online instead of
      // downloading. Direct SP file URLs are served with
      // Content-Disposition: attachment which the browser interprets
      // as a download — the :x:/r/, :w:/r/, :p:/r/ prefixes are SP's
      // documented hint to use the web viewer.
      const viewerHref = toOfficeViewerUrl(h, name);
      const safe = name.replace(/"/g, '&quot;');
      return (
        `<a class="ne-file" href="${viewerHref}" target="_blank" rel="noopener noreferrer" ` +
        `title="ダブルクリックで開く: ${safe}" contenteditable="false" data-ne-file="1">` +
        `<span class="ne-file-ic">${icon}</span>` +
        `<span class="ne-file-name">${name}</span></a>`
      );
    }
    return `<a href="${h}">${t}</a>`;
  });
  out = out.replace(/  \n/g, '<br>');
  return out;
}

function tableMdToHtml(lines: string[]): string {
  const split = (line: string) =>
    line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const head = split(lines[0] ?? '');
  const body = lines.slice(2).map(split);
  // Wrap in a div so the table is contenteditable=false-friendly when
  // re-mounted in the editor (the editor rewires it on setMarkdown).
  let html = '<div class="ne-table-wrap"><table class="ne-table"><tbody>';
  html += '<tr>';
  for (const h of head) html += `<td>${inlineMdToHtml(h)}</td>`;
  html += '</tr>';
  for (const r of body) {
    html += '<tr>';
    for (const c of r) html += `<td>${inlineMdToHtml(c)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) { i++; continue; }
    // h1-6
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level}>${inlineMdToHtml(h[2] ?? '')}</h${level}>`);
      i++; continue;
    }
    // hr
    if (/^---+$/.test(line)) { out.push('<hr/>'); i++; continue; }
    // code fence
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      const code = codeLines.join('\n')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      out.push(`<pre><code>${code}</code></pre>`);
      continue;
    }
    // table
    if (line.startsWith('|') && lines[i + 1] && /^\|[\s\-|:]+\|$/.test(lines[i + 1]!)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        tableLines.push(lines[i]!);
        i++;
      }
      out.push(tableMdToHtml(tableLines));
      continue;
    }
    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        buf.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      // detect callout (💡 prefix)
      if (buf[0]?.startsWith('💡')) {
        // CRITICAL: convert each line BEFORE joining with `<br>`. Joining
        // first and then passing to inlineMdToHtml double-escapes the `<br>`
        // tags into `&lt;br&gt;` (because that helper escapes `<` and `>`).
        const body = buf.map((l) => inlineMdToHtml(l.replace(/^💡\s?/, ''))).join('<br>');
        out.push(`<div class="ne-callout"><span class="ne-callout-ic">💡</span><div class="ne-callout-body">${body}</div></div>`);
      } else {
        const body = buf.map((l) => inlineMdToHtml(l)).join('<br>');
        out.push(`<blockquote>${body}</blockquote>`);
      }
      continue;
    }
    // todo
    if (/^- \[[ xX]\]\s/.test(line)) {
      const items: { checked: boolean; text: string }[] = [];
      while (i < lines.length && /^- \[[ xX]\]\s/.test(lines[i] ?? '')) {
        const m = lines[i]!.match(/^- \[([ xX])\]\s+(.*)$/)!;
        items.push({ checked: m[1] !== ' ', text: m[2] ?? '' });
        i++;
      }
      for (const it of items) {
        out.push(
          `<div class="ne-todo"><input type="checkbox" class="ne-todo-cb"${it.checked ? ' checked' : ''}/><span class="ne-todo-txt${it.checked ? ' done' : ''}">${inlineMdToHtml(it.text)}</span></div>`,
        );
      }
      continue;
    }
    // ul
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? '')) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((it) => `<li>${inlineMdToHtml(it)}</li>`).join('') + '</ul>');
      continue;
    }
    // ol
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? '')) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((it) => `<li>${inlineMdToHtml(it)}</li>`).join('') + '</ol>');
      continue;
    }
    // paragraph
    out.push(`<p>${inlineMdToHtml(line)}</p>`);
    i++;
  }
  return out.join('');
}

// ---------- Round-trip helpers ----------

/** Wrap loose plain text in a <p> if no block tags are present. */
export function ensureBlockWrapped(html: string): string {
  if (/<(p|h[1-6]|ul|ol|pre|blockquote|hr|div|table)\b/i.test(html)) return html;
  return `<p>${html}</p>`;
}

export { escapeMd };
