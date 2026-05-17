// 担当者マルチピッカー。
//
// 現在選択中の担当者を chip で表示し、その隣の「+ 追加」ボタンから
// ドロップダウン (検索可能なユーザー一覧) を開いて複数選択できる。
// チップの × でその担当者を解除。
//
// 用途:
//   - チケット詳細ヘッダ
//   - 新規チケット起票モーダル
//
// 値は emails (メールアドレスの配列) を管理し、displayName は AD ユーザー
// 一覧から都度引く。状態は内部で持ち、`onChange` で外部に通知する。

import { el } from '../utils/dom';
import type { SiteUser } from '../types';

export interface AssigneePickerOptions {
  /** 初期選択メールアドレス */
  initial?: string[];
  /** 候補ユーザー (AD) */
  users: SiteUser[];
  /** 選択変更時に呼ばれる。emails と names を同期して返す。 */
  onChange?: (emails: string[], names: string[]) => void;
  /** 追加ボタンのラベル (デフォルト: "+ 担当者") */
  addButtonLabel?: string;
}

export interface AssigneePickerHandle {
  /** ルート要素 — モーダル/フォームに差し込む */
  el: HTMLElement;
  /** 現在の選択を返す */
  getValue(): { emails: string[]; names: string[] };
  /** 外部から値を設定 (描画も更新) */
  setValue(emails: string[]): void;
}

export function createAssigneePicker(opts: AssigneePickerOptions): AssigneePickerHandle {
  const usersByEmail = new Map(opts.users.map(u => [u.email, u]));
  let selected = new Set<string>(opts.initial ?? []);

  const root = el('div', {
    class: 'spira-asg-picker',
    style: 'display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center;min-width:0',
  });

  const fire = (): void => {
    const emails = Array.from(selected);
    const names = emails.map(e => usersByEmail.get(e)?.displayName ?? e);
    opts.onChange?.(emails, names);
  };

  const renderChips = (): void => {
    root.replaceChildren();
    for (const email of selected) {
      const u = usersByEmail.get(email);
      const name = u?.displayName ?? email;
      root.appendChild(el('span', {
        class: 'spira-asg-chip',
        title: u ? `${name} <${email}>` : email,
        style: [
          'display:inline-flex', 'align-items:center', 'gap:4px',
          'padding:2px 4px 2px 8px',
          'background:var(--paper-2)', 'border:1px solid var(--line)',
          'border-radius:var(--r-3)', 'font-size:var(--fs-sm)',
        ].join(';'),
      }, [
        name,
        el('button', {
          type: 'button',
          'aria-label': `${name} を解除`,
          style: [
            'border:0', 'background:transparent', 'cursor:pointer',
            'color:var(--ink-3)', 'font-size:14px', 'line-height:1',
            'padding:0 2px',
          ].join(';'),
          onclick: () => {
            selected.delete(email);
            renderChips();
            fire();
          },
        }, ['×']),
      ]));
    }
    root.appendChild(addBtn);
  };

  // ---- 追加ドロップダウン ------------------------------------------------
  let popOpen = false;
  const closePop = (): void => {
    pop.style.display = 'none';
    popOpen = false;
    document.removeEventListener('click', outsideClick, true);
  };
  const outsideClick = (e: Event): void => {
    if (!pop.contains(e.target as Node) && !addBtn.contains(e.target as Node)) closePop();
  };
  const renderPopList = (filter: string): void => {
    list.replaceChildren();
    const q = filter.trim().toLowerCase();
    const remaining = opts.users.filter(u => !selected.has(u.email));
    const filtered = q
      ? remaining.filter(u => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      : remaining;
    if (filtered.length === 0) {
      list.appendChild(el('div', { style: 'padding:8px;color:var(--ink-3);font-size:var(--fs-sm)' }, ['候補なし']));
      return;
    }
    for (const u of filtered) {
      list.appendChild(el('div', {
        class: 'spira-asg-option',
        style: [
          'padding:6px 10px', 'cursor:pointer', 'font-size:var(--fs-sm)',
        ].join(';'),
        onclick: () => {
          selected.add(u.email);
          renderChips();
          fire();
          closePop();
        },
      }, [
        el('div', {}, [u.displayName]),
        el('div', { style: 'color:var(--ink-3);font-size:11px' }, [u.email]),
      ]));
    }
  };

  const filterInput = el('input', {
    type: 'text', placeholder: 'ユーザー検索',
    style: [
      'width:100%', 'padding:4px 8px', 'border:1px solid var(--line)',
      'border-radius:var(--r-2)', 'font-size:var(--fs-sm)',
      'background:var(--paper)', 'color:var(--ink)',
    ].join(';'),
  }) as HTMLInputElement;
  filterInput.addEventListener('input', () => renderPopList(filterInput.value));

  const list = el('div', {
    style: 'max-height:240px;overflow-y:auto;margin-top:6px',
  });

  const pop = el('div', {
    class: 'spira-asg-pop',
    style: [
      'display:none', 'position:fixed', 'z-index:2147483700',
      'background:var(--paper)', 'border:1px solid var(--line)',
      'border-radius:var(--r-2)', 'box-shadow:0 4px 12px rgba(0,0,0,0.12)',
      'padding:8px', 'min-width:240px', 'max-width:320px',
    ].join(';'),
  }, [filterInput, list]);

  const openPop = (): void => {
    if (popOpen) { closePop(); return; }
    // #spira-root 配下に置く (SP のホストページに置くと CSS が効かない)
    const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;
    root.appendChild(pop);
    const rect = addBtn.getBoundingClientRect();
    // 画面端で見切れないよう境界調整
    const popWidth = 260;
    const popHeightApprox = 320;
    let top = rect.bottom + 4;
    let left = rect.left;
    if (top + popHeightApprox > window.innerHeight) {
      top = Math.max(8, rect.top - popHeightApprox - 4);
    }
    if (left + popWidth > window.innerWidth) {
      left = Math.max(8, window.innerWidth - popWidth - 8);
    }
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    pop.style.display = 'block';
    popOpen = true;
    filterInput.value = '';
    renderPopList('');
    setTimeout(() => filterInput.focus(), 0);
    setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
  };

  const addBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    style: 'padding:2px 8px',
    onclick: openPop,
  }, [opts.addButtonLabel ?? '+ 担当者']);

  renderChips();

  return {
    el: root,
    getValue: () => {
      const emails = Array.from(selected);
      return {
        emails,
        names: emails.map(e => usersByEmail.get(e)?.displayName ?? e),
      };
    },
    setValue: (emails: string[]) => {
      selected = new Set(emails);
      renderChips();
    },
  };
}
