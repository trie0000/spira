// Internal member registry — emails marked as "内部メンバー" (社内側) for chat coloring.
// Persisted in localStorage. AD picker for adding comes from listSiteUsers().

const KEY = 'spira:internal-members';

export function getInternalMembers(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch { return []; }
}

export function setInternalMembers(emails: string[]): void {
  try {
    const cleaned = Array.from(new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean)));
    localStorage.setItem(KEY, JSON.stringify(cleaned));
  } catch { /* ignore */ }
}

export function addInternalMember(email: string): void {
  const cur = getInternalMembers();
  setInternalMembers([...cur, email]);
}

export function removeInternalMember(email: string): void {
  const cur = getInternalMembers();
  setInternalMembers(cur.filter(e => e !== email.trim().toLowerCase()));
}

export function isInternalMember(email?: string | null): boolean {
  if (!email) return false;
  return getInternalMembers().includes(email.trim().toLowerCase());
}

// Stable color picker — same key always maps to the same color.
const PALETTE = [
  '#c47f1c', // amber
  '#5e6f5c', // moss
  '#7a8aa9', // slate blue
  '#a05a8c', // rose
  '#3d8b8a', // teal
  '#9b6e3a', // bronze
  '#7c4f8c', // violet
  '#5a7a4d', // forest
];

export function colorForAuthor(key: string | undefined | null): string {
  const k = (key ?? '').trim().toLowerCase();
  if (!k) return PALETTE[0]!;
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}
