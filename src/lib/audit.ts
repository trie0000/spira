// 監査ログのアプリ側ヘルパ。
//
// 役割:
//   1. Retention 設定 (`audit.retention.days`、default 30) を SpiraSettings
//      から取得し、AuditLog 行の ExpiresAt を計算する。
//   2. emitAudit(action, target, details) で repo.appendAudit を best-effort
//      呼び出し。失敗してもユーザ操作を阻害しない。
//   3. runStartupCleanup() で 24 時間に 1 回 (=localStorage で前回時刻保持)
//      期限切れ行の物理削除を実行。
//   4. ticket update の diff(before, after) ヘルパ — 変更があった列だけを
//      Details JSON に残す。
//
// 設計判断:
//   - 内部メモの「編集」は記録しない (Strategy C)。SP の Editor/Modified 列で
//     誰がいつ編集したかは追える。AuditLog は人手による「操作」イベントだけ。
//   - mutation の前後値スナップショットの取得は呼出側 (repo impl) が責任を
//     持つ。emitAudit に渡す details は既に正規化された JSON-friendly な値。

import type { Ticket, AuditAction, AuditTargetType } from '../types';
import { getRepo } from '../api/repo';

const SETTING_KEY = 'audit.retention.days';
const CLEANUP_LAST_KEY = 'spira:audit:last-cleanup';
const RETENTION_CACHE_KEY = 'spira:audit:retention-cache';
const RETENTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;

/** 設定値を SpiraSettings から取得 (5 分キャッシュ)。
 *  最初の呼出は SP ラウンドトリップ 1 回、以降は localStorage キャッシュ。 */
let retentionMemoryCache: { days: number; expiresAt: number } | null = null;

export async function getRetentionDays(): Promise<number> {
  // 1. メモリキャッシュ
  if (retentionMemoryCache && retentionMemoryCache.expiresAt > Date.now()) {
    return retentionMemoryCache.days;
  }
  // 2. localStorage キャッシュ
  try {
    const raw = localStorage.getItem(RETENTION_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { days: number; expiresAt: number };
      if (parsed.expiresAt > Date.now()) {
        retentionMemoryCache = parsed;
        return parsed.days;
      }
    }
  } catch { /* ignore */ }
  // 3. SP から取得
  let days = DEFAULT_RETENTION_DAYS;
  try {
    const v = await getRepo().getSetting(SETTING_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) days = clampRetention(n);
    }
  } catch { /* keep default */ }
  const cached = { days, expiresAt: Date.now() + RETENTION_CACHE_TTL_MS };
  retentionMemoryCache = cached;
  try { localStorage.setItem(RETENTION_CACHE_KEY, JSON.stringify(cached)); } catch { /* ignore */ }
  return days;
}

export function clampRetention(n: number): number {
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.floor(n)));
}

export async function setRetentionDays(days: number): Promise<void> {
  const v = clampRetention(days);
  await getRepo().setSetting(SETTING_KEY, String(v));
  retentionMemoryCache = { days: v, expiresAt: Date.now() + RETENTION_CACHE_TTL_MS };
  try { localStorage.setItem(RETENTION_CACHE_KEY, JSON.stringify(retentionMemoryCache)); } catch { /* ignore */ }
}

export function getRetentionMinMax(): { min: number; max: number; default: number } {
  return { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS, default: DEFAULT_RETENTION_DAYS };
}

/** 監査ログを 1 件 emit。失敗してもユーザ操作には影響させない。 */
export async function emitAudit(args: {
  action: AuditAction;
  ticketId: number;
  targetType: AuditTargetType;
  targetId?: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const days = await getRetentionDays();
    const expires = new Date();
    expires.setDate(expires.getDate() + days);
    await getRepo().appendAudit({
      action: args.action,
      ticketId: args.ticketId,
      targetType: args.targetType,
      targetId: args.targetId,
      details: args.details,
      expiresAt: expires.toISOString(),
    });
  } catch (e) {
    console.warn('[audit] emit failed:', e);
  }
}

/** Ticket 属性 patch から「変更があった列」の前後値ペアを抽出。
 *  返り値は { fieldName: [before, after] } の形。空オブジェクトなら変更なし。
 *  内容そのもの (description 等) は記録対象外なので、長文系列は
 *  「変更あり」のマーカーだけ残す。 */
export function ticketDiff(before: Ticket, patch: Partial<Ticket>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  const watch: Array<keyof Ticket> = [
    'title', 'status', 'priority', 'dueDate', 'department', 'inquiryCategory',
    'reporterEmail', 'reporterName', 'customerTeam',
    'internalThreadId', 'internalChannelId', 'internalDeepLink',
    'userThreadId', 'userChannelId', 'userDeepLink',
  ];
  for (const k of watch) {
    if (!(k in patch)) continue;
    const b = (before as unknown as Record<string, unknown>)[k as string];
    const a = (patch as unknown as Record<string, unknown>)[k as string];
    if (normalize(b) !== normalize(a)) out[k as string] = [b ?? null, a ?? null];
  }
  // assignees (配列) は length + 並び順で比較
  if ('assigneeEmails' in patch || 'assigneeNames' in patch) {
    const bEmails = (before.assigneeEmails ?? []).join(',');
    const aEmails = (patch.assigneeEmails ?? before.assigneeEmails ?? []).join(',');
    if (bEmails !== aEmails) {
      out['assignees'] = [bEmails || null, aEmails || null];
    }
  }
  // description は変更フラグだけ (内容は保存しない)
  if ('description' in patch && (before.description ?? '') !== (patch.description ?? '')) {
    out['description'] = ['(changed)', '(changed)'];
  }
  return out;
}

function normalize(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

// ─── Startup cleanup ─────────────────────────────────────────────────────
//
// アプリ起動時に呼ばれる。24 時間以内に実行済なら skip。
// 失敗しても次回再試行 — ベストエフォート。

export async function runStartupCleanup(): Promise<void> {
  try {
    const last = parseInt(localStorage.getItem(CLEANUP_LAST_KEY) ?? '0', 10);
    if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return;
    const res = await getRepo().cleanupExpiredAudit();
    if (res.deleted > 0) {
      console.info(`[audit] cleaned ${res.deleted} expired record(s)`);
    }
    try { localStorage.setItem(CLEANUP_LAST_KEY, String(Date.now())); } catch { /* ignore */ }
  } catch (e) {
    console.warn('[audit] startup cleanup failed:', e);
  }
}

/** 日本語ラベル — 監査ログビューア用。 */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  'ticket.create':       'チケット起票',
  'ticket.update':       'チケット更新',
  'ticket.delete':       'チケット削除 (ゴミ箱)',
  'ticket.restore':      'チケット復元',
  'ticket.purge':        'チケット完全削除',
  'note.create':         'メモ追加',
  'note.delete':         'メモ削除',
  'comment.add':         '履歴追加',
  'comment.update':      '履歴更新',
  'comment.delete':      '履歴削除',
  'inbox.ingest':        '受信メール取り込み',
  'inbox.link':          '既存チケットに紐付け',
  'inbox.hide':          '受信メール非表示',
  'teams.thread.create': 'Teams スレッド起票',
  'ai.note.save':        'AI 生成メモ保存',
};
