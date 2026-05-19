// 受信同期間隔の設定モーダル — 数値 (秒) を SpiraSettings に保存する。
// 0 を入れると定期同期 OFF。値を保存すると main.ts 側の setInterval が
// 再起動される (restartAutoSync 経由)。

import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { restartAutoSync } from '../main';

const SETTING_KEY = 'inboxSyncIntervalSec';
const DEFAULT_SEC = 60;
const MIN_SEC = 10;
const MAX_SEC = 3600;

/** 設定値を取得 (未設定 / 不正値はデフォルト 60 秒)。 */
export async function getSyncIntervalSec(): Promise<number> {
  try {
    const v = await getRepo().getSetting(SETTING_KEY);
    if (v == null) return DEFAULT_SEC;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_SEC;
    if (n === 0) return 0;           // 0 = OFF
    return Math.min(Math.max(n, MIN_SEC), MAX_SEC);
  } catch {
    return DEFAULT_SEC;
  }
}

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

export async function openSyncIntervalModal(): Promise<void> {
  const current = await getSyncIntervalSec();

  const input = el('input', {
    type: 'number',
    class: 'spira-input',
    min: '0',
    max: String(MAX_SEC),
    step: '5',
    value: String(current),
    style: 'width:120px',
  }) as HTMLInputElement;

  const presetBtn = (label: string, sec: number): HTMLElement => el('button', {
    type: 'button',
    class: 'spira-btn spira-btn-sm',
    style: 'margin-right:6px',
    onclick: () => { input.value = String(sec); },
  }, [label]);

  const body = el('div', { style: 'max-width:520px' }, [
    el('p', { style: 'margin:0 0 var(--s-3);font-size:var(--fs-sm);color:var(--ink-3);line-height:1.6' }, [
      '受信一覧を自動で更新する間隔 (秒) を設定します。',
      el('br'),
      '・既定: ', el('strong', {}, ['60 秒']),
      el('br'),
      '・最小: ', el('strong', {}, [`${MIN_SEC} 秒`]), ' / 最大: ', el('strong', {}, [`${MAX_SEC} 秒`]),
      el('br'),
      '・', el('strong', {}, ['0']), ' を指定すると自動更新を完全に停止 (起動時のみ取得 + 手動同期ボタン使用)',
      el('br'),
      el('br'),
      '※ 短すぎる値 (10 秒未満) は SharePoint のスロットリング枠を消費するので避けてください。',
    ]),
    el('div', { style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-3)' }, [
      el('label', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['同期間隔:']),
      input,
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['秒']),
    ]),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' }, [
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs);margin-right:4px;align-self:center' }, ['プリセット:']),
      presetBtn('OFF', 0),
      presetBtn('30秒', 30),
      presetBtn('60秒 (既定)', 60),
      presetBtn('2分', 120),
      presetBtn('5分', 300),
      presetBtn('15分', 900),
    ]),
  ]);

  openModal(getRoot(), {
    title: '受信同期 — 自動更新間隔',
    body,
    size: 'md',
    primaryLabel: '保存',
    onPrimary: async () => {
      const raw = parseInt(input.value, 10);
      if (!Number.isFinite(raw) || raw < 0) {
        throw new Error('0 以上の数値を入力してください');
      }
      if (raw > 0 && raw < MIN_SEC) {
        throw new Error(`最小 ${MIN_SEC} 秒以上を指定してください (0 = OFF)`);
      }
      if (raw > MAX_SEC) {
        throw new Error(`最大 ${MAX_SEC} 秒以下にしてください`);
      }
      await getRepo().setSetting(SETTING_KEY, String(raw));
      // 即座にタイマー再起動
      void restartAutoSync();
      const msg = raw === 0
        ? '自動更新を OFF にしました (起動時 + 手動同期のみ)'
        : `自動更新を ${raw} 秒間隔に設定しました`;
      toast(getRoot(), msg, 'ok');
    },
  });
}
