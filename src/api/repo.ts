// Repository abstraction — backed by SP REST in production, in-memory mock in dev.
import type { Ticket, Comment, InboxMail, SiteUser, InboxState, TicketStatus, Priority } from '../types';

export interface CreateTicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  priority?: Priority;
  assigneeEmail?: string;
  reporterEmail?: string;
  reporterName?: string;
  dueDate?: string;
  rawSubject?: string;
  initialConversationId?: string;
}

export interface AddCommentInput {
  ticketId: number;
  type: 'received' | 'note';
  fromEmail?: string;
  fromName?: string;
  content: string;
  isHtml: boolean;
  sentAt?: string;
  sourceEmailId?: number;
}

export interface SyncResult {
  autoLinked: number;
  remaining: number;
  errors: string[];
}

export interface Repository {
  // bootstrap (SP only — no-op for mock)
  ensureLists(): Promise<{ created: string[] }>;

  // tickets
  listTickets(opts?: { includeDeleted?: boolean }): Promise<Ticket[]>;
  listDeletedTickets(): Promise<Ticket[]>;
  getTicket(id: number): Promise<Ticket | null>;
  createTicket(input: CreateTicketInput): Promise<Ticket>;
  updateTicket(id: number, patch: Partial<Ticket>): Promise<Ticket | null>;
  softDeleteTicket(id: number): Promise<void>;
  restoreTicket(id: number): Promise<void>;
  hardDeleteTicket(id: number): Promise<void>;
  emptyTrash(): Promise<void>;

  // comments
  listComments(ticketId: number): Promise<Comment[]>;
  addComment(input: AddCommentInput): Promise<Comment>;

  // inbox
  listInbox(opts?: { unprocessedOnly?: boolean }): Promise<InboxMail[]>;
  markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void>;
  syncInbox(): Promise<SyncResult>;

  // users (AD picker)
  listSiteUsers(): Promise<SiteUser[]>;

  // dev helper (mock only)
  injectFakeReply?(ticketId: number): void;

  // Sample data seed — useful before PA is set up.
  // Adds 5 sample InboxMails to the underlying list.
  addSampleInbox(): Promise<{ count: number }>;
}

// ----- factory -----

let _repo: Repository | null = null;
let _mode: 'mock' | 'sp' = 'mock';

export function getRepo(): Repository {
  if (!_repo) throw new Error('Repository not initialized. Call initRepo() first.');
  return _repo;
}

export function getRepoMode(): 'mock' | 'sp' {
  return _mode;
}

export async function initRepo(): Promise<{ mode: 'mock' | 'sp'; siteUrl?: string }> {
  const useMock = shouldUseMock();
  if (useMock) {
    const { MockRepository, seedMock } = await import('./mock');
    seedMock();
    _repo = new MockRepository();
    _mode = 'mock';
    return { mode: 'mock' };
  }
  const { SpRepository, detectSpConfig } = await import('./sp');
  const cfg = detectSpConfig();
  _repo = new SpRepository(cfg);
  _mode = 'sp';
  return { mode: 'sp', siteUrl: cfg.siteUrl };
}

function shouldUseMock(): boolean {
  // Explicit ?mock=1 always wins.
  const params = new URLSearchParams(location.search);
  if (params.has('mock')) return params.get('mock') !== '0';
  // Off-SP host (e.g. localhost dev) → mock.
  return !location.hostname.endsWith('.sharepoint.com');
}
