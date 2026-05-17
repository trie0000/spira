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
