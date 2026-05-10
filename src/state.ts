// Tiny global state — single store with subscribe.
import type { ViewName } from './types';

interface State {
  view: ViewName;
  selectedTicketId: number | null;
  filter: {
    status: string;
    assignee: string;
    priority: string;
    query: string;
  };
  sortBy: 'updated' | 'priority' | 'due';
  sortDir: 'asc' | 'desc';
}

type Listener = () => void;

const state: State = {
  view: 'tickets',
  selectedTicketId: null,
  filter: { status: '', assignee: '', priority: '', query: '' },
  sortBy: 'updated',
  sortDir: 'desc',
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
