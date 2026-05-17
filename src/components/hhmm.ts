// Custom HH:MM input.
//
// Native `<input type="time">` doesn't let us move focus from the minute
// segment back to the hour segment via Backspace (the user has to
// Shift+Tab or click). For Spira's "履歴を追加" / "カードを編集" modals
// we want the more natural ergonomics:
//
//   1. Type two digits in the hour box → focus auto-advances to minute.
//   2. Press Backspace while the minute box is empty → focus jumps
//      back to the hour box and the cursor lands at the end of its
//      value, so the next Backspace deletes the last hour digit.
//
// We render the input as two separate <input type=text> segments with
// a ":" between them. Each segment accepts 0–2 digits, clamps to the
// valid range (0–23 for hour, 0–59 for minute), and the wrapping <span>
// looks like a single form field so it sits naturally next to a
// `<input class="spira-input">`.

import { el } from '../utils/dom';

export interface HHMMHandle {
  /** Outer wrapper. Insert this into your form. */
  el: HTMLElement;
  /** Returns 'HH:MM' (zero-padded). Empty string when both segments are blank. */
  getValue(): string;
  /** Set value without firing `onUserEdit`. Use for programmatic defaults. */
  setValueQuiet(value: string): void;
  /** Focus the hour segment. */
  focus(): void;
}

export interface HHMMOptions {
  initial?: string;
  /** Fires whenever the user types or deletes a digit (not on
   *  programmatic setValueQuiet). */
  onUserEdit?: () => void;
  /** When true, the outer wrapper renders without its own border /
   *  background — used when this widget is embedded inside a larger
   *  combined date+time field that already supplies the chrome. */
  bare?: boolean;
}

export function createHHMM(opts: HHMMOptions = {}): HHMMHandle {
  const initial = opts.initial ?? '';
  const m = initial.match(/^(\d{1,2}):(\d{2})/);

  const segStyle =
    'width:2.2em;text-align:center;border:none;outline:none;' +
    'background:transparent;font:inherit;color:inherit;padding:0;margin:0';

  const hour = el('input', {
    type: 'text',
    inputmode: 'numeric',
    maxlength: '2',
    placeholder: 'HH',
    style: segStyle,
    'aria-label': '時間',
  }) as HTMLInputElement;

  const minute = el('input', {
    type: 'text',
    inputmode: 'numeric',
    maxlength: '2',
    placeholder: 'MM',
    style: segStyle,
    'aria-label': '分',
  }) as HTMLInputElement;

  if (m) {
    hour.value = m[1]!.padStart(2, '0');
    minute.value = m[2]!;
  }

  const clampDigits = (s: string, max: number): string => {
    let v = s.replace(/\D/g, '').slice(0, 2);
    if (v.length === 2 && Number(v) > max) v = String(max);
    return v;
  };

  hour.addEventListener('input', () => {
    const before = hour.value;
    hour.value = clampDigits(hour.value, 23);
    // Once two digits are entered, auto-advance to minute.
    if (hour.value.length === 2 && before.length <= 2) {
      minute.focus();
      // Place caret at the end so further typing replaces existing minute.
      minute.setSelectionRange(minute.value.length, minute.value.length);
    }
    opts.onUserEdit?.();
  });

  minute.addEventListener('input', () => {
    minute.value = clampDigits(minute.value, 59);
    opts.onUserEdit?.();
  });

  // Backspace at the start of an empty minute → jump back to hour.
  minute.addEventListener('keydown', (e: KeyboardEvent) => {
    if (
      e.key === 'Backspace' &&
      minute.value === '' &&
      (minute.selectionStart ?? 0) === 0
    ) {
      e.preventDefault();
      hour.focus();
      hour.setSelectionRange(hour.value.length, hour.value.length);
    }
  });

  // Left-arrow at start of minute → jump to end of hour, for parity
  // with the Backspace behavior (so keyboard nav feels symmetric).
  minute.addEventListener('keydown', (e: KeyboardEvent) => {
    if (
      e.key === 'ArrowLeft' &&
      (minute.selectionStart ?? 0) === 0 &&
      (minute.selectionEnd ?? 0) === 0
    ) {
      e.preventDefault();
      hour.focus();
      hour.setSelectionRange(hour.value.length, hour.value.length);
    }
  });

  // Right-arrow at end of hour → jump to start of minute.
  hour.addEventListener('keydown', (e: KeyboardEvent) => {
    if (
      e.key === 'ArrowRight' &&
      (hour.selectionStart ?? 0) === hour.value.length &&
      (hour.selectionEnd ?? 0) === hour.value.length
    ) {
      e.preventDefault();
      minute.focus();
      minute.setSelectionRange(0, 0);
    }
    if (e.key === ':') {
      e.preventDefault();
      minute.focus();
      minute.setSelectionRange(0, minute.value.length);
    }
  });

  const baseStyle = 'display:inline-flex;align-items:center;line-height:1';
  const chromedStyle =
    baseStyle +
    ';border:1px solid var(--line);border-radius:var(--r-2);' +
    'padding:6px 10px;background:var(--paper);min-width:90px';
  const wrap = el('span', {
    style: opts.bare ? baseStyle : chromedStyle,
    onclick: () => {
      if (document.activeElement !== minute) hour.focus();
    },
  }, [
    hour,
    el('span', { style: 'color:var(--ink-3);padding:0 2px' }, [':']),
    minute,
  ]);

  return {
    el: wrap,
    getValue(): string {
      if (!hour.value && !minute.value) return '';
      const h = (hour.value || '0').padStart(2, '0');
      const mi = (minute.value || '0').padStart(2, '0');
      return `${h}:${mi}`;
    },
    setValueQuiet(value: string): void {
      const m2 = value.match(/^(\d{1,2}):(\d{2})/);
      if (m2) {
        hour.value = m2[1]!.padStart(2, '0');
        minute.value = m2[2]!;
      } else {
        hour.value = '';
        minute.value = '';
      }
    },
    focus(): void {
      hour.focus();
      hour.setSelectionRange(0, hour.value.length);
    },
  };
}
