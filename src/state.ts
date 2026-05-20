// Tiny global state — single store with subscribe.
import type { ViewName, SiteUser } from './types';

interface State {
  view: ViewName;
  selectedTicketId: number | null;
  openTicketIds: number[]; // tabs opened in detail view
  filter: {
    status: string;
    assignee: string;
    priority: string;
    query: string;
  };
  sortBy: 'id' | 'title' | 'status' | 'assignee' | 'priority' | 'due' | 'updated';
  sortDir: 'asc' | 'desc';
  // cached counts shown in sidebar
  inboxCount: number;
  trashCount: number;
  // cached AD picker users
  users: SiteUser[];
  /** 現在ログインしているユーザー (bootstrap で取得)。 */
  currentUser: SiteUser | null;
  /** 現在接続中の SP サイトの表示名 (workspace 表記)。bootstrap 時に取得。 */
  siteTitle: string | null;
  /** 現在の SP サイト URL (workspace 表記のリンク用)。 */
  siteUrl: string | null;
  // bootstrap status
  ready: boolean;
  errorBanner: string | null;
  /** 古いビルドを使っている時の更新案内バナー。null なら非表示。 */
  updateBanner: { message: string; url: string | null } | null;
}

type Listener = () => void;

const state: State = {
  view: 'tickets',
  selectedTicketId: null,
  openTicketIds: [],
  filter: { status: '', assignee: '', priority: '', query: '' },
  sortBy: 'updated',
  sortDir: 'desc',
  inboxCount: 0,
  trashCount: 0,
  users: [],
  currentUser: null,
  siteTitle: null,
  siteUrl: null,
  ready: false,
  errorBanner: null,
  updateBanner: null,
};

const listeners = new Set<Listener>();

export function getState(): Readonly<State> { return state; }

export function setState(
  patch: Partial<State> | ((s: State) => Partial<State>),
  opts: { silent?: boolean } = {},
): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  Object.assign(state, next);
  // silent=true でリスナを呼ばずに state だけ更新する。自動同期 (auto-sync) の
  // inbox カウント更新など、画面全体の再描画 (paintMain) を起こしたくない
  // 軽微な更新で使う。値は次回の通常 setState や手動操作で UI に反映される。
  if (opts.silent) return;
  for (const l of listeners) l();
}

export function setFilter(patch: Partial<State['filter']>): void {
  Object.assign(state.filter, patch);
  for (const l of listeners) l();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
