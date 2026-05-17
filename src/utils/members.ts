// Internal member registry — emails marked as "内部メンバー" (社内側) for chat coloring.
// Persisted in localStorage. AD picker for adding comes from listSiteUsers().
//
// Teams chat sources don't carry email addresses (only display names), but
// because Teams' displayName comes from the same M365 user record as AD,
// `isInternalAuthor` looks up the displayName against AD to recover the
// underlying email — then checks the email-based internal list as usual.
//   - spira:internal-members → emails (lowercased)
//   - spira:internal-names   → display-name overrides (lowercased) for
//                              edge cases where AD lookup doesn't match
//                              (legacy entries / non-AD chat sources).
// `isInternalAuthor` consults email → AD displayName lookup → override list.

const KEY = 'spira:internal-members';
const KEY_NAMES = 'spira:internal-names';

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch { return []; }
}

function writeList(key: string, values: string[]): void {
  try {
    const cleaned = Array.from(new Set(values.map(e => e.trim().toLowerCase()).filter(Boolean)));
    localStorage.setItem(key, JSON.stringify(cleaned));
  } catch { /* ignore */ }
}

export function getInternalMembers(): string[] { return readList(KEY); }
export function setInternalMembers(emails: string[]): void { writeList(KEY, emails); }
export function addInternalMember(email: string): void {
  setInternalMembers([...getInternalMembers(), email]);
}
export function removeInternalMember(email: string): void {
  setInternalMembers(getInternalMembers().filter(e => e !== email.trim().toLowerCase()));
}

export function getInternalDisplayNames(): string[] { return readList(KEY_NAMES); }
export function setInternalDisplayNames(names: string[]): void { writeList(KEY_NAMES, names); }

export function isInternalMember(email?: string | null): boolean {
  if (!email) return false;
  return getInternalMembers().includes(email.trim().toLowerCase());
}

/** Check whether a comment author is internal. Order of resolution:
 *    1. fromEmail in the internal-members list → internal
 *    2. fromName matches an AD user's displayName whose email is in
 *       the internal-members list → internal (covers Teams paste etc.)
 *    3. fromName in the override list → internal (manual edge cases)
 *
 *  Caller supplies the AD users list (typically `getState().users`) so
 *  this util stays free of cross-module state imports. */
export function isInternalAuthor(
  author: { fromEmail?: string | null; fromName?: string | null },
  adUsers?: ReadonlyArray<{ email: string; displayName: string }>,
): boolean {
  if (author.fromEmail && isInternalMember(author.fromEmail)) return true;

  const name = (author.fromName ?? '').trim().toLowerCase();
  if (!name) return false;

  if (adUsers && adUsers.length) {
    const match = adUsers.find(u => u.displayName.trim().toLowerCase() === name);
    if (match && isInternalMember(match.email)) return true;
  }

  if (getInternalDisplayNames().includes(name)) return true;

  return false;
}

// Stable color picker — same key always maps to the same color.
// 注: index 0 は --warn (#c47f1c) と紛らわしいので避ける。コントラスト
// 強めの 8 色を意図的に分散させ、隣接しても判別しやすくしている。
const PALETTE = [
  '#3d8b8a', // teal
  '#a05a8c', // rose
  '#5e6f5c', // moss
  '#7a8aa9', // slate blue
  '#7c4f8c', // violet
  '#b85a3c', // terracotta
  '#5a7a4d', // forest
  '#4a6b9a', // steel blue
];

export function colorForAuthor(key: string | undefined | null): string {
  const k = (key ?? '').trim().toLowerCase();
  if (!k) return PALETTE[0]!;
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** colorForAuthor と同じ key で、半透明の "tint" 色を返す。
 *  カード背景のうっすらした塗り分けに使う。alpha は 0..1。 */
export function tintForAuthor(key: string | undefined | null, alpha = 0.08): string {
  const hex = colorForAuthor(key);
  // #rrggbb → rgba(r, g, b, alpha)
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
