// Per-user "last seen" state for tickets.
//
// We track, per user, the wall-clock time at which they last opened
// each ticket's detail view. New / updated comments after that timestamp
// are highlighted with a "NEW" badge so the user can spot fresh
// activity at a glance.
//
// Storage:
//   - localStorage (per-browser, per-origin).
//   - Key: `spira:last-seen:<user>:<ticketId>` → number of milliseconds.
//   - `<user>` is the SP-context user login name when available, else
//     `'default'`. This naturally separates state when multiple users
//     log into the same browser via different profiles, while still
//     working in the mock / dev environment.
//
// We INTENTIONALLY snapshot the previous last-seen timestamp at the
// moment the ticket detail mounts and use that for badge calculations.
// The new last-seen (= now) is written immediately so the NEXT visit
// has the right reference point. Result: the user sees NEW badges on
// items that arrived between their previous visit and now, and those
// badges disappear when they revisit later.

const KEY_PREFIX = 'spira:last-seen:';

function currentUserKey(): string {
  const ctx = (window as unknown as { _spPageContextInfo?: { userLoginName?: string; userEmail?: string } })
    ._spPageContextInfo;
  return (ctx?.userLoginName || ctx?.userEmail || 'default').toLowerCase();
}

function storageKey(ticketId: number): string {
  return `${KEY_PREFIX}${currentUserKey()}:${ticketId}`;
}

/** Returns the user's last-seen timestamp (ms) for the given ticket,
 *  or `null` if they've never opened it. */
export function getLastSeen(ticketId: number): number | null {
  try {
    const raw = localStorage.getItem(storageKey(ticketId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Stamp `now` as the user's last-seen for this ticket. Call when the
 *  user opens / views the ticket detail. */
export function markTicketSeen(ticketId: number): void {
  try {
    localStorage.setItem(storageKey(ticketId), String(Date.now()));
  } catch {
    /* localStorage unavailable / quota — ignore */
  }
}

/** Is the comment newer than the user's last visit?
 *  - `lastSeenMs == null` → first-ever visit → false (no NEW badge).
 *  - `commentIso` invalid → false (defensive).
 *  - Otherwise compare via Date parsing. */
export function isCommentNewSince(
  commentIso: string | null | undefined,
  lastSeenMs: number | null,
): boolean {
  if (lastSeenMs == null) return false;
  if (!commentIso) return false;
  const ts = new Date(commentIso).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts > lastSeenMs;
}

/** Does the ticket have ANY comment newer than the user's last visit?
 *  Used by the ticket-list view to decorate rows with new activity. */
export function hasNewSince(
  comments: ReadonlyArray<{ sentAt?: string | null }>,
  lastSeenMs: number | null,
): boolean {
  if (lastSeenMs == null) return false;
  for (const c of comments) {
    if (isCommentNewSince(c.sentAt ?? null, lastSeenMs)) return true;
  }
  return false;
}
