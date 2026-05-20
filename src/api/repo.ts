// Repository abstraction — backed by SP REST in production, in-memory mock in dev.
import type {
  Ticket, Comment, InboxMail, SiteUser, InboxState, TicketStatus, Priority,
  AuditRecord, AuditAction, AuditTargetType,
} from '../types';

export interface AppendAuditInput {
  action: AuditAction;
  ticketId: number;
  targetType: AuditTargetType;
  targetId?: number;
  /** 任意のメタデータ。書込時に JSON.stringify される。 */
  details?: Record<string, unknown>;
  /** 任意のオーバーライド。通常は audit.ts が currentUser から自動補完するが、
   *  バックグラウンドで実行ユーザを明示したい場合に指定。 */
  actorEmail?: string;
  actorName?: string;
  /** 保持期限の上書き (ISO)。指定しない場合は呼出元で AuditEmitter が
   *  retention 設定から計算して埋める。 */
  expiresAt?: string;
}

export interface ListAuditOpts {
  /** 期間で絞り込み (ISO、両端含む)。 */
  fromTime?: string;
  toTime?: string;
  /** 特定チケットの履歴のみ。0 なら ticket-less も含む。 */
  ticketId?: number;
  /** アクション種別フィルタ。 */
  action?: AuditAction;
  /** 実行ユーザのメール一致。 */
  actorEmail?: string;
  /** 最大取得件数。SP の上限負荷を避けるため既定 500。 */
  limit?: number;
}

export interface CreateTicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  priority?: Priority;
  assigneeEmails?: string[];
  department?: string;
  inquiryCategory?: string;
  reporterEmail?: string;
  reporterName?: string;
  dueDate?: string;
  rawSubject?: string;
  initialConversationId?: string;
  source?: import('../types').SourceKind;
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
  hasAttachments?: boolean;
  internetMessageId?: string;
  source?: import('../types').SourceKind;
  /** 'internal' = 内部スレッド (社内向け) / 'external' = 外部スレッド (顧客向け)。
   *  type='note' のときは無視される。Teams 自動同期では syncInbox が設定する。 */
  threadKind?: 'internal' | 'external';
}

export interface SyncResult {
  autoLinked: number;
  remaining: number;
  errors: string[];
}

export interface ResetResult {
  deleted: string[];
  recreated: string[];
  addedFields: string[];
}

export interface Repository {
  // bootstrap (SP only — no-op for mock)
  ensureLists(): Promise<{ created: string[]; addedFields?: string[] }>;

  // 危険: 全リストを削除して再作成する。Tickets / Comments / InboxMails の
  // 中身は全て失われる。設定メニューから明示的な確認後にのみ呼び出すこと。
  resetLists(): Promise<ResetResult>;

  // tickets
  listTickets(opts?: { includeDeleted?: boolean }): Promise<Ticket[]>;
  listDeletedTickets(): Promise<Ticket[]>;
  /** Free-text search across tickets and comments. Returns matched
   *  tickets paired with their matching comments. Used by the
   *  cross-ticket search view. */
  searchAll(query: string): Promise<{
    tickets: Ticket[];
    commentsByTicket: Map<number, Comment[]>;
  }>;
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
  /** Update a comment in place. All fields are optional; only the
   *  provided ones are written.
   *
   *  Pass `isHtml: false` after migrating a legacy HTML memo to the new
   *  markdown editor — otherwise the SP row keeps `IsHtml=true` and the
   *  next reload treats the saved markdown as HTML, hiding everything
   *  past the first markdown character that looks like an HTML tag
   *  (e.g. `>` for blockquote).
   *
   *  `fromName` / `fromEmail` / `sentAt` are used by the "対応履歴の編集"
   *  UI in ticket detail so the user can fix a wrong speaker / time
   *  after registration. */
  updateComment(
    id: number,
    patch: {
      content?: string;
      isHtml?: boolean;
      fromName?: string | null;
      fromEmail?: string | null;
      sentAt?: string;
      source?: import('../types').SourceKind;
    },
  ): Promise<void>;
  deleteComment(id: number): Promise<void>;

  // inbox
  listInbox(opts?: { unprocessedOnly?: boolean; includeHidden?: boolean }): Promise<InboxMail[]>;
  markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void>;
  hideInboxItems(ids: number[]): Promise<void>;
  unhideInboxItems(ids: number[]): Promise<void>;
  /** InboxMails リストから物理削除。auto-link 後やノイズメールの掃除で使う。 */
  deleteInboxMail(id: number): Promise<void>;
  syncInbox(): Promise<SyncResult>;

  // attachments — internal-memo file attachments. The file body is stored
  // in SharePoint's `SpiraAttachments` document library under
  // `ticket-{id}/...`; the note body itself only holds the returned URL +
  // filename as a markdown link `[📎 filename](url)`.
  uploadAttachment(ticketId: number, file: File): Promise<{ url: string; filename: string }>;

  // users (AD picker)
  listSiteUsers(): Promise<SiteUser[]>;
  /** 現在ログインしているユーザー (SP は /_api/web/currentuser、
   *  mock は固定のテストユーザー)。 */
  getCurrentUser(): Promise<SiteUser | null>;

  // dev helper (mock only)
  injectFakeReply?(ticketId: number): void;

  // Sample data seed — useful before PA is set up.
  // Adds 5 sample InboxMails to the underlying list.
  addSampleInbox(): Promise<{ count: number }>;

  // Teams 連携 (Forms → Spira → Teams 運用案)
  // チケット詳細から「内部スレッド起票」「ユーザースレッド起票」ボタンを
  // 押すと、TeamsPostRequests リストに 1 行 INSERT される。
  // 実際の Teams 投稿は PA フロー 2 が SP のアイテム作成トリガーで拾って
  // 処理する。Spira はキューに積むだけ。
  createTeamsPostRequest(params: {
    ticketId: number;
    threadType: 'internal' | 'user';
  }): Promise<{ id: number }>;

  // 設定 (Spira 全体で共有)
  //   SP では SpiraSettings リストの Key/Value 列に保存。
  //   Mock では in-memory Map。
  //   保存形式は文字列。複雑な値は呼び出し側で JSON.stringify する。
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null): Promise<void>;

  // 監査ログ (AuditLog リスト)
  //   全 mutation メソッドは内部で appendAudit を best-effort で呼ぶ。
  //   呼出側 (UI) から直接呼ぶ必要は無いが、AI 等のオプション操作で明示的に
  //   記録したい場合は appendAudit を直接呼ぶ。
  appendAudit(input: AppendAuditInput): Promise<void>;
  listAudit(opts?: ListAuditOpts): Promise<AuditRecord[]>;
  /** 期限切れ (ExpiresAt < now) のレコードを物理削除。クライアントが
   *  起動時に呼んでベストエフォートで掃除する。 */
  cleanupExpiredAudit(): Promise<{ deleted: number }>;
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

/** SP モードかどうかを (リポジトリ作成前に) 判定。
 *  サイト選択モーダルを起動前に表示するために main.ts から呼ぶ。 */
export function detectMode(): 'mock' | 'sp' {
  return shouldUseMock() ? 'mock' : 'sp';
}

export async function initRepo(
  opts?: { overrideSiteUrl?: string },
): Promise<{ mode: 'mock' | 'sp'; siteUrl?: string }> {
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
  if (opts?.overrideSiteUrl) cfg.siteUrl = opts.overrideSiteUrl;
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
