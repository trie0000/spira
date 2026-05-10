# note-editor

Self-contained Notion-like rich-text editor for Markdown content.
Drop this entire directory into another project and you're done — the only
runtime dependency is the browser DOM.

## Files

| File          | Purpose                                          |
|---------------|--------------------------------------------------|
| `index.ts`    | Public exports (`createNoteEditor`, converters)  |
| `editor.ts`   | Editor implementation                            |
| `markdown.ts` | Markdown ↔ HTML conversion (pure)                |
| `editor.css`  | Drop-in styles, themable via CSS variables       |

No imports outside this directory; no npm dependencies.

## Quick start

```ts
import { createNoteEditor } from './note-editor';
import './note-editor/editor.css';

const ed = createNoteEditor({
  value: '# Hello\n\nType `/` for the slash menu.',
  placeholder: 'メモを書く...',
  onSubmit: () => save(ed.getMarkdown()),
  onCancel: () => close(),
});
container.appendChild(ed.root);
ed.focus();

// Later, when unmounting:
ed.destroy();
```

## Features

- **Slash menu (`/`)**: text · h1-3 · callout · quote · ul · ol · todo · hr ·
  pre · table.
- **Markdown shortcuts in slash query**: `/##` jumps to heading 2,
  `/-` to bullet list, `/>` to quote, `/[]` to todo, `/```\`` to code.
- **Block drag handle**: hover over any block to grab the left-margin grip
  and drag to reorder.
- **Image paste/drop**: clipboard or dropped image files inline as base64
  data URLs (no upload required — host swaps with a real upload if it
  wants by intercepting `paste`/`drop` before this editor's listeners).
- **Inline tables**: 3×2 default. Tab/Shift+Tab navigate cells; Enter
  inside the last row appends a new row.
- **Floating selection toolbar**: bold / italic / strike / inline code.
- **Submit on Cmd/Ctrl+Enter**, **cancel on Escape** — both via callbacks.

## Theming

All colors and metrics are CSS custom properties with sensible defaults.
Override on `.ne-editor` (or any ancestor) using `--ne-override-*`:

```css
.my-app .ne-editor {
  --ne-override-accent: #7a8a78;
  --ne-override-accent-soft: rgba(122, 138, 120, 0.18);
  --ne-override-bg: #fafaf7;
  --ne-override-surface: #f3f1ea;
  --ne-override-text: #2a2a26;
  --ne-override-muted: #7a766c;
  --ne-override-border: rgba(42, 42, 38, 0.12);
  --ne-override-radius: 4px;
  --ne-override-font-size: 13px;
}
```

The same variables also apply to `.ne-slash`, `.ne-ftb`, and
`.ne-drag-handle`, which are floating widgets attached to `document.body`
(so they aren't trapped by host overflow/positioning).

## Read-only rendering

The editor stores Markdown. To display saved notes elsewhere (e.g. a card
view), convert and reuse the same prose styles:

```ts
import DOMPurify from 'dompurify';
import { markdownToHtml, ensureBlockWrapped } from './note-editor';

const html = markdownToHtml(savedMarkdown);
container.className = 'ne-prose';
container.innerHTML = DOMPurify.sanitize(ensureBlockWrapped(html), {
  ADD_ATTR: ['class', 'type', 'checked'],
  ADD_TAGS: ['input'],
});
// Optional: disable checkboxes in read-only mode
container.querySelectorAll('input[type=checkbox]').forEach(cb => cb.disabled = true);
```

The `.ne-prose` class styles the same block types the editor produces
(headings, callouts, todos, tables, etc.) without adding editor chrome.

## API

```ts
interface NoteEditorOptions {
  value?: string;                   // initial markdown
  placeholder?: string;
  onDirty?: () => void;             // any meaningful edit
  onSubmit?: () => void;            // Cmd/Ctrl + Enter
  onCancel?: () => void;            // Escape
  className?: string;               // extra class on the root
}

interface NoteEditor {
  root: HTMLElement;                // mount point
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;                  // detach listeners + remove from DOM
}
```

## What this editor deliberately omits

- No collaboration / OT / CRDT — single-user, local DOM only.
- No persistence — `getMarkdown()` and `setMarkdown()` are pull/push,
  the host owns storage.
- No image upload — pastes inline as base64. If your storage prefers a
  CDN/SP/S3 URL, intercept `paste`/`drop` on `editor.root` before this
  module's listeners run.
- No syntax highlighting in `<pre>` — plain monospace. Bring your own
  Prism / highlight.js if needed.
- No mention/page-link autocomplete — out of scope for a generic editor.
