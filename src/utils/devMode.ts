// 開発者モード — localStorage で管理する単純なフラグ。
// 有効時に表示される機能 (Claude API 直接利用など) を制御する。
// この機能の存在自体は通常のヘルプには記載しない方針。

const KEY = 'spira:developer-mode';

export function isDeveloperMode(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDeveloperMode(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
