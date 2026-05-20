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

/** 名前文字列の比較用バリアント列挙。
 *
 *  Teams チャット由来の送信者名は AD displayName と「同じ人なのに微妙に違う」
 *  形で渡されることが多い:
 *    - "山田 太郎 (Yamada Taro)" vs "山田 太郎" vs "Yamada Taro"
 *    - "John Smith (山田)" vs "John Smith" vs "山田"
 *    - 全角/半角の空白・括弧の混在
 *    - 大文字小文字 (アルファベット表記)
 *
 *  なのでマッチング時は「いずれかのバリアントが一致したら同一人物」と
 *  判定するため、文字列を以下の候補に展開する:
 *    1. 正規化済みフル文字列 (lowercase + 全角→半角の空白/括弧 + 余分な空白圧縮)
 *    2. 括弧部分を除外した文字列 (例: "山田 太郎")
 *    3. 各括弧の中身 (例: "Yamada Taro")
 *  返り値は重複を除いた配列。 */
export function nameVariants(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  const base = s
    .replace(/　/g, ' ')   // 全角スペース → 半角
    .replace(/[（]/g, '(')     // 全角開き括弧
    .replace(/[）]/g, ')')     // 全角閉じ括弧
    .replace(/\s+/g, ' ')      // 連続空白を 1 つに
    .toLowerCase()
    .trim();
  if (!base) return [];
  const variants = new Set<string>();
  variants.add(base);
  // 括弧部分を抜いた本体
  const stripped = base.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped) variants.add(stripped);
  // 各括弧の中身
  const parenMatches = base.match(/\(([^)]+)\)/g);
  if (parenMatches) {
    for (const m of parenMatches) {
      const inner = m.slice(1, -1).trim();
      if (inner) variants.add(inner);
    }
  }
  return Array.from(variants);
}

/** Check whether a comment author is internal. Order of resolution:
 *    1. fromEmail in the internal-members list → internal
 *    2. fromName matches an AD user's displayName (バリアント比較; 大小・全角半角・
 *       括弧の有無を吸収) whose email is in the internal-members list → internal
 *       (Teams paste 等の表示名揺れに対応)
 *    3. fromName のいずれかのバリアントが override list に含まれる → internal
 *
 *  Caller supplies the AD users list (typically `getState().users`) so
 *  this util stays free of cross-module state imports. */
export function isInternalAuthor(
  author: { fromEmail?: string | null; fromName?: string | null },
  adUsers?: ReadonlyArray<{ email: string; displayName: string }>,
): boolean {
  if (author.fromEmail && isInternalMember(author.fromEmail)) return true;

  const authorVariants = nameVariants(author.fromName);
  if (authorVariants.length === 0) return false;
  const authorSet = new Set(authorVariants);

  if (adUsers && adUsers.length) {
    for (const u of adUsers) {
      const userVariants = nameVariants(u.displayName);
      for (const v of userVariants) {
        if (authorSet.has(v)) {
          if (isInternalMember(u.email)) return true;
          break; // 同じ AD ユーザに別バリアントを試しても無駄
        }
      }
    }
  }

  // override 名前リストもバリアント比較で照合 (legacy エントリは生文字列で
  // 保存されている可能性があるので、保存値側もバリアント化して比較)。
  const overrides = getInternalDisplayNames();
  for (const n of overrides) {
    const ov = nameVariants(n);
    for (const v of ov) {
      if (authorSet.has(v)) return true;
    }
  }

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
