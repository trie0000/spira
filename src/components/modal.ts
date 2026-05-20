import { el } from '../utils/dom';
import { icon } from '../icons';

interface ModalOptions {
  title: string;
  body: HTMLElement;
  size?: 'default' | 'lg' | 'xl';
  primaryLabel?: string;
  primaryVariant?: 'primary' | 'danger' | 'dark';
  onPrimary?: () => void | Promise<void>;
  cancelLabel?: string;
  hideCancel?: boolean;
  /** モーダルが閉じる時 (× / Esc / backdrop / primary 完了後) に必ず呼ばれる。 */
  onClose?: () => void;
}

// B2: モーダルのスタック。多階層モーダルで Esc / Ctrl+Enter が最前面のみに
// 効くように、現在開いているモーダル backdrop の順序を保持する。
const modalStack: HTMLElement[] = [];

export interface ModalHandle {
  close(): void;
  setPrimaryDisabled(disabled: boolean): void;
}

export function openModal(root: HTMLElement, opts: ModalOptions): ModalHandle {
  const primaryLabel = opts.primaryLabel ?? 'OK';
  const primaryVariant = opts.primaryVariant ?? 'primary';
  const cancelLabel = opts.cancelLabel ?? 'キャンセル';

  const primaryBtn = el('button', {
    type: 'button',
    class: `spira-btn spira-btn--${primaryVariant}`,
    onclick: async () => {
      if (!opts.onPrimary) { close(); return; }
      try {
        primaryBtn.setAttribute('disabled', '');
        await opts.onPrimary();
        close();
      } finally {
        primaryBtn.removeAttribute('disabled');
      }
    },
  }, [primaryLabel]);

  const cancelBtn = opts.hideCancel ? null : el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--secondary',
    onclick: () => close(),
  }, [cancelLabel]);

  const closeBtn = el('button', {
    type: 'button',
    class: 'spira-iconbtn spira-modal-close',
    'aria-label': '閉じる',
    onclick: () => close(),
    html: icon('x'),
  });

  const sizeClass = opts.size === 'xl' ? ' spira-modal--xl' : opts.size === 'lg' ? ' spira-modal--lg' : '';
  const modal = el('div', { class: `spira-modal${sizeClass}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'spira-modal-header' }, [
      el('h2', { class: 'spira-modal-title' }, [opts.title]),
      closeBtn,
    ]),
    el('div', { class: 'spira-modal-body' }, [opts.body]),
    el('div', { class: 'spira-modal-footer' }, [
      ...(cancelBtn ? [cancelBtn] : []),
      primaryBtn,
    ]),
  ]);

  const backdrop = el('div', {
    class: 'spira-modal-backdrop',
    onclick: (e: Event) => { if (e.target === backdrop) close(); },
  }, [modal]);

  function onKey(e: KeyboardEvent) {
    // B2: モーダルが多階層に重なった時、Esc / Ctrl+Enter で最前面のみ
    // 処理する。stopImmediatePropagation で他の (背後の) モーダルの listener へ
    // 到達させない。最前面判定は modalStack の末尾と自分が一致するか。
    if (modalStack[modalStack.length - 1] !== backdrop) return;
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.stopImmediatePropagation();
      primaryBtn.click();
    } else if (e.key === 'Tab') {
      // M4: focus trap — フォーカスが modal 内をループするように制御。
      // 最前面 modal でのみ動作。
      const focusables = modal.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
        'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !modal.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    const idx = modalStack.indexOf(backdrop);
    if (idx >= 0) modalStack.splice(idx, 1);
    try { opts.onClose?.(); } catch (e) { console.warn('[spira] modal onClose error:', e); }
  }

  modalStack.push(backdrop);
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);

  // focus first input/textarea/button
  setTimeout(() => {
    const first = modal.querySelector<HTMLElement>('input, textarea, select, button.spira-btn--primary');
    first?.focus();
  }, 0);

  return {
    close,
    setPrimaryDisabled(d) { d ? primaryBtn.setAttribute('disabled', '') : primaryBtn.removeAttribute('disabled'); },
  };
}

export function confirmModal(root: HTMLElement, opts: {
  title: string;
  message: string;
  primaryLabel?: string;
  primaryVariant?: 'primary' | 'danger';
  onConfirm: () => void | Promise<void>;
  /** ユーザーがキャンセル / Esc / × で閉じた時のロールバック処理。 */
  onCancel?: () => void;
}): void {
  // Use a div with `white-space: pre-line` so newlines in the message are preserved.
  const body = el('div', { class: 'spira-modal-body', style: 'white-space:pre-line;line-height:1.7' }, [opts.message]);
  let confirmed = false;
  const handle = openModal(root, {
    title: opts.title,
    body,
    primaryLabel: opts.primaryLabel ?? 'OK',
    primaryVariant: opts.primaryVariant ?? 'primary',
    onPrimary: async () => {
      confirmed = true;
      await opts.onConfirm();
    },
    onClose: () => {
      // primary 押下で閉じた場合は何もしない (confirmed=true)。
      // Esc / × / キャンセルボタンで閉じた場合のみロールバック。
      if (!confirmed && opts.onCancel) opts.onCancel();
    },
  });
  void handle;
}
