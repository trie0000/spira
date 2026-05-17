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
      // Preserve user-resized width as a `{w=N}` suffix so the next
      // markdownToHtml round can re-apply the inline style. We only
      // serialize a width when the user has explicitly resized.
      const w = parseFloat((el as HTMLImageElement).style.width || '');
      const sizeSuffix = Number.isFinite(w) && w > 0 ? `{w=${Math.round(w)}}` : '';
      return `![${alt}](${src})${sizeSuffix}`;
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
  if (tag === 'P' || tag === 'DIV') {
    const md = inlineToMd(el);
    // 空段落 (contenteditable が cursor placeholder として置く <p><br></p>
    // や、ユーザーが Enter で意図的に作った空行) は round-trip で消えない
    // ように HTML コメントのセンチネルで保持する。markdownToHtml で同じ
    // コメントを検出して <p><br></p> に復元する。
    if (!md.trim()) return '<!--ne-blank-->';
    return md;
  }
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
  // ヘッダ行フラグ (色付きの見出し行) を sidecar コメントで保存。
  // 標準 markdown では区別がつかないので、Spira 独自の `<!--ne-thead-->`
  // を表の直後に書き、パース側で復元する。
  if (table.classList.contains('ne-table-has-header')) {
    lines.push('<!--ne-thead-->');
  }
  // Persist column widths set by the editor's drag-resize handles as a
  // trailing HTML comment. Markdown parsers ignore it, so the table
  // still renders elsewhere; our markdownToHtml side reads the same
  // comment to reapply the widths on next load. Skip the comment
  // entirely when no column has an explicit width — keeps the saved
  // markdown clean.
  const cg = table.querySelector('colgroup');
  if (cg) {
    const widths = Array.from(cg.querySelectorAll('col')).map((c) => {
      const w = parseInt((c as HTMLElement).style.width || '', 10);
      return Number.isFinite(w) && w > 0 ? w : 0;
    });
    if (widths.some((w) => w > 0)) {
      lines.push(`<!--ne-cols:${widths.join(',')}-->`);
    }
  }
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
  // 末尾の空段落 (センチネル含む) は削除して clean に保つ。
  // ただし途中の空段落は保持して、ユーザーが意図的に作った縦余白を
  // round-trip で再現する。
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!last || !last.trim() || last === '<!--ne-blank-->') out.pop();
    else break;
  }
  return out.join('\n\n');
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
  // Image: matches `![alt](src)` with optional `{w=N}` suffix for
  // user-resized width. The width (if present) becomes an inline style.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)(?:\{w=(\d+)\})?/g, (_, alt, src, w) => {
    const style = w ? ` style="width:${w}px;height:auto"` : '';
    return `<img src="${src}" alt="${alt}" class="ne-img"${style}/>`;
  });
  // ファイルチップ (file-icon emoji で始まる link) を先に処理。
  // URL に `)` が含まれる場合に備えて、URL は (a) 行末まで or (b) 直後が
  // 空白か行末になる `)` までを greedy に取る。SP の Office viewer URL に
  // クエリストリングが付くと `)` が含まれることがあるため。
  out = out.replace(
    /\[((?:📎|📊|📕|📝|📈|📦)\s+[^\]]+)\]\((.+?)\)(?=$|[\s])/gm,
    (_, t, h) => {
      const m = /^(📎|📊|📕|📝|📈|📦)\s+(.+)$/.exec(t);
      if (!m) return `[${t}](${h})`;
      const icon = m[1];
      const name = m[2];
      const viewerHref = toOfficeViewerUrl(h, name ?? '');
      const safe = (name ?? '').replace(/"/g, '&quot;');
      return (
        `<a class="ne-file" href="${viewerHref}" target="_blank" rel="noopener noreferrer" ` +
        `title="ダブルクリックで開く: ${safe}" contenteditable="false" data-ne-file="1">` +
        `<span class="ne-file-ic">${icon}</span>` +
        `<span class="ne-file-name">${name}</span></a>`
      );
    },
  );
  // 通常リンク。ファイルチップは既に処理済みなのでスキップされる。
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

