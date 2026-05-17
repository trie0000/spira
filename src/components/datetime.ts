// Custom YYYY/MM/DD HH:MM widget.
//
// Replaces the date+time combo built from native `<input type="date">`
// + a separate HH:MM input. Native pickers were unreliable: year length
// wasn't capped to 4 digits, the calendar icon was nailed to the left
// edge of the date field, and keyboard navigation between segments was
// inconsistent across browsers.
//
// This widget renders 5 text segments (YYYY / MM / DD HH : MM) inside
// a single bordered wrapper, with a calendar-icon button on the RIGHT
// that pops the OS's native date picker via a hidden `<input type="date">`.
// Behavior:
//
//   - Each segment is a `<input type="text" inputmode="numeric">` with
//     digits-only filtering and a hard `maxlength`.
//   - Auto-advance: once a segment is filled (or a clearly-out-of-range
//     prefix is typed), focus jumps to the next segment.
//   - Backspace at the start of an empty segment moves focus to the
//     previous segment's last character — symmetric across all 5 boxes,
//     so the user can keep deleting their way leftward.
//   - ArrowLeft / ArrowRight at segment boundaries also navigate.
//   - The calendar button opens `showPicker()` on the hidden input;
//     selecting a date updates YYYY/MM/DD (HH:MM untouched).
//   - The user can leave any segment blank — `getValue()` returns ''
//     for incomplete entries so callers can decide what to do.

import { el } from '../utils/dom';
import { icon } from '../icons';

export interface DateTimeHandle {
  el: HTMLElement;
  /** ISO 'YYYY-MM-DDTHH:MM' when all segments are valid; '' otherwise. */
  getValue(): string;
  /** Accepts ISO strings ('YYYY-MM-DD' / 'YYYY-MM-DDTHH:MM[:SS][...]')
   *  or `Date`. Updates without firing `onUserEdit`. */
  setValueQuiet(value: string | Date | null | undefined): void;
  focus(): void;
}

export interface DateTimeOptions {
  /** Initial value (ISO string or Date). */
  initial?: string | Date;
  /** Fires whenever the user types or deletes in any segment. */
  onUserEdit?: () => void;
}

interface Segment {
  input: HTMLInputElement;
  len: 2 | 4;
  min: number;
  max: number;
  /** Max value of the first digit before we auto-advance after one keystroke
   *  (e.g. typing "5" in month immediately advances because 5 > 1). */
  autoAdvanceAfterOne: number;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function parseInitial(value: string | Date | null | undefined): {
  y: string; mo: string; d: string; h: string; mi: string;
} {
  const empty = { y: '', mo: '', d: '', h: '', mi: '' };
  if (!value) return empty;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime())) {
    // Try a partial 'YYYY-MM-DD' match for plain date strings.
    if (typeof value === 'string') {
      const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
      if (m) return { y: m[1]!, mo: m[2]!, d: m[3]!, h: m[4] ?? '', mi: m[5] ?? '' };
    }
    return empty;
  }
  return {
    y: pad(date.getFullYear(), 4),
    mo: pad(date.getMonth() + 1, 2),
    d: pad(date.getDate(), 2),
    h: pad(date.getHours(), 2),
    mi: pad(date.getMinutes(), 2),
  };
}

const segInputStyle =
  'border:none;outline:none;background:transparent;' +
  'font:inherit;color:inherit;padding:0;margin:0;text-align:center';

