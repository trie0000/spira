// Self-contained Notion-like rich-text editor.
//
// Drop the entire `note-editor` directory into another project to use it;
// the only TypeScript dependency is on `./markdown` (sibling file).
//
// Capabilities:
//   - Slash menu (`/`) with: text / h1-3 / callout / quote / ul / ol / todo
//     / hr / pre / table
//   - Block drag handle (left-margin grip) for reordering top-level blocks
//   - Image paste / drop → inlined as base64 data URL (no upload)
//   - Inline table (Tab to navigate, Enter at row end appends a new row)
//   - Floating selection toolbar (bold / italic / strike / inline code)
//   - Markdown round-trip via ./markdown
//
// Styling:
//   - All editor elements use `.ne-*` class names. The matching CSS lives
//     in editor.css and uses `var(--ne-X, fallback)` for theming.
//   - Floating widgets (slash menu, drag handle, floating toolbar) attach
//     to document.body so they position relative to the viewport, not
//     the host's flex/grid layout.

import { htmlToMarkdown, markdownToHtml, ensureBlockWrapped, toOfficeViewerUrl } from './markdown';

export interface NoteEditorOptions {
  /** Initial markdown content. */
  value?: string;
  /** Placeholder shown when the editor is empty. */
  placeholder?: string;
  /** Called after every meaningful edit. */
  onDirty?: () => void;
  /** Called on Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  /** Called on Escape (when no overlay is open). */
  onCancel?: () => void;
  /** Optional extra class added to the root for host theming. */
  className?: string;
  /** Where to attach floating widgets (slash menu / drag handle / selection
   *  toolbar). Defaults to `document.body`. Set this if your host uses a
   *  shadow DOM, or wraps the page in a fixed-position overlay with its
   *  own stacking context that traps body-level z-index. */
  floatingContainer?: HTMLElement;
  /** Host-provided file upload hook. Invoked when the user drops, pastes
   *  or picks a file via the slash menu. The host uploads the file to
   *  wherever it likes (SharePoint, S3, etc.) and returns `{url, filename}`
   *  pointing at the stored copy; the editor then inserts a clickable
   *  chip linking to that URL. If `onFileUpload` is omitted, dropped
   *  non-image files are ignored. Images continue to be inlined as
   *  base64 unless an upload hook is provided and `imageUploadMode` is
   *  set to `'always-upload'` (TODO — for now images always inline). */
  onFileUpload?: (file: File) => Promise<{ url: string; filename: string } | null>;
}

export interface NoteEditor {
  /** Root element to insert into the page. */
  root: HTMLElement;
  /** Read the current content as Markdown. */
  getMarkdown(): string;
  /** Replace content from Markdown. */
  setMarkdown(md: string): void;
  /** Move focus into the contenteditable area. */
  focus(): void;
  /** Detach DOM listeners and remove floating widgets — call on unmount. */
  destroy(): void;
}

// ─────────────────────────────────────────────────────────────────────
// Slash menu definitions
// ─────────────────────────────────────────────────────────────────────

interface SlashItem {
  cmd: string;
  icon: string;
  name: string;
  desc: string;
  cat: string;
  md?: string;
}

const SLASH_ITEMS: SlashItem[] = [
  { cat: '基本', cmd: 'p', icon: 'T', name: 'テキスト', desc: 'プレーンテキスト' },
  { cat: '基本', cmd: 'h1', icon: 'H1', name: '見出し1', desc: '大きな見出し', md: '#' },
  { cat: '基本', cmd: 'h2', icon: 'H2', name: '見出し2', desc: '中見出し', md: '##' },
  { cat: '基本', cmd: 'h3', icon: 'H3', name: '見出し3', desc: '小見出し', md: '###' },
  { cat: '基本', cmd: 'callout', icon: '💡', name: 'コールアウト', desc: 'ハイライトボックス' },
  { cat: '基本', cmd: 'quote', icon: '❝', name: '引用', desc: '引用ブロック', md: '>' },
  { cat: 'リスト', cmd: 'ul', icon: '•', name: '箇条書き', desc: 'シンプルな箇条書き', md: '-' },
  { cat: 'リスト', cmd: 'ol', icon: '1.', name: '番号付き', desc: '番号付き箇条書き', md: '1.' },
  { cat: 'リスト', cmd: 'todo', icon: '☐', name: 'ToDoリスト', desc: 'チェックボックス付き', md: '[]' },
  { cat: 'メディア', cmd: 'hr', icon: '—', name: '区切り線', desc: 'セクション区切り', md: '---' },
  { cat: 'メディア', cmd: 'file', icon: '📎', name: 'ファイル添付', desc: 'Excel / PDF / Word 等をアップロード' },
  { cat: 'コード', cmd: 'pre', icon: '</>', name: 'コードブロック', desc: 'シンタックスハイライト', md: '```' },
  { cat: 'データ', cmd: 'table', icon: '⊞', name: '表', desc: '簡易表 (3×2)・セル編集可' },
];

// ─────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────

