// Public surface of the note-editor package.
//
// Usage:
//   import { createNoteEditor } from '<path>/note-editor';
//   import '<path>/note-editor/editor.css';
//
//   const ed = createNoteEditor({ value: '# Hello', onSubmit: () => save() });
//   container.appendChild(ed.root);
//   ed.focus();
//   // later:
//   const md = ed.getMarkdown();
//   ed.destroy();
//
// For read-only rendering of stored markdown, run it through markdownToHtml,
// then wrap the result in an element with class `ne-prose` (and pipe it
// through your sanitizer of choice — DOMPurify recommended).

export { createNoteEditor } from './editor';
export type { NoteEditor, NoteEditorOptions } from './editor';
export { htmlToMarkdown, markdownToHtml, ensureBlockWrapped } from './markdown';
