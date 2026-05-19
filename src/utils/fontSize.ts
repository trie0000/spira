// 文字サイズ設定 (大 / 中 / 小)。
// 中 = CSS 既定値 (data-font-size 属性なし)
// 大 / 小 = CSS の .spira-root[data-font-size="lg|sm"] を有効化
// localStorage に永続化、main.ts の起動シーケンスで applyFontSize() を呼ぶ。

export type FontSize = 'sm' | 'md' | 'lg';

const KEY = 'spira:font-size';

export function getFontSize(): FontSize {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'sm' || v === 'lg' || v === 'md') return v;
  } catch { /* ignore */ }
  return 'md';
}

export function setFontSize(v: FontSize): void {
  try {
    if (v === 'md') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch { /* ignore */ }
  applyFontSize();
}

/** 現在の設定値を .spira-root 要素に反映する。中 (md) のときは属性を削除。 */
export function applyFontSize(): void {
  const root = document.querySelector<HTMLElement>('.spira-root');
  if (!root) return;
  const size = getFontSize();
  if (size === 'md') root.removeAttribute('data-font-size');
  else root.setAttribute('data-font-size', size);
}