export function createDateTime(opts: DateTimeOptions = {}): DateTimeHandle {
  const init = parseInitial(opts.initial);

  // We intentionally OMIT `maxlength` here. With maxlength enforced,
  // typing into a segment whose value is already at the limit with
  // no selection is silently rejected by the browser — which the user
  // perceives as "the input doesn't accept keyboard". Instead we trim
  // overflow in the input handler below and treat extra digits as
  // "overwrite the rightmost N chars" so the latest keystroke wins.
  const make = (placeholder: string, width: string, aria: string): HTMLInputElement =>
    el('input', {
      type: 'text',
      inputmode: 'numeric',
      placeholder,
      style: `${segInputStyle};width:${width}`,
      'aria-label': aria,
    }, []) as HTMLInputElement;

  // Tightened widths: 4ch for year, 2ch for 2-digit segments. The wrap
  // CSS centers content, so this keeps each segment snug against its
  // separator without weird interior padding.
  const yIn  = make('YYYY', '2.8em', '年');
  const moIn = make('MM',   '1.4em', '月');
  const dIn  = make('DD',   '1.4em', '日');
  const hIn  = make('HH',   '1.4em', '時');
  const miIn = make('MM',   '1.4em', '分');
  yIn.value = init.y; moIn.value = init.mo; dIn.value = init.d;
  hIn.value = init.h; miIn.value = init.mi;

  const segs: Segment[] = [
    { input: yIn,  len: 4, min: 1900, max: 2999, autoAdvanceAfterOne: 0 }, // never auto-advance after 1 digit (year is 4)
    { input: moIn, len: 2, min: 1,    max: 12,   autoAdvanceAfterOne: 1 }, // '2' → 12 only, '3' → no month
    { input: dIn,  len: 2, min: 1,    max: 31,   autoAdvanceAfterOne: 3 }, // up to 3 may continue
    { input: hIn,  len: 2, min: 0,    max: 23,   autoAdvanceAfterOne: 2 },
    { input: miIn, len: 2, min: 0,    max: 59,   autoAdvanceAfterOne: 5 },
  ];

  // Wire each segment.
  segs.forEach((seg, idx) => {
    const isLast = idx === segs.length - 1;
    const next = segs[idx + 1]?.input;
    const prev = segs[idx - 1]?.input;

    seg.input.addEventListener('input', () => {
      // Normalize full-width digits (０-９, common when IME is in
      // hiragana/katakana mode) into ASCII (0-9) FIRST, then strip
      // anything that still isn't a digit. Without this normalization
      // the FW digit ５ produced by Japanese IME failed the \D filter
      // and got silently stripped — which the user perceived as
      // "the input rejects keyboard typing".
      let v = seg.input.value
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/\D/g, '');
      if (v.length > seg.len) v = v.slice(-seg.len);
      seg.input.value = v;

      // Auto-advance:
      //   - segment is full length
      //   - OR for 2-digit segments, the first digit exceeds the
      //     "could-still-be-a-prefix" threshold (e.g. month: '5' → can't
      //     start with 5 since max is 12, so jump to next)
      if (v.length === seg.len) {
        if (next) { next.focus(); next.setSelectionRange(0, next.value.length); }
      } else if (
        v.length === 1 &&
        seg.len === 2 &&
        Number(v) > seg.autoAdvanceAfterOne
      ) {
        // Pad single digit so it round-trips back as 'NN' (e.g. month
        // "5" → "05") so future blur / save can read it correctly.
        seg.input.value = '0' + v;
        if (next) { next.focus(); next.setSelectionRange(0, next.value.length); }
      }
      opts.onUserEdit?.();
    });

    seg.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (
        e.key === 'Backspace' &&
        seg.input.value === '' &&
        (seg.input.selectionStart ?? 0) === 0 &&
        prev
      ) {
        e.preventDefault();
        prev.focus();
        prev.setSelectionRange(prev.value.length, prev.value.length);
      }
      if (
        e.key === 'ArrowLeft' &&
        (seg.input.selectionStart ?? 0) === 0 &&
        (seg.input.selectionEnd ?? 0) === 0 &&
        prev
      ) {
        e.preventDefault();
        prev.focus();
        prev.setSelectionRange(prev.value.length, prev.value.length);
      }
      if (
        e.key === 'ArrowRight' &&
        (seg.input.selectionStart ?? 0) === seg.input.value.length &&
        (seg.input.selectionEnd ?? 0) === seg.input.value.length &&
        next
      ) {
        e.preventDefault();
        next.focus();
        next.setSelectionRange(0, 0);
      }
      if (e.key === '/' || e.key === ':' || e.key === ' ' || e.key === 'Tab') {
        // Separator characters jump to next segment (Tab keeps its
        // default behaviour for non-last segment too — browser handles).
        if ((e.key === '/' || e.key === ':' || e.key === ' ') && next) {
          e.preventDefault();
          next.focus();
          next.setSelectionRange(0, next.value.length);
        }
      }
      // Validate range on Enter / Blur (handled separately below).
      if (e.key === 'Enter' && isLast) {
        seg.input.blur();
      }
    });

    // On blur, zero-pad and clamp to valid range so the segment looks
    // canonical and saves correctly.
    seg.input.addEventListener('blur', () => {
      const raw = seg.input.value.replace(/\D/g, '');
      if (!raw) return;
      let n = Number(raw);
      if (n < seg.min) n = seg.min;
      if (n > seg.max) n = seg.max;
      seg.input.value = pad(n, seg.len);
    });

    // Select-all on click. `click` fires AFTER the browser has placed
    // the caret (unlike `mouseup` which can fire before / race with
    // selection), so calling select() here reliably highlights all
    // digits in the segment. The user's next keystroke then replaces
    // them — this is the fix for "数字入力ができない", which was the
    // browser silently rejecting keystrokes whenever the input was at
    // its visible width with no selection.
    seg.input.addEventListener('click', () => {
      seg.input.select();
    });
    // For keyboard Tab focus (no click), select via focus+setTimeout
    // so the focus is settled before we call select().
    seg.input.addEventListener('focus', (e) => {
      // Skip if this focus came from a mouse interaction — the click
      // handler above will select. Detecting that here is awkward, so
      // we always queue a setTimeout select; the click handler still
      // runs after focus, leaving the input properly selected.
      void e;
      setTimeout(() => {
        if (document.activeElement === seg.input) seg.input.select();
      }, 0);
    });
  });

  // Native datetime-local input overlaid on the calendar icon. The
  // browser's native picker varies by OS/browser but at least the
  // user can pick a date+time from it. (User asked us not to build a
  // full custom popover — falling back to native.)
  const hiddenPicker = el('input', {
    type: 'datetime-local',
    'aria-label': 'カレンダーから日時を選択',
    title: 'カレンダーから日時を選択',
    style:
      'position:absolute;inset:0;opacity:0;' +
      'border:none;background:transparent;padding:0;margin:0;' +
      'cursor:pointer;width:100%;height:100%',
  }) as HTMLInputElement;

  const updateFromPicker = (): void => {
    const v = hiddenPicker.value;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (m) {
      yIn.value = m[1]!;
      moIn.value = m[2]!;
      dIn.value = m[3]!;
      if (m[4] && m[5]) {
        hIn.value = m[4];
        miIn.value = m[5];
      }
      opts.onUserEdit?.();
    }
  };
  // Listen to both `input` (fires as the user scrolls / changes in
  // the native picker) and `change` (fires when the picker closes).
  hiddenPicker.addEventListener('input', updateFromPicker);
  hiddenPicker.addEventListener('change', updateFromPicker);

  const seedHiddenPickerValue = (): void => {
    if (yIn.value && moIn.value && dIn.value) {
      const h = (hIn.value || '00').padStart(2, '0');
      const mi = (miIn.value || '00').padStart(2, '0');
      hiddenPicker.value =
        `${yIn.value.padStart(4, '0')}-${moIn.value.padStart(2, '0')}-${dIn.value.padStart(2, '0')}T${h}:${mi}`;
    }
  };
  hiddenPicker.addEventListener('mousedown', seedHiddenPickerValue);
  hiddenPicker.addEventListener('focus', seedHiddenPickerValue);

  const calendarBtn = el('span', {
    style:
      'position:relative;display:inline-flex;align-items:center;' +
      'cursor:pointer;color:var(--ink-3);padding:2px 4px;' +
      'border-radius:var(--r-2)',
    title: 'カレンダーから日時を選択',
  }, [
    el('span', { html: icon('calendar'), style: 'width:16px;height:16px;display:inline-flex' }),
    hiddenPicker,
  ]);

  // Tight separator — no padding around. Used between date / time segs.
  const sep = (s: string): HTMLElement =>
    el('span', { style: 'color:var(--ink-3)' }, [s]);

  const wrap = el('span', {
    // Matches `.spira-input` cosmetics: transparent until hover/focus
    // so the widget melts into the surrounding form when not active.
    // Border + paper background only appear when one of the segments
    // (or the calendar button) is focused (`:focus-within`).
    class: 'spira-dt-wrap',
    onclick: (e: Event) => {
      // If user clicks inside the wrap but NOT on a focusable child,
      // focus the year input. This makes click-to-type discoverable for
      // users who hit the `/` separator or the inter-segment whitespace.
      const target = e.target as HTMLElement;
      if (
        target === wrap ||
        target.tagName === 'SPAN' && !target.querySelector('input,button')
      ) {
        yIn.focus();
      }
    },
  }, [
    yIn, sep('/'), moIn, sep('/'), dIn,
    // Date↔time gap kept tight (just a single space-width).
    el('span', { style: 'width:0.6em;display:inline-block' }, []),
    hIn, sep(':'), miIn,
    el('span', { style: 'width:0.4em;display:inline-block' }, []),
    calendarBtn,
  ]);

  return {
    el: wrap,
    getValue(): string {
      const y = yIn.value, mo = moIn.value, d = dIn.value;
      const h = hIn.value, mi = miIn.value;
      if (!y || !mo || !d) return '';
      const Y = pad(Number(y), 4), Mo = pad(Number(mo), 2), D = pad(Number(d), 2);
      const H = h ? pad(Number(h), 2) : '00';
      const M = mi ? pad(Number(mi), 2) : '00';
      return `${Y}-${Mo}-${D}T${H}:${M}`;
    },
    setValueQuiet(value): void {
      const p = parseInitial(value);
      yIn.value = p.y; moIn.value = p.mo; dIn.value = p.d;
      hIn.value = p.h; miIn.value = p.mi;
    },
    focus(): void {
      yIn.focus();
      yIn.setSelectionRange(0, yIn.value.length);
    },
  };
}
