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
  ready: false,
  errorBanner: null,
  updateBanner: null,
};

const listeners = new Set<Listener>();

export function getState(): Readonly<State> { return state; }

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  Object.assign(state, next);
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