export function createNoteEditor(opts: NoteEditorOptions = {}): NoteEditor {
  const root = document.createElement('div');
  root.className = 'ne-editor' + (opts.className ? ' ' + opts.className : '');

  const ed = document.createElement('div');
  ed.className = 'ne-content ne-prose';
  ed.contentEditable = 'true';
  ed.setAttribute('spellcheck', 'false');
  if (opts.placeholder) ed.setAttribute('data-placeholder', opts.placeholder);

  // Floating widgets — appended to document.body so they aren't trapped by
  // the host's overflow/positioning. Removed in destroy().
  const slashMenu = document.createElement('div');
  slashMenu.className = 'ne-slash';

  const ftb = document.createElement('div');
  ftb.className = 'ne-ftb';
  ftb.innerHTML = `
    <button type="button" class="ne-ftb-b" data-cmd="bold" title="太字 (Cmd/Ctrl+B)"><b>B</b></button>
    <button type="button" class="ne-ftb-b" data-cmd="italic" title="斜体 (Cmd/Ctrl+I)"><i>I</i></button>
    <button type="button" class="ne-ftb-b" data-cmd="strike" title="取り消し線"><s>S</s></button>
    <button type="button" class="ne-ftb-b" data-cmd="code" title="インラインコード"><code>&lt;/&gt;</code></button>
  `;

  const handle = document.createElement('div');
  handle.className = 'ne-drag-handle';
  handle.draggable = true;
  handle.title = 'ドラッグして並べ替え';
  handle.innerHTML =
    '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="2" cy="3" r="1.3"/><circle cx="2" cy="8" r="1.3"/><circle cx="2" cy="13" r="1.3"/>' +
    '<circle cx="8" cy="3" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="13" r="1.3"/>' +
    '</svg>';
  handle.style.display = 'none';

  root.appendChild(ed);
  const floatRoot = opts.floatingContainer ?? document.body;
  floatRoot.appendChild(slashMenu);
  floatRoot.appendChild(ftb);
  floatRoot.appendChild(handle);

  if (opts.value) {
    ed.innerHTML = ensureBlockWrapped(markdownToHtml(opts.value));
  } else {
    ed.innerHTML = '<p><br></p>';
  }

  /** Toggle `.ne-empty` so the CSS `::before` placeholder shows. The editor
   *  is "empty" when its only child is a `<p>` containing only a `<br>` —
   *  i.e. the initial state and any state the user backspaces back to. */
  function refreshEmptyState(): void {
    const only = ed.children.length === 1 ? ed.firstElementChild : null;
    const empty =
      ed.children.length === 0 ||
      (only?.tagName === 'P' &&
        only.childNodes.length === 1 &&
        (only.firstChild as Element | null)?.nodeName === 'BR');
    ed.classList.toggle('ne-empty', !!empty);
  }
  refreshEmptyState();

  const state = {
    slashActive: false,
    slashQuery: '',
    slashSel: 0,
    slashFiltered: [] as SlashItem[],
    slashNode: null as Node | null,
    /** Block currently under the mouse cursor (mousemove-driven). */
    hoverBlock: null as HTMLElement | null,
    /** Block currently containing the caret (selectionchange-driven). */
    caretBlock: null as HTMLElement | null,
    dragSrc: null as HTMLElement | null,
  };

  const markDirty = (): void => { opts.onDirty?.(); };

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* unsupported */ }

  // ─── DOM helpers ────────────────────────────────────────────────────

  function curBlock(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let n: Node | null = sel.getRangeAt(0).startContainer;
    while (n && n !== ed) {
      if (n.nodeType === 1 && /^(P|H[1-6]|PRE|BLOCKQUOTE|LI|UL|OL|DIV)$/.test((n as Element).tagName)) {
        return n as HTMLElement;
      }
      n = n.parentNode;
    }
    return null;
  }

  function findAncestor(node: Node | null, selector: string): HTMLElement | null {
    while (node && node !== ed) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (el.matches?.(selector)) return el as HTMLElement;
      }
      node = node.parentNode;
    }
    return null;
  }

  function findCallout(node: Node | null): HTMLElement | null {
    return findAncestor(node, '.ne-callout');
  }

  function isAtBlockStart(range: Range, block: Node): boolean {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(range.startContainer, range.startOffset);
    return r.toString() === '';
  }

  function isAtBlockEnd(range: Range, block: Node): boolean {
    const r = document.createRange();
    r.setStart(range.startContainer, range.startOffset);
    r.setEnd(block, block.childNodes.length);
    return r.toString() === '';
  }

  function placeCaretAtStart(node: Node): void {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(node, 0); r.collapse(true);
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  }

  function insertTextAtCursor(text: string): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tn = document.createTextNode(text);
    r.insertNode(tn);
    const newR = document.createRange();
    newR.setStartAfter(tn); newR.collapse(true);
    sel.removeAllRanges(); sel.addRange(newR);
  }

  function flattenBrToNewline(el: HTMLElement): void {
    el.querySelectorAll('br').forEach((br) => {
      const tn = document.createTextNode('\n');
      br.parentNode!.replaceChild(tn, br);
    });
    el.normalize();
  }

  function unwrapToP(block: HTMLElement, useTextOnly: boolean): HTMLElement {
    const p = document.createElement('p');
    if (useTextOnly) p.textContent = block.textContent || '';
    else while (block.firstChild) p.appendChild(block.firstChild);
    if (!p.firstChild) p.innerHTML = '<br>';
    block.parentNode!.replaceChild(p, block);
    placeCaretAtStart(p);
    return p;
  }

  function unwrapPre(pre: HTMLElement): void {
    flattenBrToNewline(pre);
    const text = pre.textContent || '';
    const lines = text.split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const parent = pre.parentNode!;
    const ref = pre.nextSibling;
    let firstP: HTMLParagraphElement | null = null;
    for (const line of lines) {
      const p = document.createElement('p');
      if (line) p.textContent = line;
      else p.appendChild(document.createElement('br'));
      parent.insertBefore(p, ref);
      if (!firstP) firstP = p;
    }
    if (!firstP) {
      firstP = document.createElement('p');
      firstP.appendChild(document.createElement('br'));
      parent.insertBefore(firstP, ref);
    }
    pre.remove();
    placeCaretAtStart(firstP);
  }

  function unwrapTodo(todo: HTMLElement): void {
    const p = document.createElement('p');
    const txt = todo.querySelector('.ne-todo-txt');
    if (txt) while (txt.firstChild) p.appendChild(txt.firstChild);
    if (!p.firstChild) p.innerHTML = '<br>';
    todo.parentNode!.replaceChild(p, todo);
    placeCaretAtStart(p);
  }

  function unwrapCallout(callout: HTMLElement): void {
    const body = callout.querySelector('.ne-callout-body');
    const parent = callout.parentNode!;
    let firstMoved: Node | null = null;
    if (body) {
      while (body.firstChild) {
        const child = body.firstChild;
        parent.insertBefore(child, callout);
        if (!firstMoved) firstMoved = child;
      }
    }
    if (!firstMoved) {
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      parent.insertBefore(p, callout);
      firstMoved = p;
    }
    callout.remove();
    placeCaretAtStart(firstMoved);
  }

  function isAtCalloutStart(range: Range, callout: HTMLElement): boolean {
    const body = callout.querySelector('.ne-callout-body');
    if (!body) return false;
    const r = document.createRange();
    r.setStart(body, 0);
    r.setEnd(range.startContainer, range.startOffset);
    return r.toString() === '';
  }

  // ─── Slash menu ─────────────────────────────────────────────────────

  function filterSlashItems(): SlashItem[] {
    if (!state.slashQuery) return SLASH_ITEMS;
    const startsWithMd = !/^\w/.test(state.slashQuery);
    if (startsWithMd) {
      const hits = SLASH_ITEMS.filter((it) => it.md && it.md.startsWith(state.slashQuery));
      if (hits.length > 0) {
        return hits.sort((a, b) => {
          const aE = a.md === state.slashQuery ? 0 : 1;
          const bE = b.md === state.slashQuery ? 0 : 1;
          if (aE !== bE) return aE - bE;
          return (a.md?.length ?? 0) - (b.md?.length ?? 0);
        });
      }
      return [];
    }
    const q = state.slashQuery.toLowerCase();
    return SLASH_ITEMS.filter((it) =>
      it.name.toLowerCase().includes(q) || it.cmd.toLowerCase().includes(q),
    );
  }

  function showSlashMenu(rect: { top: number; bottom: number; left: number }): void {
    state.slashFiltered = filterSlashItems();
    if (state.slashFiltered.length === 0) { closeSlashMenu(); return; }
    if (state.slashSel >= state.slashFiltered.length) state.slashSel = 0;

    slashMenu.innerHTML = '';
    let prevCat = '';
    let selEl: HTMLElement | null = null;
    state.slashFiltered.forEach((item, idx) => {
      if (item.cat !== prevCat) {
        const sec = document.createElement('div');
        sec.className = 'ne-slash-section';
        sec.textContent = item.cat;
        slashMenu.appendChild(sec);
        prevCat = item.cat;
      }
      const div = document.createElement('div');
      div.className = 'ne-slash-item' + (idx === state.slashSel ? ' sel' : '');
      const hint = item.md ? `<div class="ne-slash-kbd">${item.md}</div>` : '';
      div.innerHTML =
        `<div class="ne-slash-icon">${item.icon}</div>` +
        `<div class="ne-slash-body"><div class="ne-slash-name">${item.name}</div><div class="ne-slash-desc">${item.desc}</div></div>` +
        hint;
      div.addEventListener('mousedown', (e) => { e.preventDefault(); applySlashCmd(item.cmd); });
      slashMenu.appendChild(div);
      if (idx === state.slashSel) selEl = div;
    });

    // Floating widgets use position: fixed → viewport coordinates, no scroll math.
    let left = rect.left;
    const vpW = window.innerWidth;
    if (left + 280 > vpW) left = vpW - 284;
    if (left < 4) left = 4;
    slashMenu.style.left = left + 'px';
    slashMenu.classList.add('on');
    const menuH = slashMenu.getBoundingClientRect().height || 320;
    const vpH = window.innerHeight;
    const spaceBelow = vpH - rect.bottom;
    const spaceAbove = rect.top;
    const placeBelow = spaceBelow >= menuH + 12 || spaceBelow >= spaceAbove;
    let top: number;
    if (placeBelow) {
      top = rect.bottom + 4;
      const maxTop = vpH - menuH - 8;
      if (top > maxTop) top = maxTop;
    } else {
      top = rect.top - menuH - 4;
      if (top < 8) top = 8;
    }
    slashMenu.style.top = top + 'px';
    if (selEl) requestAnimationFrame(() => {
      try { (selEl as HTMLElement).scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
    });
  }

  function closeSlashMenu(): void {
    state.slashActive = false;
    state.slashQuery = '';
    state.slashSel = 0;
    state.slashNode = null;
    slashMenu.classList.remove('on');
  }

  function applySlashCmd(cmd: string): void {
    if (state.slashNode && ed.contains(state.slashNode)) {
      const sel0 = window.getSelection();
      if (sel0 && sel0.rangeCount) {
        const rng0 = sel0.getRangeAt(0);
        const txt = (state.slashNode as Text).textContent || '';
        const curOff = (rng0.startContainer === state.slashNode) ? rng0.startOffset : txt.length;
        const slashStart = curOff - state.slashQuery.length - 1;
        if (slashStart >= 0 && txt.charAt(slashStart) === '/') {
          (state.slashNode as Text).textContent = txt.substring(0, slashStart) + txt.substring(curOff);
          const r = document.createRange();
          r.setStart(state.slashNode, slashStart); r.collapse(true);
          sel0.removeAllRanges(); sel0.addRange(r);
        }
      }
    }
    closeSlashMenu();

    // CRITICAL: after deleting the typed `/query`, the host block may be
    // empty (no text + no <br>). `document.execCommand('formatBlock')` on
    // an empty paragraph is unreliable — Chrome may silently retarget the
    // previous block, which produced the "/h1 on a new line changes the
    // line above" bug. Re-anchor by inserting a <br> so formatBlock has a
    // node to operate on, AND park the caret inside it so curBlock() picks
    // up the right block.
    ed.focus();
    const hostBlock = curBlock();
    if (hostBlock && hostBlock !== ed && hostBlock.childNodes.length === 0) {
      hostBlock.appendChild(document.createElement('br'));
      placeCaretAtStart(hostBlock);
    }

    if (cmd === 'p') {
      setBlockTag(hostBlock, 'p');
    } else if (cmd === 'todo') {
      insertTodoBlock();
    } else if (cmd === 'callout') {
      insertCalloutBlock();
    } else if (cmd === 'table') {
      insertTableBlock(3, 2);
    } else if (cmd === 'file') {
      openFilePickerAndUpload();
    } else {
      execCmd(cmd);
    }
    markDirty();
  }

  // ── File attachment ──────────────────────────────────────────────────

  /** Map extension to a friendly emoji icon. Used both when the editor
   *  inserts a chip locally and when markdown.ts rehydrates one on load. */
  function fileIconFor(filename: string): string {
    const ext = (filename.toLowerCase().match(/\.([^.]+)$/)?.[1]) || '';
    if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) return '📊';
    if (['docx', 'doc', 'rtf'].includes(ext))        return '📝';
    if (['pdf'].includes(ext))                        return '📕';
    if (['pptx', 'ppt'].includes(ext))                return '📈';
    if (['zip', '7z', 'tar', 'gz'].includes(ext))     return '📦';
    return '📎';
  }

  /** Build a finished file-chip <a> (no DOM insertion). Shared by upload
   *  completion and markdown rehydration on `setMarkdown`.
   *
   *  No `download` attribute — we want clicks (in read-only display) or
   *  double-clicks (inside the editor) to open the file in the browser
   *  (Office Online for .xlsx / .docx / .pptx, native viewer for PDF,
   *  download for binary types — SP decides based on Content-Type). */
  function buildFileChip(url: string, filename: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.className = 'ne-file';
    // Rewrite Office (Excel/Word/PowerPoint) URLs to the SP "Office for
    // the Web" viewer endpoint so a click opens in the browser viewer
    // instead of downloading. Other types and non-HTTP URLs are passed
    // through unchanged.
    a.href = toOfficeViewerUrl(url, filename);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = `ダブルクリックで開く: ${filename}`;
    a.setAttribute('contenteditable', 'false');
    a.setAttribute('data-ne-file', '1');
    a.innerHTML =
      `<span class="ne-file-ic">${fileIconFor(filename)}</span>` +
      `<span class="ne-file-name"></span>`;
    (a.querySelector('.ne-file-name') as HTMLElement).textContent = filename;
    return a;
  }

  /** Insert a placeholder chip with a spinner, return it so we can swap
   *  it for the real chip when upload finishes (or remove it on failure). */
  function insertFilePlaceholderAtCursor(filename: string): HTMLElement {
    const ph = document.createElement('span');
    ph.className = 'ne-file ne-file--uploading';
    ph.setAttribute('contenteditable', 'false');
    ph.setAttribute('data-ne-file-placeholder', '1');
    ph.innerHTML =
      `<span class="ne-file-ic">${fileIconFor(filename)}</span>` +
      `<span class="ne-file-name"></span>` +
      `<span class="ne-file-status">アップロード中…</span>`;
    (ph.querySelector('.ne-file-name') as HTMLElement).textContent = filename;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.insertNode(ph);
      const tail = document.createTextNode(' ');
      ph.parentNode!.insertBefore(tail, ph.nextSibling);
      const newR = document.createRange();
      newR.setStartAfter(tail);
      newR.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newR);
    } else {
      ed.appendChild(ph);
    }
    return ph;
  }

  /** Drive the upload flow: optimistic placeholder → host upload → swap
   *  in the real chip (or rip out the placeholder on failure). */
  async function handleFileUpload(file: File): Promise<void> {
    if (!opts.onFileUpload) return;
    const placeholder = insertFilePlaceholderAtCursor(file.name);
    try {
      const r = await opts.onFileUpload(file);
      if (r && placeholder.parentNode) {
        placeholder.parentNode.replaceChild(buildFileChip(r.url, r.filename), placeholder);
        markDirty();
      } else {
        placeholder.remove();
      }
    } catch {
      placeholder.remove();
    }
  }

  /** Open a native file picker then route the chosen file through the
   *  same upload pipeline as drop/paste. */
  function openFilePickerAndUpload(): void {
    if (!opts.onFileUpload) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) await handleFileUpload(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  /** Replace `block`'s tag with `tag`, preserving children and caret. Manual
   *  alternative to `document.execCommand('formatBlock', ...)` which is
   *  flaky on empty blocks (it can retarget the previous block silently). */
  function setBlockTag(block: HTMLElement | null, tag: string): HTMLElement | null {
    if (!block || block === ed) return null;
    if (block.tagName.toLowerCase() === tag) return block;
    const newEl = document.createElement(tag);
    while (block.firstChild) newEl.appendChild(block.firstChild);
    // Drop leftover empty text nodes (e.g. the husk left behind when the
    // slash-trigger text was deleted by applySlashCmd). Without this an
    // empty text node passes the `!newEl.firstChild` check, suppressing
    // the <br> we need for caret rendering — the heading then renders
    // with zero height and the browser snaps the caret to the editor
    // body instead of the heading. Typing then silently goes nowhere.
    for (let n: ChildNode | null = newEl.firstChild; n; ) {
      const next: ChildNode | null = n.nextSibling;
      if (n.nodeType === 3 && !(n.textContent ?? '').length) n.remove();
      n = next;
    }
    if (!newEl.firstChild) newEl.appendChild(document.createElement('br'));
    block.parentNode!.replaceChild(newEl, block);
    // Park caret at the START of the new block (works for both the
    // `<br>`-only case and the populated case — placing at the beginning
    // is always safe and matches "the rest of the line is now a heading"
    // mental model).
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(newEl, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return newEl;
  }

  function insertTodoBlock(): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const div = document.createElement('div');
    div.className = 'ne-todo';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ne-todo-cb';
    const sp = document.createElement('span');
    sp.className = 'ne-todo-txt';
    div.appendChild(cb); div.appendChild(sp);

    const block = curBlock();
    const hasContent = !!block && block !== ed && (block.textContent || '').trim() !== '';
    let caretEl: Node = sp;
    let caretOff = 0;
    if (hasContent && block) {
      while (block.firstChild) sp.appendChild(block.firstChild);
      caretEl = sp;
      caretOff = sp.childNodes.length;
      block.parentNode!.replaceChild(div, block);
    } else if (block && block !== ed) {
      sp.appendChild(document.createElement('br'));
      block.parentNode!.replaceChild(div, block);
    } else {
      sp.appendChild(document.createElement('br'));
      r.insertNode(div);
    }
    requestAnimationFrame(() => {
      const rng = document.createRange();
      rng.setStart(caretEl, caretOff); rng.collapse(true);
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(rng); }
      ed.focus();
    });
  }

  function insertCalloutBlock(): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const callout = document.createElement('div');
    callout.className = 'ne-callout';
    const ic = document.createElement('span');
    ic.className = 'ne-callout-ic'; ic.textContent = '💡';
    const body = document.createElement('div');
    body.className = 'ne-callout-body';
    callout.appendChild(ic); callout.appendChild(body);

    const p = document.createElement('p');
    body.appendChild(p);
    const block = curBlock();
    const hasContent = !!block && block !== ed && (block.textContent || '').trim() !== '';
    let caretEl: Node = p;
    if (hasContent && block) {
      while (block.firstChild) p.appendChild(block.firstChild);
      block.parentNode!.replaceChild(callout, block);
    } else if (block && block !== ed) {
      p.appendChild(document.createElement('br'));
      block.parentNode!.replaceChild(callout, block);
    } else {
      p.appendChild(document.createElement('br'));
      r.insertNode(callout);
    }
    requestAnimationFrame(() => {
      const rng = document.createRange();
      rng.setStart(caretEl, 0); rng.collapse(true);
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(rng); }
      ed.focus();
    });
  }

  // ─── Inline table ───────────────────────────────────────────────────

  function buildTable(cols: number, rows: number): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'ne-table-wrap';
    wrap.contentEditable = 'false';
    const tbl = document.createElement('table');
    tbl.className = 'ne-table';
    // colgroup drives column widths so the drag-to-resize handle can
    // mutate a single dimension that affects the whole column. New
    // tables start with no explicit width; the user resizes as needed
    // and the chosen widths round-trip via the trailing
    // `<!--ne-cols:N,N,N-->` markdown comment (see markdown.ts).
    const colgroup = document.createElement('colgroup');
    for (let c = 0; c < cols; c++) colgroup.appendChild(document.createElement('col'));
    tbl.appendChild(colgroup);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.contentEditable = 'true';
        td.appendChild(document.createElement('br'));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    attachTableHandlers(wrap);
    return wrap;
  }

  function attachTableHandlers(wrap: HTMLElement): void {
    if (wrap.dataset.neWired === '1') {
      // Already wired — but legacy tables may still be missing the edge
      // buttons / colgroup / resize handles that we added later.
      // Idempotently ensure they exist.
      ensureTableEdgeButtons(wrap);
      const tblEl = wrap.querySelector('table.ne-table') as HTMLTableElement | null;
      if (tblEl) ensureResizeHandles(tblEl);
      return;
    }
    wrap.dataset.neWired = '1';
    const tbl = wrap.querySelector('table.ne-table') as HTMLTableElement | null;
    if (!tbl) return;

    tbl.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isComposing || ke.keyCode === 229) return;
      const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null;
      if (!cell) return;

      if (ke.key === 'Tab') {
        e.preventDefault();
        moveCell(cell, ke.shiftKey ? -1 : 1);
        return;
      }
      if (ke.key === 'Enter' && !ke.shiftKey && !ke.metaKey && !ke.ctrlKey) {
        e.preventDefault();
        const tr = cell.parentElement as HTMLTableRowElement;
        const tbody = tr.parentElement;
        if (tbody && tr === tbody.lastElementChild) addRowAfter(tr);
        else moveDown(cell);
        return;
      }
      // Arrow-key cell navigation — fires only when the caret reaches
      // the visual edge of the cell so multi-line cell content (Shift+
      // Enter inserts <br>) is still navigable line-by-line via the
      // browser's default behavior.
      if (ke.key === 'ArrowDown' && caretOnBottomLine(cell)) {
        const tr = cell.parentElement as HTMLTableRowElement;
        const next = tr.nextElementSibling as HTMLTableRowElement | null;
        if (next) {
          e.preventDefault();
          const idx = Array.from(tr.cells).indexOf(cell);
          focusCell(next.cells[Math.min(idx, next.cells.length - 1)]!);
        }
        return;
      }
      if (ke.key === 'ArrowUp' && caretOnTopLine(cell)) {
        const tr = cell.parentElement as HTMLTableRowElement;
        const prev = tr.previousElementSibling as HTMLTableRowElement | null;
        if (prev) {
          e.preventDefault();
          const idx = Array.from(tr.cells).indexOf(cell);
          focusCell(prev.cells[Math.min(idx, prev.cells.length - 1)]!);
        }
        return;
      }
      if (ke.key === 'ArrowLeft' && caretAtStartOfCell(cell)) {
        e.preventDefault();
        moveCell(cell, -1);
        return;
      }
      if (ke.key === 'ArrowRight' && caretAtEndOfCell(cell)) {
        e.preventDefault();
        moveCell(cell, 1);
        return;
      }
    });
    tbl.addEventListener('input', () => markDirty());

    // Right-click on a cell opens the row/column context menu.
    tbl.addEventListener('contextmenu', (e) => {
      const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null;
      if (!cell) return;
      e.preventDefault();
      showTableContextMenu(tbl, cell, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    });

    ensureTableEdgeButtons(wrap);
    ensureResizeHandles(tbl);
  }

  function moveCell(cell: HTMLTableCellElement, dir: 1 | -1): void {
    const tr = cell.parentElement as HTMLTableRowElement;
    const cells = Array.from(tr.cells);
    const idx = cells.indexOf(cell);
    const nextIdx = idx + dir;
    if (nextIdx >= 0 && nextIdx < cells.length) {
      focusCell(cells[nextIdx]!);
      return;
    }
    if (dir === 1) {
      const nextRow = tr.nextElementSibling as HTMLTableRowElement | null;
      if (nextRow) focusCell(nextRow.cells[0]!);
      else { addRowAfter(tr); const nr = tr.nextElementSibling as HTMLTableRowElement; if (nr) focusCell(nr.cells[0]!); }
    } else {
      const prevRow = tr.previousElementSibling as HTMLTableRowElement | null;
      if (prevRow) focusCell(prevRow.cells[prevRow.cells.length - 1]!);
    }
  }

  function moveDown(cell: HTMLTableCellElement): void {
    const tr = cell.parentElement as HTMLTableRowElement;
    const idx = Array.from(tr.cells).indexOf(cell);
    const nextRow = tr.nextElementSibling as HTMLTableRowElement | null;
    if (nextRow) focusCell(nextRow.cells[idx]!);
  }

  // ── Caret position helpers used by arrow-key navigation ────────────

  function caretAtStartOfCell(cell: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    const probe = document.createRange();
    probe.selectNodeContents(cell);
    probe.setEnd(r.startContainer, r.startOffset);
    return probe.toString() === '';
  }

  function caretAtEndOfCell(cell: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    const probe = document.createRange();
    probe.selectNodeContents(cell);
    probe.setStart(r.startContainer, r.startOffset);
    return probe.toString() === '';
  }

  function caretOnTopLine(cell: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    const caretRect = r.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    // height==0 means the caret is in an empty / collapsed text node;
    // treat that as "top line" so the user can still escape upward.
    if (caretRect.height === 0) return true;
    const lh = caretRect.height || parseFloat(getComputedStyle(cell).lineHeight) || 20;
    return caretRect.top - cellRect.top < lh;
  }

  function caretOnBottomLine(cell: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    const caretRect = r.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    if (caretRect.height === 0) return true;
    const lh = caretRect.height || parseFloat(getComputedStyle(cell).lineHeight) || 20;
    return cellRect.bottom - caretRect.bottom < lh;
  }

  // ── Row / column mutation helpers ──────────────────────────────────

  function colCountOf(tbl: HTMLTableElement): number {
    return tbl.rows[0]?.cells.length ?? 0;
  }

  function makeEmptyCell(): HTMLTableCellElement {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    td.appendChild(document.createElement('br'));
    return td;
  }

  function addRowAfter(tr: HTMLTableRowElement): void {
    const cols = tr.cells.length;
    const newTr = document.createElement('tr');
    for (let i = 0; i < cols; i++) newTr.appendChild(makeEmptyCell());
    tr.parentElement!.insertBefore(newTr, tr.nextSibling);
    const tbl = tr.closest('table.ne-table') as HTMLTableElement | null;
    if (tbl) ensureResizeHandles(tbl);
    markDirty();
  }

  /** Insert a fresh row at the given 0-based index (clamped). atIdx ==
   *  tbl.rows.length appends at end. */
  function insertRowAt(tbl: HTMLTableElement, atIdx: number): void {
    const tbody = tbl.tBodies[0] ?? tbl;
    const cols = colCountOf(tbl) || 1;
    const newTr = document.createElement('tr');
    for (let i = 0; i < cols; i++) newTr.appendChild(makeEmptyCell());
    if (atIdx >= tbody.rows.length) tbody.appendChild(newTr);
    else tbody.insertBefore(newTr, tbody.rows[atIdx] as Node);
    ensureResizeHandles(tbl);
    markDirty();
  }

  function insertColAt(tbl: HTMLTableElement, atIdx: number): void {
    for (const tr of Array.from(tbl.rows)) {
      const td = makeEmptyCell();
      if (atIdx >= tr.cells.length) tr.appendChild(td);
      else tr.insertBefore(td, tr.cells[atIdx] as Node);
    }
    // Insert matching <col> so column widths line up.
    const cg = ensureColgroup(tbl);
    const newCol = document.createElement('col');
    if (atIdx >= cg.children.length) cg.appendChild(newCol);
    else cg.insertBefore(newCol, cg.children[atIdx] as Node);
    ensureResizeHandles(tbl);
    markDirty();
  }

  function deleteRowAt(tbl: HTMLTableElement, rowIdx: number): void {
    const tbody = tbl.tBodies[0] ?? tbl;
    if (tbody.rows.length <= 1) return; // keep at least 1 row
    if (rowIdx < 0 || rowIdx >= tbody.rows.length) return;
    tbody.rows[rowIdx]!.remove();
    markDirty();
  }

  function deleteColAt(tbl: HTMLTableElement, colIdx: number): void {
    if (colCountOf(tbl) <= 1) return; // keep at least 1 column
    for (const tr of Array.from(tbl.rows)) {
      if (colIdx >= 0 && colIdx < tr.cells.length) tr.cells[colIdx]!.remove();
    }
    // Remove matching <col> so colgroup stays in sync.
    const cg = ensureColgroup(tbl);
    if (cg.children[colIdx]) cg.children[colIdx]!.remove();
    ensureResizeHandles(tbl);
    markDirty();
  }

  function focusCell(cell: HTMLTableCellElement): void {
    cell.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(cell);
    r.collapse(true);
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  }

  // ── Edge "+" buttons (hover to grow the table) ─────────────────────

  function ensureTableEdgeButtons(wrap: HTMLElement): void {
    const tbl = wrap.querySelector('table.ne-table') as HTMLTableElement | null;
    if (!tbl) return;
    if (!wrap.querySelector('.ne-table-add-row')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ne-table-add ne-table-add-row';
      btn.title = '行を追加';
      btn.textContent = '+';
      btn.contentEditable = 'false';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        insertRowAt(tbl, tbl.rows.length);
      });
      wrap.appendChild(btn);
    }
    if (!wrap.querySelector('.ne-table-add-col')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ne-table-add ne-table-add-col';
      btn.title = '列を追加';
      btn.textContent = '+';
      btn.contentEditable = 'false';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        insertColAt(tbl, colCountOf(tbl));
      });
      wrap.appendChild(btn);
    }
  }

  // ── Column resize ──────────────────────────────────────────────────

  /** Ensure `<colgroup>` exists with one `<col>` per column. Called on
   *  load (for legacy markdown tables without explicit colgroups) and
   *  after any column add / delete so the col count stays in sync with
   *  the actual cell count. */
  function ensureColgroup(tbl: HTMLTableElement): HTMLTableColElement {
    let cg = tbl.querySelector('colgroup');
    const cellCount = colCountOf(tbl);
    if (!cg) {
      cg = document.createElement('colgroup');
      for (let i = 0; i < cellCount; i++) cg.appendChild(document.createElement('col'));
      tbl.insertBefore(cg, tbl.firstChild);
    } else {
      // Reconcile cardinality if it drifted.
      while (cg.children.length < cellCount) cg.appendChild(document.createElement('col'));
      while (cg.children.length > cellCount) cg.lastElementChild!.remove();
    }
    return cg as HTMLTableColElement;
  }

  /** Attach a 6px-wide draggable resize handle on the right edge of each
   *  cell. The handle is contenteditable=false + an absolutely positioned
   *  child of the cell, so it doesn't get caught up in the cell's text
   *  editing. The cursor flips to col-resize on hover. */
  function ensureResizeHandles(tbl: HTMLTableElement): void {
    ensureColgroup(tbl);
    for (const tr of Array.from(tbl.rows)) {
      // Skip the last cell in each row — resizing it doesn't have a
      // natural neighbor to take the space from.
      for (let i = 0; i < tr.cells.length - 1; i++) {
        const cell = tr.cells[i] as HTMLElement;
        if (cell.querySelector(':scope > .ne-table-resize')) continue;
        cell.style.position = cell.style.position || 'relative';
        const handle = document.createElement('span');
        handle.className = 'ne-table-resize';
        handle.contentEditable = 'false';
        handle.setAttribute('aria-hidden', 'true');
        wireResizeHandle(handle, tbl, i);
        cell.appendChild(handle);
      }
    }
  }

  function wireResizeHandle(
    handle: HTMLElement,
    tbl: HTMLTableElement,
    colIdx: number,
  ): void {
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cg = ensureColgroup(tbl);
      const cols = Array.from(cg.children) as HTMLTableColElement[];
      const col = cols[colIdx];
      if (!col) return;
      // Lock every other col's width to its current rendered size so
      // the table doesn't reflow when we change the active column.
      cols.forEach((c, idx) => {
        if (idx === colIdx) return;
        if (!c.style.width) {
          const refCell = tbl.rows[0]?.cells[idx];
          if (refCell) c.style.width = `${Math.round(refCell.getBoundingClientRect().width)}px`;
        }
      });
      const startX = e.clientX;
      const refCell = tbl.rows[0]?.cells[colIdx];
      const startW = refCell ? refCell.getBoundingClientRect().width : 100;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('dragging');

      const onMove = (ev: MouseEvent): void => {
        const dx = ev.clientX - startX;
        const newW = Math.max(40, Math.round(startW + dx));
        col.style.width = `${newW}px`;
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        handle.classList.remove('dragging');
        markDirty();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click resets the column to auto width.
    handle.addEventListener('dblclick', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const cg = ensureColgroup(tbl);
      const col = cg.children[colIdx] as HTMLTableColElement | undefined;
      if (col) col.style.width = '';
      markDirty();
    });
  }

  // ── Right-click context menu (row / col ops) ───────────────────────

  function showTableContextMenu(
    tbl: HTMLTableElement,
    cell: HTMLTableCellElement,
    clientX: number,
    clientY: number,
  ): void {
    // Close any existing menu so we don't stack them on rapid right-clicks.
    document.querySelectorAll('.ne-table-menu').forEach((n) => n.remove());

    const tr = cell.parentElement as HTMLTableRowElement;
    const rowIdx = Array.from(tbl.tBodies[0]?.rows ?? tbl.rows).indexOf(tr);
    const colIdx = Array.from(tr.cells).indexOf(cell);

    const menu = document.createElement('div');
    menu.className = 'ne-table-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top  = `${clientY}px`;
    menu.contentEditable = 'false';

    const item = (label: string, action: () => void): HTMLElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ne-table-menu-item';
      b.textContent = label;
      b.addEventListener('mousedown', (e) => {
        // mousedown (not click) so the menu fires before the document
        // click handler below tears it down.
        e.preventDefault();
        action();
        menu.remove();
      });
      return b;
    };
    const sep = (): HTMLElement => {
      const d = document.createElement('div');
      d.className = 'ne-table-menu-sep';
      return d;
    };

    menu.append(
      item('↑ 上に行を挿入',   () => insertRowAt(tbl, rowIdx)),
      item('↓ 下に行を挿入',   () => insertRowAt(tbl, rowIdx + 1)),
      sep(),
      item('← 左に列を挿入',   () => insertColAt(tbl, colIdx)),
      item('→ 右に列を挿入',   () => insertColAt(tbl, colIdx + 1)),
      sep(),
      item('🗑 行を削除',      () => deleteRowAt(tbl, rowIdx)),
      item('🗑 列を削除',      () => deleteColAt(tbl, colIdx)),
    );

    // Position into floating container (same stacking context as
    // slash menu / floating toolbar — punches through host overlays).
    const floatRoot = opts.floatingContainer ?? document.body;
    floatRoot.appendChild(menu);

    // Clamp inside the viewport so the menu isn't clipped at the right
    // or bottom edge.
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
      if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;
    });

    // Close on outside click / Escape.
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', close);
    }, 0);
  }

  function insertTableBlock(cols: number, rows: number): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const tbl = buildTable(cols, rows);
    const block = curBlock();
    if (block && block !== ed) {
      block.parentNode!.insertBefore(tbl, block.nextSibling);
      if ((block.textContent || '').trim() === '') block.remove();
    } else {
      sel.getRangeAt(0).insertNode(tbl);
    }
    const firstTd = tbl.querySelector('td');
    if (firstTd) focusCell(firstTd as HTMLTableCellElement);
  }

  // ─── execCmd (toolbar / shortcuts) ──────────────────────────────────

  function execCmd(cmd: string): void {
    ed.focus();
    const sel = window.getSelection();
    switch (cmd) {
      case 'h1': case 'h2': case 'h3': {
        const block = curBlock();
        if (!block || block === ed) break;
        const blockTag = block.tagName.toLowerCase();
        // Toggle: if already this heading, revert to <p>.
        const target = blockTag === cmd ? 'p' : cmd;
        setBlockTag(block, target);
        break;
      }
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'strike': document.execCommand('strikeThrough'); break;
      case 'code': {
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          const codeAnc = findAncestor(r.startContainer, 'code');
          if (codeAnc && codeAnc !== ed) {
            const parent = codeAnc.parentNode;
            if (parent) {
              while (codeAnc.firstChild) parent.insertBefore(codeAnc.firstChild, codeAnc);
              parent.removeChild(codeAnc);
              parent.normalize?.();
            }
            break;
          }
          if (!sel.isCollapsed) {
            const t = r.toString();
            r.deleteContents();
            const c = document.createElement('code');
            c.textContent = t;
            r.insertNode(c);
            const rng = document.createRange();
            rng.setStartAfter(c); rng.collapse(true);
            sel.removeAllRanges(); sel.addRange(rng);
          }
        }
        break;
      }
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'quote': {
        if (sel && sel.rangeCount) {
          const bq = findAncestor(sel.getRangeAt(0).startContainer, 'blockquote');
          if (bq) { unwrapToP(bq, false); markDirty(); return; }
        }
        document.execCommand('formatBlock', false, 'blockquote');
        break;
      }
      case 'pre': {
        if (sel && sel.rangeCount) {
          const pre = findAncestor(sel.getRangeAt(0).startContainer, 'pre');
          if (pre) { unwrapPre(pre); markDirty(); return; }
        }
        document.execCommand('formatBlock', false, 'pre');
        break;
      }
      case 'hr': document.execCommand('insertHTML', false, '<hr>'); break;
      case 'todo': {
        if (sel && sel.rangeCount) {
          const td = findAncestor(sel.getRangeAt(0).startContainer, '.ne-todo');
          if (td) { unwrapTodo(td); markDirty(); return; }
        }
        insertTodoBlock();
        return;
      }
      case 'callout': {
        if (sel && sel.rangeCount) {
          const ca = findCallout(sel.getRangeAt(0).startContainer);
          if (ca) { unwrapCallout(ca); markDirty(); return; }
        }
        insertCalloutBlock();
        return;
      }
    }
  }

  // ─── Floating toolbar buttons ───────────────────────────────────────

  ftb.querySelectorAll<HTMLElement>('.ne-ftb-b').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = b.dataset.cmd!;
      execCmd(cmd);
      markDirty();
    });
  });

  // ─── Image paste / drop (base64) ────────────────────────────────────

  function insertImageAtCursor(dataUrl: string, alt: string): void {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = alt;
    img.className = 'ne-img';
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      sel.getRangeAt(0).insertNode(img);
      sel.collapseToEnd();
    } else {
      ed.appendChild(img);
    }
    markDirty();
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  ed.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.kind !== 'file') continue;
      const file = it.getAsFile();
      if (!file) continue;
      if (it.type.startsWith('image/')) {
        e.preventDefault();
        try {
          const url = await fileToDataUrl(file);
          insertImageAtCursor(url, file.name);
        } catch { /* swallow */ }
        return;
      }
      // Non-image file → route through host upload hook if provided.
      if (opts.onFileUpload) {
        e.preventDefault();
        await handleFileUpload(file);
        return;
      }
    }
  });

  ed.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    const files = Array.from(e.dataTransfer.files);
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (imgs.length === 0 && (others.length === 0 || !opts.onFileUpload)) return;
    e.preventDefault();
    // Images inline as base64 (same as before).
    for (const f of imgs) {
      try {
        const url = await fileToDataUrl(f);
        insertImageAtCursor(url, f.name);
      } catch { /* swallow */ }
    }
    // Non-image files go through the host's upload pipeline (sequential
    // so each chip lands in caret order).
    if (opts.onFileUpload) {
      for (const f of others) {
        await handleFileUpload(f);
      }
    }
  });

  // ─── Block drag handle (viewport-positioned) ────────────────────────

  function topBlockOf(node: Node | null): HTMLElement | null {
    let n: Node | null = node;
    while (n && n.parentNode !== ed) n = n.parentNode;
    return n && n.nodeType === 1 ? (n as HTMLElement) : null;
  }

  /** Block whose drag handle should currently be visible. Mouse hover wins
   *  over caret position (cursor-driven feel matches Notion); falls back to
   *  caret block when nothing is hovered. */
  function effectiveHandleBlock(): HTMLElement | null {
    return state.hoverBlock ?? state.caretBlock;
  }

  function positionHandleAt(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const handleH = 20;
    handle.style.top = (rect.top + Math.max(0, (rect.height - handleH) / 2)) + 'px';
    handle.style.left = (rect.left - 22) + 'px';
    handle.style.height = handleH + 'px';
    handle.style.display = 'flex';
  }

  function refreshHandle(): void {
    const b = effectiveHandleBlock();
    if (b && ed.contains(b)) positionHandleAt(b);
    else handle.style.display = 'none';
  }

  ed.addEventListener('mousemove', (e) => {
    const target = e.target as HTMLElement;
    const block = topBlockOf(target);
    state.hoverBlock = block;
    refreshHandle();
  });

  // Cursor traveling between the editor block and the handle passes through
  // a ~22px gap that's neither inside `ed` nor `handle`. A naive
  // `if (!ed.contains(t) && !handle.contains(t)) hide()` flickers the
  // handle off mid-travel. Use a geometric hit zone instead: ed's bbox
  // extended ~40px to the left counts as "still hovering". Once the cursor
  // leaves both ed's extended zone AND the handle, we drop hoverBlock and
  // fall back to caretBlock (or hide if there's no caret).
  const onDocMouseMove = (e: MouseEvent): void => {
    const r = ed.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    const inExtendedEd =
      e.clientX >= r.left - 44 && e.clientX <= r.right &&
      e.clientY >= r.top - 4   && e.clientY <= r.bottom + 4;
    const inHandle =
      handle.style.display !== 'none' &&
      e.clientX >= hr.left - 4 && e.clientX <= hr.right + 4 &&
      e.clientY >= hr.top - 4  && e.clientY <= hr.bottom + 4;
    if (inExtendedEd || inHandle) return;
    if (state.hoverBlock) {
      state.hoverBlock = null;
      refreshHandle();
    }
  };
  document.addEventListener('mousemove', onDocMouseMove);

  handle.addEventListener('dragstart', (e) => {
    const src = effectiveHandleBlock();
    if (!src) { e.preventDefault(); return; }
    state.dragSrc = src;
    src.classList.add('ne-block-dragging');
    e.dataTransfer?.setData('text/plain', '');
    e.dataTransfer!.effectAllowed = 'move';
  });
  handle.addEventListener('dragend', () => {
    state.dragSrc?.classList.remove('ne-block-dragging');
    state.dragSrc = null;
    ed.querySelectorAll('.ne-drop-line').forEach((n) => n.remove());
  });

  ed.addEventListener('dragover', (e) => {
    if (!state.dragSrc) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const target = topBlockOf(e.target as Node);
    if (!target || target === state.dragSrc) return;
    const r = target.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    ed.querySelectorAll('.ne-drop-line').forEach((n) => n.remove());
    const line = document.createElement('div');
    line.className = 'ne-drop-line';
    target.parentNode!.insertBefore(line, before ? target : target.nextSibling);
  });
  ed.addEventListener('drop', (e) => {
    if (!state.dragSrc) return;
    e.preventDefault();
    const line = ed.querySelector('.ne-drop-line');
    if (line) {
      line.parentNode!.insertBefore(state.dragSrc, line);
      line.remove();
      markDirty();
    }
  });

  // ─── Input / keydown ────────────────────────────────────────────────

  /** Ensure the editor always has at least a `<p><br></p>` so the caret
   *  has somewhere to live. Backspacing the entire content can leave `ed`
   *  with no children (or with a leftover empty `<p></p>` containing nothing
   *  — neither state accepts a caret on most browsers, making the editor
   *  appear "frozen"). */
  function ensureNonEmpty(): boolean {
    if (ed.children.length === 0) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      ed.appendChild(p);
      placeCaretAtStart(p);
      return true;
    }
    // If the only child is an empty paragraph (no text + no <br>), inject a
    // <br> so it's focusable. This happens after a select-all + delete in
    // some browsers.
    const only = ed.children.length === 1 ? (ed.firstElementChild as HTMLElement) : null;
    if (only && /^(P|DIV)$/.test(only.tagName) && only.childNodes.length === 0) {
      only.appendChild(document.createElement('br'));
      placeCaretAtStart(only);
      return true;
    }
    return false;
  }

  ed.addEventListener('input', () => {
    ensureNonEmpty();
    markDirty();
    refreshEmptyState();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType === 3) {
      const txt = node.textContent || '';
      const before = txt.substring(0, range.startOffset);
      // Trigger slash menu when `/` is at the start of the text, OR after
      // whitespace, OR after a non-ASCII character (e.g. Japanese / CJK /
      // emoji). The non-ASCII allowance is important — without it, typing
      // `あいう/` doesn't open the menu because `/` is sitting right after
      // a Japanese character. URL-like contexts (`https://`, `path/sub`)
      // stay excluded because their preceding char is ASCII (`:`, `t`, `/`)
      // and not whitespace.
      const slashMatch = before.match(/(^|\s|[^\x00-\x7F])\/(\S*)$/);
      if (slashMatch) {
        state.slashActive = true;
        state.slashQuery = slashMatch[2] || '';
        state.slashSel = 0;
        state.slashNode = node;
        const rect = range.getBoundingClientRect();
        showSlashMenu(rect);
        return;
      }
    }
    if (state.slashActive) closeSlashMenu();
  });

  ed.addEventListener('keydown', (e) => {
    if (e.isComposing || (e as KeyboardEvent).keyCode === 229) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      opts.onSubmit?.();
      return;
    }
    if (e.key === 'Escape' && !state.slashActive) {
      opts.onCancel?.();
      return;
    }

    if (state.slashActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.slashSel = (state.slashSel + 1) % state.slashFiltered.length;
        const sel0 = window.getSelection();
        const rect = sel0 && sel0.rangeCount ? sel0.getRangeAt(0).getBoundingClientRect() : { bottom: 0, left: 0, top: 0 } as DOMRect;
        showSlashMenu(rect); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.slashSel = (state.slashSel - 1 + state.slashFiltered.length) % state.slashFiltered.length;
        const sel0 = window.getSelection();
        const rect = sel0 && sel0.rangeCount ? sel0.getRangeAt(0).getBoundingClientRect() : { bottom: 0, left: 0, top: 0 } as DOMRect;
        showSlashMenu(rect); return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = state.slashFiltered[state.slashSel];
        if (item) applySlashCmd(item.cmd);
        return;
      }
      if (e.key === 'Escape') { closeSlashMenu(); return; }
    }

    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const startNode = range.startContainer;

        const callout = findCallout(startNode);
        if (callout && isAtCalloutStart(range, callout)) {
          e.preventDefault(); unwrapCallout(callout); markDirty(); return;
        }
        const todo = findAncestor(startNode, '.ne-todo');
        if (todo && isAtBlockStart(range, todo)) {
          e.preventDefault(); unwrapTodo(todo); markDirty(); return;
        }
        const pre = findAncestor(startNode, 'pre');
        if (pre && isAtBlockStart(range, pre)) {
          e.preventDefault(); unwrapPre(pre); markDirty(); return;
        }
        const bq = findAncestor(startNode, 'blockquote');
        if (bq && isAtBlockStart(range, bq)) {
          e.preventDefault(); unwrapToP(bq, false); markDirty(); return;
        }
        const cb = curBlock();
        if (cb && cb !== ed && isAtBlockStart(range, cb)) {
          const prev = cb.previousElementSibling;
          if (prev && prev.tagName === 'HR') { e.preventDefault(); prev.remove(); markDirty(); return; }
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const td = findAncestor(range.startContainer, '.ne-todo');
        if (td) {
          e.preventDefault();
          const txt = td.querySelector('.ne-todo-txt');
          const isEmpty = !txt || !(txt.textContent || '').trim();
          if (isEmpty) {
            const np = document.createElement('p');
            np.appendChild(document.createElement('br'));
            td.parentNode!.insertBefore(np, td.nextSibling);
            td.remove();
            placeCaretAtStart(np);
          } else {
            const newTodo = document.createElement('div');
            newTodo.className = 'ne-todo';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'ne-todo-cb';
            const sp = document.createElement('span');
            sp.className = 'ne-todo-txt';
            sp.appendChild(document.createElement('br'));
            newTodo.appendChild(cb); newTodo.appendChild(sp);
            td.parentNode!.insertBefore(newTodo, td.nextSibling);
            placeCaretAtStart(sp);
          }
          markDirty(); return;
        }

        const bq = findAncestor(range.startContainer, 'blockquote');
        if (bq) {
          e.preventDefault();
          const np = document.createElement('p');
          np.appendChild(document.createElement('br'));
          bq.parentNode!.insertBefore(np, bq.nextSibling);
          placeCaretAtStart(np);
          markDirty(); return;
        }

        const callout = findCallout(range.startContainer);
        if (callout) {
          const body = callout.querySelector('.ne-callout-body');
          const last = body?.lastElementChild as HTMLElement | null;
          if (body && last) {
            const inLast = last === range.startContainer || last.contains(range.startContainer);
            const lastEmpty = !last.textContent || !last.textContent.trim();
            if (inLast && lastEmpty) {
              e.preventDefault();
              last.remove();
              if (!body.firstChild) {
                const refill = document.createElement('p');
                refill.appendChild(document.createElement('br'));
                body.appendChild(refill);
              }
              const np = document.createElement('p');
              np.appendChild(document.createElement('br'));
              callout.parentNode!.insertBefore(np, callout.nextSibling);
              placeCaretAtStart(np);
              markDirty(); return;
            }
          }
        }
      }
    }

    const block = curBlock();
    if (e.key === 'Enter' && block && block.tagName === 'PRE') {
      e.preventDefault();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      flattenBrToNewline(block);
      const fullText = block.textContent || '';
      const wantExit = e.metaKey || e.ctrlKey || fullText.endsWith('\n\n');
      if (wantExit && fullText.length > 0) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let lastTxt: Text | null = null;
        let n: Node | null;
        while ((n = walker.nextNode())) lastTxt = n as Text;
        while (lastTxt && lastTxt.textContent && lastTxt.textContent.endsWith('\n')) {
          lastTxt.textContent = lastTxt.textContent.replace(/\n+$/, '');
          if (lastTxt.textContent) break;
          const prev = lastTxt.previousSibling;
          lastTxt.remove();
          lastTxt = prev && prev.nodeType === 3 ? (prev as Text) : null;
        }
        const np = document.createElement('p');
        np.appendChild(document.createElement('br'));
        block.parentNode!.insertBefore(np, block.nextSibling);
        placeCaretAtStart(np);
        markDirty(); return;
      }
      const atEnd = isAtBlockEnd(range, block);
      insertTextAtCursor(atEnd ? '\n\n' : '\n');
      if (atEnd) {
        const s2 = window.getSelection();
        if (s2 && s2.rangeCount) {
          const r2 = s2.getRangeAt(0);
          if (r2.startContainer.nodeType === 3 && r2.startOffset > 0) {
            const newR = document.createRange();
            newR.setStart(r2.startContainer, r2.startOffset - 1); newR.collapse(true);
            s2.removeAllRanges(); s2.addRange(newR);
          }
        }
      }
    }
    if (e.key === 'Tab' && block && block.tagName === 'PRE') {
      e.preventDefault();
      insertTextAtCursor('  ');
    }
  });

  // Todo checkbox click — sync the `checked` attribute (innerHTML serializes attrs)
  ed.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('ne-todo-cb')) {
      const cb = target as HTMLInputElement;
      if (cb.checked) cb.setAttribute('checked', 'checked');
      else cb.removeAttribute('checked');
      const txt = cb.nextElementSibling;
      if (txt && txt.classList.contains('ne-todo-txt')) {
        txt.classList.toggle('done', cb.checked);
        markDirty();
      }
    }
    // File chip — suppress single-click navigation inside the editor so
    // the user doesn't accidentally leave the page while trying to
    // position the caret next to a chip. Opening is reserved for
    // double-click (handled below).
    const fileChip = target.closest('a.ne-file');
    if (fileChip) e.preventDefault();
  });

  // File chip double-click → open the file in a new tab. Without the
  // `download` attribute SharePoint serves Office files via Office
  // Online (Excel / Word / PowerPoint web viewer), PDF via browser
  // preview, and falls back to download only for binary types.
  ed.addEventListener('dblclick', (e) => {
    const target = (e.target as Element | null)?.closest('a.ne-file') as HTMLAnchorElement | null;
    if (!target) return;
    e.preventDefault();
    const href = target.getAttribute('href') ?? '';
    if (!href) return;
    // Defensive: ensure Office URLs go through the viewer even if the
    // chip's href somehow wasn't rewritten (e.g. legacy memos saved
    // before the rewrite landed). toOfficeViewerUrl is idempotent.
    const filename = target.querySelector('.ne-file-name')?.textContent ?? '';
    window.open(toOfficeViewerUrl(href, filename), '_blank', 'noopener,noreferrer');
  });

  // ── Append-on-focus: when the editor gains focus, ensure the user can
  // immediately start typing on a fresh trailing line.
  //   - If the last block already has no text, just put the caret there.
  //   - Otherwise, append a fresh <p><br></p> and park the caret in it.
  // The appended block does NOT mark the editor dirty — the host's
  // autosave only fires when content actually changes (compared by
  // markdown). If the user blurs without typing, we delete the
  // throwaway block (tracked by `appendedTrailingP`).

  let appendedTrailingP: HTMLParagraphElement | null = null;

  function isBlockEmpty(b: HTMLElement | null): boolean {
    if (!b) return true;
    if ((b.textContent ?? '').trim() !== '') return false;
    // Don't treat blocks containing media (img/canvas/etc) as empty even
    // without text — they have visible content.
    return !b.querySelector('img,canvas,svg,input,table');
  }

  ed.addEventListener('focus', () => {
    const last = ed.lastElementChild as HTMLElement | null;
    if (!last) {
      // shouldn't really happen — ensureNonEmpty guarantees at least one
      // block, but be defensive.
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      ed.appendChild(p);
      placeCaretAtStart(p);
      return;
    }
    if (isBlockEmpty(last)) {
      // Already an empty trailing line — caret will land naturally; no
      // need to remember it as a throwaway.
      return;
    }
    // Add a throwaway empty line and park caret in it. We *don't*
    // markDirty: until the user types something, this addition is
    // invisible to autosave (htmlToMarkdown trims trailing whitespace
    // anyway, so even if save fires it's a no-op).
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    ed.appendChild(p);
    appendedTrailingP = p;
    // setTimeout so the caret survives whatever the browser was about
    // to do with the focus event.
    setTimeout(() => { if (appendedTrailingP === p) placeCaretAtStart(p); }, 0);
  });

  // If the user actually edits, the throwaway block is no longer
  // throwaway — clear the tracker.
  ed.addEventListener('input', () => {
    if (appendedTrailingP && (appendedTrailingP.textContent ?? '').trim() !== '') {
      appendedTrailingP = null;
    }
  });

  // On blur, remove the trailing throwaway if it's still pristine.
  ed.addEventListener('blur', () => {
    if (appendedTrailingP && isBlockEmpty(appendedTrailingP) && appendedTrailingP.parentElement === ed) {
      appendedTrailingP.remove();
      ensureNonEmpty();
    }
    appendedTrailingP = null;
  });

  // Floating selection toolbar + caret-driven handle tracking
  const onSelectionChange = (): void => {
    const sel = window.getSelection();

    // Caret block tracking — feeds the drag handle so the handle follows
    // the active line even when the mouse isn't moving. Mouse hover still
    // wins (effectiveHandleBlock).
    if (sel && sel.rangeCount) {
      const range0 = sel.getRangeAt(0);
      const startNode = range0.startContainer;
      if (ed.contains(startNode)) {
        const block = topBlockOf(startNode);
        if (block !== state.caretBlock) {
          state.caretBlock = block;
          refreshHandle();
        }
      }
    }

    // Floating toolbar — only shown for non-collapsed selections inside ed.
    if (!sel || sel.isCollapsed || !sel.rangeCount) { ftb.classList.remove('on'); return; }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const node = container.nodeType === 3 ? container.parentNode : container;
    if (!node || !ed.contains(node)) { ftb.classList.remove('on'); return; }
    if (state.slashActive) { ftb.classList.remove('on'); return; }
    const rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) { ftb.classList.remove('on'); return; }
    let top = rect.top - 40;
    const left = rect.left + rect.width / 2;
    if (top < 4) top = rect.bottom + 4;
    ftb.style.top = top + 'px';
    ftb.style.left = left + 'px';
    ftb.classList.add('on');
  };
  document.addEventListener('selectionchange', onSelectionChange);

  // When focus leaves the editor, drop the caret block so the handle
  // doesn't linger on a no-longer-active editor instance (matters when
  // multiple note cards mount editors side-by-side).
  ed.addEventListener('blur', () => {
    state.caretBlock = null;
    refreshHandle();
  });

  // Re-attach handlers for tables loaded via setMarkdown
  function rewireTables(): void {
    root.querySelectorAll<HTMLElement>('.ne-table-wrap').forEach((w) => {
      // Markdown-imported tables don't have contentEditable=false on the wrap;
      // also their <td>'s aren't contentEditable=true yet.
      w.contentEditable = 'false';
      w.querySelectorAll('td,th').forEach((c) => {
        (c as HTMLElement).contentEditable = 'true';
        if (!c.firstChild) c.appendChild(document.createElement('br'));
      });
      attachTableHandlers(w);
    });
  }
  rewireTables();

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    detachObserver?.disconnect();
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('mousemove', onDocMouseMove);
    slashMenu.remove();
    ftb.remove();
    handle.remove();
    root.remove();
  }

  // Auto-destroy when root gets detached from the document. Hosts that
  // re-render via wholesale DOM swaps (no explicit destroy() call) would
  // otherwise leak the floating widgets and document-level listeners.
  //
  // We can't fire on the first "not connected" reading because root is
  // freshly-constructed and the host hasn't mounted it yet. Track the
  // edge: once we've seen the root attached, a subsequent detach is real
  // and triggers cleanup.
  let detachObserver: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    let wasConnected = false;
    detachObserver = new MutationObserver(() => {
      if (root.isConnected) {
        wasConnected = true;
      } else if (wasConnected) {
        destroy();
      }
    });
    detachObserver.observe(document.body, { childList: true, subtree: true });
  }

  return {
    root,
    getMarkdown(): string {
      return htmlToMarkdown(ed.innerHTML);
    },
    setMarkdown(md: string): void {
      ed.innerHTML = md ? ensureBlockWrapped(markdownToHtml(md)) : '<p><br></p>';
      rewireTables();
      ensureNonEmpty();
      refreshEmptyState();
    },
    focus(): void {
      ed.focus();
      const sel = window.getSelection();
      const last = ed.lastElementChild as HTMLElement | null;
      if (last && sel) {
        const r = document.createRange();
        r.selectNodeContents(last); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      }
    },
    destroy,
  };
}
