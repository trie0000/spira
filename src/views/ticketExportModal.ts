// チケット詳細のエクスポートモーダル。
// 対象 (内部/外部スレッド/メモ) + 表示形式 (併記/マージ) + フォーマット
// (Markdown / HTML / PDF / JSON) を選ばせて、Blob → ダウンロードする。

import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { formatTicketTag, formatTicketIdShort } from '../utils/ticketTag';
import { htmlToMarkdown } from '../lib/note-editor';
import { findTag, TAG_COLOR_STYLE } from '../utils/tagDictionary';
import type { Ticket, Comment } from '../types';

type Format = 'md' | 'html' | 'pdf' | 'json';
type Layout = 'parallel' | 'merged';

interface ExportOptions {
  includeInternal: boolean;
  includeExternal: boolean;
  includeNotes: boolean;
  layout: Layout;
  includeMeta: boolean;
  includeSender: boolean;
  includeHtmlRaw: boolean;
  includeAttachments: boolean;
  format: Format;
}

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

// ── 日付フォーマット (JST) ───────────────────────────────────────────
function fmtJst(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeFilename(title: string, ext: string, ticketId: number): string {
  // ファイル名から / \ ? * : | " < > 等を除去、長すぎる場合は切り詰め
  const cleaned = (title || 'ticket')
    .replace(/[\\/?*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const tag = formatTicketIdShort(ticketId).replace('#', '');
  return `spira-${tag}-${cleaned}.${ext}`;
}

// ── ソース別の表示ラベル ────────────────────────────────────────────
function commentSourceLabel(c: Comment): string {
  if (c.source === 'forms') return 'Forms';
  if (c.source === 'teams') return 'Teams';
  if (c.source === 'other') return 'その他';
  return 'メール';
}

function threadKindLabel(c: Comment): string {
  return c.threadKind === 'internal' ? '🏢 内部' : '👥 外部';
}

// ── Markdown 生成 ───────────────────────────────────────────────────
function buildMarkdown(t: Ticket, comments: Comment[], opts: ExportOptions): string {
  const lines: string[] = [];
  const tag = formatTicketTag(t.id);
  lines.push(`# ${tag} ${t.title || ''}`);
  lines.push('');

  if (opts.includeMeta) {
    lines.push('## 属性');
    lines.push('');
    lines.push(`- ステータス: ${t.status ?? ''}`);
    lines.push(`- 影響度: ${t.priority ?? ''}`);
    if (t.assigneeNames && t.assigneeNames.length > 0) {
      lines.push(`- 担当者: ${t.assigneeNames.join(', ')}`);
    }
    if (t.department) lines.push(`- 部門: ${t.department}`);
    if (t.inquiryCategory) lines.push(`- 種別: ${t.inquiryCategory}`);
    if (t.dueDate) lines.push(`- 期限: ${fmtJst(t.dueDate)}`);
    if (t.reporterName || t.reporterEmail) {
      lines.push(`- 起票元: ${[t.reporterName, t.reporterEmail].filter(Boolean).join(' / ')}`);
    }
    if (t.tags && t.tags.length > 0) {
      lines.push(`- タグ: ${t.tags.map(n => `\`${n}\``).join(', ')}`);
    }
    if (t.source) lines.push(`- ソース: ${t.source}`);
    lines.push(`- 作成: ${fmtJst(t.createdAt)} / 更新: ${fmtJst(t.updatedAt)}`);
    if (t.description) {
      lines.push('');
      lines.push('### 説明');
      lines.push('');
      lines.push(t.description);
    }
    lines.push('');
  }

  // 対象を絞り込む
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');
  const internal = received.filter(c => c.threadKind === 'internal');
  const external = received.filter(c => c.threadKind !== 'internal'); // undef も external 扱い

  const renderComment = (c: Comment, showKindLabel: boolean): string[] => {
    const head: string[] = [];
    const fragments: string[] = [];
    if (showKindLabel) fragments.push(threadKindLabel(c));
    if (opts.includeSender) {
      const sender = [c.fromName, c.fromEmail ? `<${c.fromEmail}>` : ''].filter(Boolean).join(' ');
      if (sender) fragments.push(sender);
      fragments.push(`[${fmtJst(c.sentAt)}]`);
    }
    fragments.push(`(${commentSourceLabel(c)})`);
    head.push(`### ${fragments.join(' · ')}`);
    head.push('');
    const body = c.isHtml ? htmlToMarkdown(c.content ?? '') : (c.content ?? '');
    head.push(body.trim());
    if (opts.includeAttachments && c.hasAttachments) {
      head.push('');
      head.push('> 📎 添付ファイルあり (Outlook / SP ライブラリで確認)');
    }
    head.push('');
    return head;
  };

  // スレッド出力
  if (opts.includeInternal || opts.includeExternal) {
    if (opts.layout === 'merged' && opts.includeInternal && opts.includeExternal) {
      lines.push(`## スレッド (時系列マージ)`);
      lines.push('');
      const all = [...received].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
      for (const c of all) lines.push(...renderComment(c, true));
    } else {
      // 併記 (それぞれ独立セクション) or 片方のみ
      if (opts.includeInternal) {
        lines.push(`## 🏢 内部対応経緯 (${internal.length} 件)`);
        lines.push('');
        const sorted = [...internal].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
        for (const c of sorted) lines.push(...renderComment(c, false));
      }
      if (opts.includeExternal) {
        lines.push(`## 👥 外部対応経緯 (${external.length} 件)`);
        lines.push('');
        const sorted = [...external].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
        for (const c of sorted) lines.push(...renderComment(c, false));
      }
    }
  }

  if (opts.includeNotes && notes.length > 0) {
    lines.push(`## 📝 内部メモ (${notes.length} 件)`);
    lines.push('');
    const sorted = [...notes].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
    for (const c of sorted) {
      const author = c.createdBy ?? c.fromName ?? '(著者不明)';
      lines.push(`### [${fmtJst(c.sentAt)}] ${author}`);
      lines.push('');
      const body = c.isHtml ? htmlToMarkdown(c.content ?? '') : (c.content ?? '');
      lines.push(body.trim());
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── HTML 生成 ───────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(t: Ticket, comments: Comment[], opts: ExportOptions): string {
  const tag = formatTicketTag(t.id);
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');
  const internal = received.filter(c => c.threadKind === 'internal');
  const external = received.filter(c => c.threadKind !== 'internal');

  const css = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font: 14px/1.7 -apple-system, "Segoe UI", "Meiryo", system-ui, sans-serif; color: #2a2a26; background: #fafaf7; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
h3 { font-size: 13px; margin: 16px 0 6px; color: #555; }
.meta { background: #f3f1ea; border-radius: 4px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; }
.meta dl { display: grid; grid-template-columns: 110px 1fr; gap: 4px 12px; margin: 0; }
.meta dt { color: #7a766c; }
.meta dd { margin: 0; }
.card { background: #fff; border: 1px solid #e0ddd3; border-radius: 6px; padding: 12px 16px; margin: 8px 0; }
.card-int { border-left: 4px solid #3b82f6; }
.card-ext { border-left: 4px solid #f59e0b; }
.card-note { background: #fff7ed; border: 1px solid #fbbf24; }
.card-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #555; margin-bottom: 8px; }
.kind-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.kind-int { background: rgba(59,130,246,0.12); color: #1e40af; }
.kind-ext { background: rgba(245,158,11,0.12); color: #92400e; }
.source-tag { color: #888; font-size: 11px; }
.tag-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid; margin-right: 4px; }
.attach { display: inline-block; padding: 2px 8px; background: #fef3c7; border-radius: 4px; font-size: 11px; color: #78350f; margin-top: 6px; }
.card-body { font-size: 13px; line-height: 1.7; }
.card-body img { max-width: 100%; height: auto; }
.card-body pre { background: #f3f1ea; padding: 8px 12px; border-radius: 4px; overflow-x: auto; }
.footer { color: #999; font-size: 11px; margin-top: 24px; padding-top: 12px; border-top: 1px solid #eee; }
@media print {
  body { background: #fff; padding: 16px; }
  .card { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`;

  const tagPills = t.tags && t.tags.length > 0
    ? t.tags.map(name => {
        const td = findTag(name);
        const s = TAG_COLOR_STYLE[td.color];
        return `<span class="tag-pill" style="background:${s.bg};color:${s.fg};border-color:${s.border}">${escHtml(name)}</span>`;
      }).join('')
    : '';

  const sections: string[] = [];

  if (opts.includeMeta) {
    sections.push(`<div class="meta"><dl>
${[
  ['ステータス', escHtml(t.status ?? '')],
  ['影響度', escHtml(t.priority ?? '')],
  t.assigneeNames && t.assigneeNames.length > 0 ? ['担当者', escHtml(t.assigneeNames.join(', '))] : null,
  t.department ? ['部門', escHtml(t.department)] : null,
  t.inquiryCategory ? ['種別', escHtml(t.inquiryCategory)] : null,
  t.dueDate ? ['期限', escHtml(fmtJst(t.dueDate))] : null,
  (t.reporterName || t.reporterEmail) ? ['起票元', escHtml([t.reporterName, t.reporterEmail].filter(Boolean).join(' / '))] : null,
  tagPills ? ['タグ', tagPills] : null,
  t.source ? ['ソース', escHtml(t.source)] : null,
  ['作成', escHtml(fmtJst(t.createdAt))],
  ['更新', escHtml(fmtJst(t.updatedAt))],
].filter((x): x is [string, string] => x !== null)
  .map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${v}</dd>`).join('\n')}
</dl></div>`);
    if (t.description) {
      sections.push(`<h3>説明</h3><div class="card-body">${escHtml(t.description).replace(/\n/g, '<br>')}</div>`);
    }
  }

  const renderCard = (c: Comment, showKindLabel: boolean): string => {
    const isInt = c.threadKind === 'internal';
    const cls = c.type === 'note' ? 'card card-note' : (isInt ? 'card card-int' : 'card card-ext');
    const kindPill = showKindLabel
      ? `<span class="kind-pill ${isInt ? 'kind-int' : 'kind-ext'}">${isInt ? '🏢 内部' : '👥 外部'}</span>`
      : '';
    const sender = (c.fromName || c.fromEmail) ? escHtml([c.fromName, c.fromEmail ? `<${c.fromEmail}>` : ''].filter(Boolean).join(' ')) : '(差出人不明)';
    const time = escHtml(fmtJst(c.sentAt));
    const source = c.type === 'note' ? '内部メモ' : commentSourceLabel(c);
    const head = `<div class="card-head">${kindPill}${opts.includeSender ? `<span>${sender}</span><span>${time}</span>` : `<span>${time}</span>`}<span class="source-tag">${escHtml(source)}</span></div>`;
    let body: string;
    if (c.isHtml) {
      // 受信メール / メモの HTML 本文。opts.includeHtmlRaw が true ならそのまま、
      // false なら sanitize 風に簡易剥離 (タグ除去せず、出力はそのままで OK)
      body = opts.includeHtmlRaw ? (c.content ?? '') : (c.content ?? '');
    } else {
      body = `<pre style="white-space:pre-wrap;background:transparent;border:0;padding:0">${escHtml(c.content ?? '')}</pre>`;
    }
    const attach = opts.includeAttachments && c.hasAttachments
      ? `<div class="attach">📎 添付ファイルあり</div>` : '';
    return `<div class="${cls}">${head}<div class="card-body">${body}</div>${attach}</div>`;
  };

  if (opts.includeInternal || opts.includeExternal) {
    if (opts.layout === 'merged' && opts.includeInternal && opts.includeExternal) {
      sections.push(`<h2>スレッド (時系列マージ)</h2>`);
      const all = [...received].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
      sections.push(all.map(c => renderCard(c, true)).join(''));
    } else {
      if (opts.includeInternal) {
        sections.push(`<h2>🏢 内部対応経緯 (${internal.length} 件)</h2>`);
        const sorted = [...internal].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
        sections.push(sorted.map(c => renderCard(c, false)).join(''));
      }
      if (opts.includeExternal) {
        sections.push(`<h2>👥 外部対応経緯 (${external.length} 件)</h2>`);
        const sorted = [...external].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
        sections.push(sorted.map(c => renderCard(c, false)).join(''));
      }
    }
  }

  if (opts.includeNotes && notes.length > 0) {
    sections.push(`<h2>📝 内部メモ (${notes.length} 件)</h2>`);
    const sorted = [...notes].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
    sections.push(sorted.map(c => renderCard(c, false)).join(''));
  }

  const exportedAt = fmtJst(new Date().toISOString());
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escHtml(tag)} ${escHtml(t.title || '')}</title>
<style>${css}</style>
</head>
<body>
<h1>${escHtml(tag)} ${escHtml(t.title || '')}</h1>
${sections.join('\n')}
<div class="footer">Spira エクスポート · ${escHtml(exportedAt)}</div>
</body>
</html>`;
}

// ── JSON 生成 ───────────────────────────────────────────────────────
function buildJson(t: Ticket, comments: Comment[], opts: ExportOptions): string {
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');
  const internal = received.filter(c => c.threadKind === 'internal');
  const external = received.filter(c => c.threadKind !== 'internal');

  const payload: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    layout: opts.layout,
  };
  if (opts.includeMeta) payload.ticket = t;
  if (opts.layout === 'merged' && opts.includeInternal && opts.includeExternal) {
    payload.thread = [...received].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
  } else {
    if (opts.includeInternal) payload.internalThread = internal;
    if (opts.includeExternal) payload.externalThread = external;
  }
  if (opts.includeNotes) payload.notes = notes;

  return JSON.stringify(payload, null, 2);
}

// ── ダウンロード処理 ────────────────────────────────────────────────
function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function openHtmlForPrint(html: string, title: string): void {
  // 新規タブで開いて print() を即時呼ぶ。ブラウザが popup ブロックしたら
  // 同タブで開く fallback。
  const w = window.open('', '_blank');
  if (!w) {
    toast(getRoot(), 'ポップアップがブロックされました。ブラウザ設定で許可してください', 'error', 8000);
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.document.title = title;
  // 印刷ダイアログは少し遅らせて呼ぶ (DOM 描画待ち)
  setTimeout(() => { try { w.print(); } catch { /* swallow */ } }, 500);
}

// ── モーダル本体 ────────────────────────────────────────────────────
export function openTicketExportModal(ticket: Ticket, comments: Comment[]): void {
  const received = comments.filter(c => c.type === 'received');
  const notes = comments.filter(c => c.type === 'note');
  const internal = received.filter(c => c.threadKind === 'internal');
  const external = received.filter(c => c.threadKind !== 'internal');

  // ── 入力ウィジェット ──
  const cb = (label: string, defaultChecked = true, badge?: string): { input: HTMLInputElement; el: HTMLElement } => {
    const input = el('input', {
      type: 'checkbox',
      ...(defaultChecked ? { checked: 'checked' } : {}),
      style: 'margin:0',
    }) as HTMLInputElement;
    const wrap = el('label', {
      style: 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 8px;border-radius:var(--r-2);font-size:var(--fs-sm)',
    }, [
      input,
      el('span', { style: 'flex:1' }, [label]),
      ...(badge ? [el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs)' }, [badge])] : []),
    ]);
    return { input, el: wrap };
  };

  const cInternal = cb('🏢 内部対応経緯', internal.length > 0, `${internal.length} 件`);
  const cExternal = cb('👥 外部対応経緯', external.length > 0, `${external.length} 件`);
  const cNotes    = cb('📝 内部メモ',     notes.length > 0,    `${notes.length} 件`);

  const layoutParallel = el('input', { type: 'radio', name: 'layout', value: 'parallel', style: 'margin:0' }) as HTMLInputElement;
  const layoutMerged   = el('input', { type: 'radio', name: 'layout', value: 'merged', style: 'margin:0', checked: 'checked' }) as HTMLInputElement;

  const cMeta        = cb('チケット属性 (担当者・期限・タグ等) を含める', true);
  const cSender      = cb('送信者・送信時刻を表示', true);
  const cHtmlRaw     = cb('HTML 形式の受信メール本文をそのまま含める', true);
  const cAttachments = cb('添付ファイルへのリンクを含める', true);

  const formatSel = el('select', {
    class: 'spira-input',
    style: 'width:240px',
  }, [
    el('option', { value: 'md',   selected: 'selected' }, ['📝 Markdown (.md)']),
    el('option', { value: 'html' },                       ['🌐 HTML (.html)']),
    el('option', { value: 'pdf' },                        ['📄 PDF (印刷ダイアログ経由)']),
    el('option', { value: 'json' },                       ['🧬 JSON (.json)']),
  ]) as HTMLSelectElement;

  const layoutRow = el('div', {
    style: 'display:flex;gap:var(--s-4);align-items:center;padding:6px 8px;font-size:var(--fs-sm)',
  }, [
    el('label', { style: 'display:flex;gap:6px;align-items:center;cursor:pointer' }, [
      layoutParallel, el('span', {}, ['併記 (内部 / 外部 を独立セクション)']),
    ]),
    el('label', { style: 'display:flex;gap:6px;align-items:center;cursor:pointer' }, [
      layoutMerged, el('span', {}, ['マージ (時系列に統合、ラベル付き)']),
    ]),
  ]);

  // ── レイアウト ──
  const section = (title: string, children: HTMLElement[]): HTMLElement => el('div', {
    style: 'margin-bottom:var(--s-4)',
  }, [
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:4px' }, [title]),
    ...children,
  ]);

  const body = el('div', { style: 'min-width:520px;max-width:600px' }, [
    section('エクスポート対象', [cInternal.el, cExternal.el, cNotes.el]),
    section('スレッドの表示形式 (内部 + 外部 を両方選択時)', [layoutRow]),
    section('オプション', [cMeta.el, cSender.el, cHtmlRaw.el, cAttachments.el]),
    section('形式', [
      el('div', { style: 'padding:6px 8px' }, [formatSel]),
    ]),
  ]);

  const handle = openModal(getRoot(), {
    title: `📤 ${formatTicketTag(ticket.id)} をエクスポート`,
    body,
    size: 'lg',
    primaryLabel: 'ダウンロード',
    onPrimary: async () => {
      const opts: ExportOptions = {
        includeInternal: cInternal.input.checked,
        includeExternal: cExternal.input.checked,
        includeNotes:    cNotes.input.checked,
        layout: layoutMerged.checked ? 'merged' : 'parallel',
        includeMeta:        cMeta.input.checked,
        includeSender:      cSender.input.checked,
        includeHtmlRaw:     cHtmlRaw.input.checked,
        includeAttachments: cAttachments.input.checked,
        format: formatSel.value as Format,
      };
      if (!opts.includeInternal && !opts.includeExternal && !opts.includeNotes) {
        toast(getRoot(), '少なくとも 1 つの対象を選択してください', 'warn');
        throw new Error('no-target');
      }
      try {
        if (opts.format === 'md') {
          const md = buildMarkdown(ticket, comments, opts);
          downloadBlob(md, safeFilename(ticket.title, 'md', ticket.id), 'text/markdown');
        } else if (opts.format === 'html') {
          const html = buildHtml(ticket, comments, opts);
          downloadBlob(html, safeFilename(ticket.title, 'html', ticket.id), 'text/html');
        } else if (opts.format === 'pdf') {
          const html = buildHtml(ticket, comments, opts);
          openHtmlForPrint(html, `${formatTicketTag(ticket.id)} ${ticket.title}`);
          toast(getRoot(), '新規タブで開いて印刷ダイアログを表示しました。PDF として保存してください', 'ok', 6000);
        } else if (opts.format === 'json') {
          const json = buildJson(ticket, comments, opts);
          downloadBlob(json, safeFilename(ticket.title, 'json', ticket.id), 'application/json');
        }
        if (opts.format !== 'pdf') {
          toast(getRoot(), 'エクスポートしました', 'ok');
        }
      } catch (e) {
        toast(getRoot(), `エクスポート失敗: ${(e as Error).message}`, 'error');
        throw e;
      }
    },
  });
  void handle;
}
