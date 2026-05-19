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

// スケール表 (CSS の data-font-size 属性版と同期させること)
const SCALES: Record<FontSize, Record<string, string>> = {
  sm: {
    '--fs-xs':   '10px',
    '--fs-sm':   '11px',
    '--fs-md':   '12px',
    '--fs-base': '13px',
    '--fs-lg':   '14px',
    '--fs-xl':   '16px',
    '--fs-h3':   '19px',
    '--fs-h2':   '24px',
    '--fs-h1':   '30px',
  },
  md: {
    '--fs-xs':   '11px',
    '--fs-sm':   '12px',
    '--fs-md':   '13px',
    '--fs-base': '15px',
    '--fs-lg':   '16px',
    '--fs-xl':   '18px',
    '--fs-h3':   '22px',
    '--fs-h2':   '28px',
    '--fs-h1':   '36px',
  },
  lg: {
    '--fs-xs':   '13px',
    '--fs-sm':   '14px',
    '--fs-md':   '15px',
    '--fs-base': '17px',
    '--fs-lg':   '19px',
    '--fs-xl':   '22px',
    '--fs-h3':   '26px',
    '--fs-h2':   '32px',
    '--fs-h1':   '40px',
  },
};

/** 現在の設定値を .spira-root 要素にインラインスタイルとして反映する。
 *  CSS の attribute selector に頼らず .style.setProperty で直接書き換える
 *  ことで、確実にカスケード優先度を確保する (インラインは specificity 最高)。 */
export function applyFontSize(): void {
  const root = document.querySelector<HTMLElement>('.spira-root');
  if (!root) return;
  const size = getFontSize();
  const scale = SCALES[size];
  for (const [k, v] of Object.entries(scale)) {
    root.style.setProperty(k, v);
  }
  // 属性も併用 (将来 CSS で更に細かい調整を行うため)
  root.setAttribute('data-font-size', size);
  // base font-size をルートにも適用 (root.style.fontSize でも反映)
  root.style.fontSize = scale['--fs-base']!;
}
