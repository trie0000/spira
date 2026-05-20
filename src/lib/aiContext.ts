// Builds the system prompt context for the AI chat panel. The chat is
// scoped to a single ticket — every prompt embeds:
//   - チケット基本情報 (title, status, priority, assignees, department, etc.)
//   - 受信スレッド (顧客と社内の往復履歴、source=mail/teams/other, 時系列)
//   - 内部メモ (社内議論、createdBy / updatedBy / sentAt 込み)
//
// 役割は Q&A・要約・返信下書き・内部メモ案の 4 つに固定。tool use は今期は
// 提供せず、テキスト in / out のみ (内部メモへの「保存」はユーザが UI 操作
// で明示的に実行する)。

import type { Ticket, Comment } from '../types';
import { htmlToMarkdown } from './note-editor';

/** Format an ISO timestamp as `YYYY-MM-DD HH:mm` in JST. Falls back to the
 *  raw string when the value is unparseable. */
function fmtJst(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Convert one comment to its markdown-friendly content, stripping HTML for
 *  legacy received-mail rows so the LLM sees clean text. */
function commentContent(c: Comment): string {
  if (c.isHtml) return htmlToMarkdown(c.content ?? '').trim();
  return (c.content ?? '').trim();
}

/** Source label in Japanese. */
function sourceLabel(src: string | undefined): string {
  if (src === 'mail') return 'メール';
  if (src === 'forms') return 'Forms';
  if (src === 'teams') return 'Teams';
  if (src === 'other') return 'その他';
  return '不明';
}

export interface BuildContextOpts {
  /** Cap individual comment body length to keep prompts bounded. Older
   *  comments get truncated first; default 4000 chars per comment. */
  perCommentLimit?: number;
  /** Total context budget in characters (rough); when exceeded we drop the
   *  oldest received comments first. Default 60000 (≈ 30K tokens). */
  totalLimit?: number;
}

/** Build the full system-prompt context block string. The caller embeds
 *  this verbatim into the `system` field (Claude) or first `system` message
 *  (OpenAI). */
export function buildTicketContext(
  t: Ticket,
  comments: Comment[],
  opts: BuildContextOpts = {},
): string {
  const perLimit = opts.perCommentLimit ?? 4000;
  const totalLimit = opts.totalLimit ?? 60000;

  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('# チケット情報');
  lines.push(`- ID: #${String(t.id).padStart(5, '0')}`);
  lines.push(`- タイトル: ${t.title ?? ''}`);
  lines.push(`- ステータス: ${t.status ?? ''}`);
  lines.push(`- 影響度: ${t.priority ?? ''}`);
  if (t.assigneeNames && t.assigneeNames.length > 0) {
    lines.push(`- 担当者: ${t.assigneeNames.join(', ')}`);
  } else {
    lines.push('- 担当者: (未割当)');
  }
  if (t.department) lines.push(`- 部門: ${t.department}`);
  if (t.inquiryCategory) lines.push(`- 問い合わせ種別: ${t.inquiryCategory}`);
  if (t.dueDate) lines.push(`- 期限: ${t.dueDate}`);
  if (t.reporterName || t.reporterEmail) {
    lines.push(`- 起票者: ${t.reporterName ?? ''} ${t.reporterEmail ? '<' + t.reporterEmail + '>' : ''}`.trim());
  }
  if (t.description) {
    lines.push('');
    lines.push('## 説明');
    lines.push(t.description);
  }

  // ── 受信スレッド (顧客やり取り、時系列) ────────────────────────────
  const received = comments
    .filter(c => c.type === 'received')
    .slice()
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
  const notes = comments
    .filter(c => c.type === 'note')
    .slice()
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`# 受信スレッド (顧客 ↔ 社内の往復、時系列、計 ${received.length} 件)`);
  if (received.length === 0) {
    lines.push('(まだやり取りはありません)');
  } else {
    for (const c of received) {
      const head = `[${fmtJst(c.sentAt)}] ${c.fromName ?? '(差出人不明)'}` +
        (c.fromEmail ? ` <${c.fromEmail}>` : '') +
        ` — ソース: ${sourceLabel(c.source)}`;
      lines.push('');
      lines.push(head);
      lines.push(truncate(commentContent(c), perLimit));
    }
  }

  // ── 内部メモ (社内議論、createdBy/updatedBy 込み) ──────────────────
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`# 内部メモ (社内議論専用、顧客には見えない、計 ${notes.length} 件)`);
  if (notes.length === 0) {
    lines.push('(まだメモはありません)');
  } else {
    for (const n of notes) {
      const stamp = `[${fmtJst(n.sentAt)}]`;
      const author = n.createdBy ?? n.fromName ?? '(著者不明)';
      const updated = (n.updatedBy && n.updatedBy !== author)
        ? ` (最終更新: ${n.updatedBy} ${fmtJst(n.updatedAt)})`
        : '';
      lines.push('');
      lines.push(`${stamp} ${author}${updated}`);
      lines.push(truncate(commentContent(n), perLimit));
    }
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 全体予算を超過したら、古い受信コメントから順に省略する。
  let full = lines.join('\n');
  if (full.length > totalLimit) {
    // 簡易圧縮: 古い received コメントの本文を `…(省略)…` に置換しながら
    // 縮める。実装は素朴 — 必要十分。
    full = compressByTrimming(lines, totalLimit);
  }
  return full;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…(${s.length - n} 文字省略)`;
}

function compressByTrimming(lines: string[], target: number): string {
  // Find received block bounds and trim oldest received entries first.
  // Each received entry occupies 3 lines: blank, header, body.
  const out = lines.slice();
  let cur = out.join('\n');
  // Iterate from start replacing body lines with placeholders until under target.
  for (let i = 0; i < out.length && cur.length > target; i++) {
    const line = out[i] ?? '';
    if (line.startsWith('[') && /\] [^—]+ —/.test(line)) {
      // This looks like a received header; the next line is the body.
      const bodyIdx = i + 1;
      if (bodyIdx < out.length && (out[bodyIdx] ?? '').length > 120) {
        out[bodyIdx] = '(古い履歴は省略されました)';
        cur = out.join('\n');
      }
    }
  }
  return cur;
}

/** Common system prompt — describes role + rules. The per-ticket context
 *  block produced by `buildTicketContext` is appended after this. */
export const SPIRA_AI_SYSTEM_PROMPT = `あなたは Spira (SharePoint ベースのチケット管理アプリ) の AI アシスタントです。
ユーザーは現在 1 つのチケットを開いており、そのチケットの全情報 (基本情報・受信スレッド・内部メモ) があなたに提供されています。

あなたの役割:
1. **Q&A**: チケットに関する質問への回答 (経緯・要因・現状・関係者など)
2. **要約**: スレッド全体や内部メモを構造化して要約
3. **返信文面案の作成**: 顧客への返信ドラフト (丁寧語・敬語、Markdown コードブロックで囲む)
4. **内部メモ案の作成**: 社内向けの新規メモ案 (要点を箇条書き、Markdown コードブロックで囲む)

応答ルール:
- 簡潔で正確な日本語で回答する
- 提供された情報のみを根拠とし、推測する場合は「推測です」と明示する
- 返信文面案・内部メモ案を提示する際は、必ず \`\`\`markdown ... \`\`\` のコードブロックで囲む (UI が「メモとして保存」ボタンを出すために必要)
- 顧客への返信は丁寧語・敬語、内部メモは要点を箇条書きが基本
- 「内部メモ」は顧客から見えない社内専用情報。返信文面に内部メモの中身をそのまま転記しないこと
- 受信スレッドの time-stamp / source / 送信者を踏まえて時系列の前後関係を正しく扱う
- 不明な点を質問するのは OK。ユーザーから追加情報をもらってから本回答を出してよい`;
