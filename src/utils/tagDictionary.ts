// タグ辞書 (管理者が事前定義する curated タグ群)。
//
// 案 A 厳格辞書方式: チケットに付けるタグはすべてここに登録された
// 名前から選択。ユーザは自由にタグを追加できない (admin が設定モーダルで
// メンテナンス)。表記揺れ・stale tag を抑止する。
//
// 保存先: SpiraSettings リスト の Key='tags.dictionary'、Value=JSON。
// 各タグは name + color + description で構成。

import { getRepo } from '../api/repo';

export type TagColor =
  | 'red' | 'orange' | 'amber' | 'green' | 'teal'
  | 'blue' | 'indigo' | 'purple' | 'pink' | 'gray';

export const TAG_COLORS: TagColor[] = [
  'red', 'orange', 'amber', 'green', 'teal',
  'blue', 'indigo', 'purple', 'pink', 'gray',
];

/** 各色の表示用設定 (CSS で参照)。背景と文字色のペア。 */
export const TAG_COLOR_STYLE: Record<TagColor, { bg: string; fg: string; border: string }> = {
  red:    { bg: 'rgba(220,38,38,0.10)',  fg: '#991b1b', border: '#ef4444' },
  orange: { bg: 'rgba(234,88,12,0.10)',  fg: '#9a3412', border: '#f97316' },
  amber:  { bg: 'rgba(217,119,6,0.12)',  fg: '#92400e', border: '#f59e0b' },
  green:  { bg: 'rgba(22,163,74,0.10)',  fg: '#166534', border: '#22c55e' },
  teal:   { bg: 'rgba(13,148,136,0.10)', fg: '#115e59', border: '#14b8a6' },
  blue:   { bg: 'rgba(37,99,235,0.10)',  fg: '#1e40af', border: '#3b82f6' },
  indigo: { bg: 'rgba(79,70,229,0.10)',  fg: '#3730a3', border: '#6366f1' },
  purple: { bg: 'rgba(147,51,234,0.10)', fg: '#6b21a8', border: '#a855f7' },
  pink:   { bg: 'rgba(219,39,119,0.10)', fg: '#9d174d', border: '#ec4899' },
  gray:   { bg: 'rgba(107,114,128,0.10)', fg: '#374151', border: '#9ca3af' },
};

export interface TagDef {
  name: string;
  color: TagColor;
  description?: string;
}

const KEY = 'tags.dictionary';

function isTagColor(v: unknown): v is TagColor {
  return typeof v === 'string' && (TAG_COLORS as string[]).includes(v);
}

function normalizeTags(raw: unknown): TagDef[] {
  if (!Array.isArray(raw)) return [];
  const out: TagDef[] = [];
  for (const x of raw) {
    if (typeof x !== 'object' || !x) continue;
    const r = x as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    const color: TagColor = isTagColor(r.color) ? r.color : 'gray';
    const description = typeof r.description === 'string' ? r.description : undefined;
    out.push({ name, color, description });
  }
  return out;
}

let cache: TagDef[] | null = null;

export async function getTagDictionary(): Promise<TagDef[]> {
  if (cache) return cache;
  try {
    const raw = await getRepo().getSetting(KEY);
    if (raw) {
      cache = normalizeTags(JSON.parse(raw));
      return cache;
    }
  } catch { /* fall through */ }
  cache = [];
  return cache;
}

export async function setTagDictionary(list: TagDef[]): Promise<void> {
  await getRepo().setSetting(KEY, JSON.stringify(list));
  cache = list;
}

export function getTagDictionarySync(): TagDef[] {
  return cache ?? [];
}

/** 名前から TagDef を引く (同期キャッシュ参照)。見つからなければ gray の仮 TagDef を返す。 */
export function findTag(name: string): TagDef {
  const found = (cache ?? []).find(t => t.name === name);
  if (found) return found;
  return { name, color: 'gray' };
}

export async function warmTagDictionary(): Promise<void> {
  cache = null;
  await getTagDictionary();
}