function tableMdToHtml(lines: string[], widths: number[] = [], hasHeader = false): string {
  const split = (line: string) =>
    line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const head = split(lines[0] ?? '');
  const body = lines.slice(2).map(split);
  // Wrap in a div so the table is contenteditable=false-friendly when
  // re-mounted in the editor (the editor rewires it on setMarkdown).
  const tableClass = hasHeader ? 'ne-table ne-table-has-header' : 'ne-table';
  let html = `<div class="ne-table-wrap"><table class="${tableClass}">`;
  // colgroup with optional explicit widths from the `<!--ne-cols:...-->`
  // sidecar comment. Each <col> is unconditionally emitted so the editor
  // can find/mutate it for resize handles; columns without persisted
  // widths render at the table's auto-layout default.
  html += '<colgroup>';
  for (let i = 0; i < head.length; i++) {
    const w = widths[i] ?? 0;
    html += w > 0 ? `<col style="width:${w}px"/>` : '<col/>';
  }
  html += '</colgroup>';
  html += '<tbody>';
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

/** SP の HTML サニタイザが HTML コメントを剥がすため、保存時に
 *  `[[NEM:base64]]` 形式にエンコードしている。何らかの理由で sp.ts 側の
 *  decode が走らなかった場合のフォールバックとして、ここでも decode する。 */
function decodeNemMarkers(s: string): string {
  return s.replace(/\[\[NEM:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
    try {
      // atob → UTF-8 復元
      const bin = atob(b64);
      let out = '';
      for (let i = 0; i < bin.length; i++) out += '%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2);
      return decodeURIComponent(out);
    } catch { return ''; }
  });
}

export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  // Defensive decode of NEM markers (SP roundtrip safety net)。
  md = decodeNemMarkers(md);
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // 空段落センチネル (htmlToMarkdown が出力したもの) → 空段落を復元。
    // <p><br></p> だと一部ブラウザで段落マージン領域をクリックしても
    // カーソルが「次の段落」に飛んでしまい入力できない。zero-width space
    // (U+200B) を 1 文字入れておくと cursor が確実に位置決めできる。
    // この文字は HTML 上では不可視で、Backspace 1 回で消える。
    if (line.trim() === '<!--ne-blank-->') {
      out.push('<p class="ne-blank-p">​</p>');
      i++; continue;
    }
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
      // Peek for the sidecar comments (widths + header-row flag) that
      // htmlToMarkdown writes immediately after the table block. SP の
      // サニタイザが行を <p> で wrap することもあるので、HTML タグを
      // 剥がしてから regex マッチする (lenient parsing)。
      let widths: number[] = [];
      let hasHeader = false;
      for (let peeks = 0; peeks < 3; peeks++) {
        const nextLine = lines[i];
        if (!nextLine) break;
        // <p>...</p> や <div>...</div> など SP が付ける wrapper を除去
        const stripped = nextLine.replace(/<\/?(p|div|span)[^>]*>/gi, '').trim();
        const wm = /<!--ne-cols:([\d,]*)-->/.exec(stripped);
        if (wm) {
          widths = wm[1]!.split(',').map((s) => {
            const n = parseInt(s, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
          });
          i++; continue;
        }
        if (/<!--ne-thead-->/.test(stripped)) { hasHeader = true; i++; continue; }
        // empty line (after comment) skip
        if (stripped === '') { i++; continue; }
        break;
      }
      out.push(tableMdToHtml(tableLines, widths, hasHeader));
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
    // ul / ol — ネスト対応。インデント (スペース 2 or 4、またはタブ 1) で
    // 子リストになる。`- foo` / `* foo` / `1. foo` を統一的に扱い、
    // インデント幅から階層を求め、適切に <ul>/<ol> をネストさせる。
    // CommonMark の厳密仕様ではなく、AI が出力しがちな形式を吸収する程度の
    // 緩いネスト判定。
    const bulletRe = /^([ \t]*)([-*]|\d+\.)\s+(.*)$/;
    if (bulletRe.test(line)) {
      // インデント幅 → 階層 (0, 1, 2…) に正規化
      const indentOf = (l: string): number => {
        const m = l.match(/^([ \t]*)/);
        const ws = m ? m[1]! : '';
        // タブ 1 = スペース 4 として、2 スペース毎に 1 階層
        const cols = ws.replace(/\t/g, '    ').length;
        return Math.floor(cols / 2);
      };
      interface Item { level: number; ordered: boolean; text: string }
      const items: Item[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        const m = bulletRe.exec(cur);
        if (!m) break;
        const marker = m[2]!;
        items.push({
          level: indentOf(cur),
          ordered: /^\d+\./.test(marker),
          text: m[3] ?? '',
        });
        i++;
      }
      // 最も浅い level を 0 に正規化
      const minLevel = Math.min(...items.map(it => it.level));
      for (const it of items) it.level -= minLevel;
      // スタックベースで <ul>/<ol> をネスト構築
      const html: string[] = [];
      const stack: Array<'ul' | 'ol'> = [];
      const openList = (kind: 'ul' | 'ol'): void => { html.push(`<${kind}>`); stack.push(kind); };
      const closeList = (): void => { const k = stack.pop(); if (k) html.push(`</${k}>`); };
      let lastLevel = -1;
      for (const it of items) {
        const desiredKind: 'ul' | 'ol' = it.ordered ? 'ol' : 'ul';
        if (it.level > lastLevel) {
          for (let l = lastLevel + 1; l <= it.level; l++) openList(desiredKind);
        } else if (it.level < lastLevel) {
          // 同階層に戻るときは、その階層分まで </li></ul> で閉じる。最後の
          // <li> を閉じ切ってから次の <li> を開けるため、stack 深さで管理。
          while (stack.length - 1 > it.level) {
            html.push('</li>');
            closeList();
          }
          html.push('</li>');
        } else {
          html.push('</li>');
        }
        html.push(`<li>${inlineMdToHtml(it.text)}`);
        lastLevel = it.level;
      }
      // 残った <li> + リストを全部閉じる
      while (stack.length > 0) {
        html.push('</li>');
        closeList();
      }
      out.push(html.join(''));
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
