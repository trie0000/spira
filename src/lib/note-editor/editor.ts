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

import { htmlToMarkdown, markdownToHtml, ensureBlockWrapped } from './markdown';

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
    } else {
      execCmd(cmd);
    }
    markDirty();
  }

  /** Replace `block`'s tag with `tag`, preserving children and caret. Manual
   *  alternative to `document.execCommand('formatBlock', ...)` which is
   *  flaky on empty blocks (it can retarget the previous block silently). */
  function setBlockTag(block: HTMLElement | null, tag: string): HTMLElement | null {
    if (!block || block === ed) return null;
    if (block.tagName.toLowerCase() === tag) return block;
    const newEl = document.createElement(tag);
    while (block.firstChild) newEl.appendChild(block.firstChild);
    if (!newEl.firstChild) newEl.appendChild(document.createElement('br'));
    block.parentNode!.replaceChild(newEl, block);
    // Park caret at the end of the new block so the user can keep typing.
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(newEl);
      r.collapse(false);
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
    if (wrap.dataset.neWired === '1') return;
    wrap.dataset.neWired = '1';
    const tbl = wrap.querySelector('table.ne-table') as HTMLTableElement | null;
    if (!tbl) return;

    tbl.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isComposing || ke.keyCode === 229) return;
      const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null;
      if (!cell) return;
      if (ke.key === 'Tab') { e.preventDefault(); moveCell(cell, ke.shiftKey ? -1 : 1); return; }
      if (ke.key === 'Enter' && !ke.shiftKey && !ke.metaKey && !ke.ctrlKey) {
        e.preventDefault();
        const tr = cell.parentElement as HTMLTableRowElement;
        const tbody = tr.parentElement;
        if (tbody && tr === tbody.lastElementChild) addRowAfter(tr);
        else moveDown(cell);
        return;
      }
    });
    tbl.addEventListener('input', () => markDirty());
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

  function addRowAfter(tr: HTMLTableRowElement): void {
    const cols = tr.cells.length;
    const newTr = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.appendChild(document.createElement('br'));
      newTr.appendChild(td);
    }
    tr.parentElement!.insertBefore(newTr, tr.nextSibling);
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
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) continue;
        try {
          const url = await fileToDataUrl(file);
          insertImageAtCursor(url, file.name);
        } catch { /* swallow */ }
        return;
      }
    }
  });

  ed.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    e.preventDefault();
    for (const f of imgs) {
      try {
        const url = await fileToDataUrl(f);
        insertImageAtCursor(url, f.name);
      } catch { /* swallow */ }
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
