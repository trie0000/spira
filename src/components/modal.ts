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
}

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
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      primaryBtn.click();
    }
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

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
}): void {
  // Use a div with `white-space: pre-line` so newlines in the message are preserved.
  const body = el('div', { class: 'spira-modal-body', style: 'white-space:pre-line;line-height:1.7' }, [opts.message]);
  openModal(root, {
    title: opts.title,
    body,
    primaryLabel: opts.primaryLabel ?? 'OK',
    primaryVariant: opts.primaryVariant ?? 'primary',
    onPrimary: opts.onConfirm,
  });
}
