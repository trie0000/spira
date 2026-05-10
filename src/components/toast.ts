import { el, qs } from '../utils/dom';

type Variant = 'default' | 'ok' | 'warn' | 'error';

function ensureStack(root: HTMLElement): HTMLElement {
  let stack = qs('.spira-toast-stack', root);
  if (!stack) {
    stack = el('div', { class: 'spira-toast-stack', role: 'status', 'aria-live': 'polite' });
    root.appendChild(stack);
  }
  return stack;
}

export function toast(root: HTMLElement, msg: string, variant: Variant = 'default', durationMs = 4000): void {
  const stack = ensureStack(root);
  const cls = ['spira-toast'];
  if (variant !== 'default') cls.push(`spira-toast--${variant}`);
  const node = el('div', { class: cls.join(' ') }, [msg]);
  stack.appendChild(node);
  const ttl = variant === 'error' ? 0 : durationMs;
  if (ttl > 0) {
    setTimeout(() => {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, ttl);
  } else {
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => node.remove());
  }
}
