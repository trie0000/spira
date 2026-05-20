// 改廃可能な選択肢リスト (部門 / 問い合わせ種別)。
//
// 保存先は SpiraSettings リスト (Spira 全体で共有)。設定モーダルで
// 追加・削除した内容を JSON 配列で保存し、チケット起票・編集時に
// ドロップダウンの選択肢として表示する。
//
// 簡易メモリキャッシュ付き。設定変更時はキャッシュをクリアする。

import { getRepo } from '../api/repo';

const KEY_DEPARTMENTS = 'options:departments';
const KEY_CATEGORIES = 'options:categories';
const KEY_STATUSES = 'options:statuses';
const KEY_PRIORITIES = 'options:priorities';

/** 問い合わせ種別のデフォルト (初回参照時に SpiraSettings へ書き込まれる)。
 *  この一覧は Forms 側の選択肢と一致させること (自動マッピング条件)。 */
export const DEFAULT_INQUIRY_CATEGORIES: string[] = [
  '仕様に関する質問',
  '不具合・エラーの報告',
  '機能改善の要望',
  '操作方法がわからない',
  'アカウント・権限の問題',
  'その他',
];

/** 部門のデフォルト (空)。管理者が設定で追加する想定。 */
export const DEFAULT_DEPARTMENTS: string[] = [];

/** ステータスのデフォルト。SP の Choice 列にも同値が設定されている。
 *  設定で追加した値は SP リスト側の Choice にも手動追加が必要 (column 制約)。 */
export const DEFAULT_STATUSES: string[] = ['新規', '対応中', '確認待ち', '完了'];

/** 影響度 (= 旧 Priority) のデフォルト。Forms 自動マッピングと整合させるため
 *  英語の High/Medium/Low をデフォルトに。日本語ラベルに変えたい場合は
 *  設定モーダルで上書き可能。 */
export const DEFAULT_PRIORITIES: string[] = ['High', 'Medium', 'Low'];

const cache: Record<string, string[] | undefined> = {};

async function readList(key: string, defaults: string[]): Promise<string[]> {
  if (key in cache && cache[key]) return cache[key]!;
  try {
    const raw = await getRepo().getSetting(key);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
        cache[key] = parsed;
        return parsed;
      }
    }
  } catch { /* fall through to defaults */ }
  // 未登録 → デフォルトを書き込み (初回のみ)
  if (defaults.length > 0) {
    try { await getRepo().setSetting(key, JSON.stringify(defaults)); }
    catch { /* noop */ }
  }
  cache[key] = defaults;
  return defaults;
}

async function writeList(key: string, list: string[]): Promise<void> {
  await getRepo().setSetting(key, JSON.stringify(list));
  cache[key] = list;
}

export const getDepartmentOptions = (): Promise<string[]> => readList(KEY_DEPARTMENTS, DEFAULT_DEPARTMENTS);
export const setDepartmentOptions = (list: string[]): Promise<void> => writeList(KEY_DEPARTMENTS, list);

export const getInquiryCategoryOptions = (): Promise<string[]> => readList(KEY_CATEGORIES, DEFAULT_INQUIRY_CATEGORIES);
export const setInquiryCategoryOptions = (list: string[]): Promise<void> => writeList(KEY_CATEGORIES, list);

export const getStatusOptions = (): Promise<string[]> => readList(KEY_STATUSES, DEFAULT_STATUSES);
export const setStatusOptions = (list: string[]): Promise<void> => writeList(KEY_STATUSES, list);

export const getPriorityOptions = (): Promise<string[]> => readList(KEY_PRIORITIES, DEFAULT_PRIORITIES);
export const setPriorityOptions = (list: string[]): Promise<void> => writeList(KEY_PRIORITIES, list);

/** 同期版アクセサ (キャッシュにあれば返す、無ければデフォルト)。
 *  ticketStatusList() / priorityList() のような同期呼び出しから利用。
 *  起動時に warmOptionLists() でキャッシュを温めておくことを想定。 */
export function getStatusOptionsSync(): string[] {
  return cache[KEY_STATUSES] ?? DEFAULT_STATUSES;
}
export function getPriorityOptionsSync(): string[] {
  return cache[KEY_PRIORITIES] ?? DEFAULT_PRIORITIES;
}
export function getDepartmentOptionsSync(): string[] {
  return cache[KEY_DEPARTMENTS] ?? DEFAULT_DEPARTMENTS;
}
export function getInquiryCategoryOptionsSync(): string[] {
  return cache[KEY_CATEGORIES] ?? DEFAULT_INQUIRY_CATEGORIES;
}

/** 起動時に呼び出すウォーマー (非同期だが先に await できる)。 */
export async function warmOptionLists(): Promise<void> {
  await Promise.all([
    getStatusOptions().catch(() => {}),
    getPriorityOptions().catch(() => {}),
    getDepartmentOptions().catch(() => {}),
    getInquiryCategoryOptions().catch(() => {}),
  ]);
}
