// Column resize helper.
// Apply to a <table> with a <colgroup>. Each `<col>` width is bound to a key
// and persisted to localStorage so widths survive across re-renders/sessions.

interface ResizeOptions {
  tableKey: string;       // e.g. 'tickets', 'inbox'
  colKeys: (string | null)[]; // null = no resize handle for that column (e.g. last column)
  minWidth?: number;
}

const STORAGE_PREFIX = 'spira:colw:';

export function attachColumnResize(table: HTMLTableElement, opts: ResizeOptions): void {
  const colgroup = table.querySelector('colgroup');
  const cols = colgroup ? Array.from(colgroup.querySelectorAll<HTMLTableColElement>('col')) : [];
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead > tr > th'));
  const minWidth = opts.minWidth ?? 40;

  // Restore widths from storage.
  opts.colKeys.forEach((key, i) => {
    if (!key) return;
    const saved = readWidth(opts.tableKey, key);
    const col = cols[i];
    if (saved && col) col.style.width = `${saved}px`;
  });

  // Attach resize handle to each th except where colKeys[i] is null.
  ths.forEach((th, i) => {
    const key = opts.colKeys[i];
    if (!key) return;
    th.style.position = 'relative';

    const handle = document.createElement('span');
    handle.className = 'spira-col-resize';
    handle.setAttribute('aria-hidden', 'true');
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const col = cols[i];
      // Lock all sibling cols to their current rendered widths so they don't
      // redistribute when the active col grows/shrinks.
      cols.forEach((c, ci) => {
        if (ci === i) return;
        if (!c.style.width) {
          const sibTh = ths[ci] as HTMLElement | undefined;
          if (sibTh) c.style.width = `${Math.round(sibTh.getBoundingClientRect().width)}px`;
        }
      });
      const startWidth = (th as HTMLElement).getBoundingClientRect().width;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('dragging');

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const newW = Math.max(minWidth, Math.round(startWidth + dx));
        if (col) col.style.width = `${newW}px`;
        else (th as HTMLElement).style.width = `${newW}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        handle.classList.remove('dragging');
        const final = Math.round((th as HTMLElement).getBoundingClientRect().width);
        writeWidth(opts.tableKey, key, final);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click to reset to auto width
    handle.addEventListener('dblclick', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const col = cols[i];
      if (col) col.style.width = '';
      removeWidth(opts.tableKey, key);
    });
  });
}

function readWidth(tableKey: string, colKey: string): number | null {
  try {
    const v = localStorage.getItem(`${STORAGE_PREFIX}${tableKey}:${colKey}`);
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
function writeWidth(tableKey: string, colKey: string, w: number): void {
  try { localStorage.setItem(`${STORAGE_PREFIX}${tableKey}:${colKey}`, String(w)); }
  catch { /* ignore */ }
}
function removeWidth(tableKey: string, colKey: string): void {
  try { localStorage.removeItem(`${STORAGE_PREFIX}${tableKey}:${colKey}`); }
  catch { /* ignore */ }
}
