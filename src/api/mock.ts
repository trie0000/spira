// In-memory mock store — used during dev to simulate SP behavior
// without a real SharePoint backend.
import type { Ticket, Comment, InboxMail, SiteUser, TicketStatus, Priority, InboxState } from '../types';

interface DataStore {
  tickets: Ticket[];
  comments: Comment[];
  inbox: InboxMail[];
  users: SiteUser[];
  nextTicketId: number;
  nextCommentId: number;
  nextInboxId: number;
}

const store: DataStore = {
  tickets: [],
  comments: [],
  inbox: [],
  users: [],
  nextTicketId: 1,
  nextCommentId: 1,
  nextInboxId: 1,
};

const now = () => new Date().toISOString();
const minus = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const plus = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export function seedMock(): void {
  store.users = [
    { id: 1, email: 'tanaka@example.com', displayName: '田中 太郎' },
    { id: 2, email: 'sato@example.com',   displayName: '佐藤 花子' },
    { id: 3, email: 'suzuki@example.com', displayName: '鈴木 一郎' },
    { id: 4, email: 'yamada@example.com', displayName: '山田 次郎' },
  ];

  // Sample tickets
  const t1: Ticket = {
    id: 1, title: 'ログインできません',
    description: 'ID とパスワードを入力するとエラーが出ます',
    status: '対応中', priority: 'High',
    assigneeEmail: 'tanaka@example.com', assigneeName: '田中 太郎',
    reporterEmail: 'customer@external.example', reporterName: '取引先 山田',
    dueDate: plus(6), rawSubject: 'ログインできません',
    initialConversationId: 'cv-001',
    createdAt: minus(26), updatedAt: minus(2),
  };
  const t2: Ticket = {
    id: 2, title: '請求書フォーマットの相談',
    description: '次回からのフォーマット変更について',
    status: '新規', priority: 'Medium',
    assigneeEmail: '', assigneeName: '',
    reporterEmail: 'biz@external.example', reporterName: 'ビジネス部',
    dueDate: plus(72),
    createdAt: minus(8), updatedAt: minus(8),
  };
  const t3: Ticket = {
    id: 3, title: '【至急】サーバ応答なし',
    description: '本日 10:00 ごろから応答が断続的に消失',
    status: '確認待ち', priority: 'High',
    assigneeEmail: 'sato@example.com', assigneeName: '佐藤 花子',
    reporterEmail: 'ops@external.example', reporterName: '運用',
    dueDate: minus(2), // overdue
    createdAt: minus(30), updatedAt: minus(1),
  };
  const t4: Ticket = {
    id: 4, title: '機能要望: CSV エクスポート',
    description: '一覧から CSV で出力したい',
    status: '完了', priority: 'Low',
    assigneeEmail: 'suzuki@example.com', assigneeName: '鈴木 一郎',
    reporterEmail: 'pm@example.com', reporterName: 'PM',
    createdAt: minus(120), updatedAt: minus(48),
  };
  store.tickets = [t1, t2, t3, t4];
  store.nextTicketId = 5;

  // Sample comments
  store.comments = [
    {
      id: 1, ticketId: 1, type: 'received',
      fromEmail: 'customer@external.example', fromName: '取引先 山田',
      content: '<p>お世話になっております。</p><p>本日 9:00 ごろから管理画面にログインできない状態です。<br>ID/パスワードは問題ないはずなのですが、エラーが出てしまいます。</p><p>お手隙のときに確認いただけますでしょうか。</p><p>よろしくお願いいたします。</p>',
      isHtml: true, sentAt: minus(26),
    },
    {
      id: 2, ticketId: 1, type: 'note',
      fromEmail: 'tanaka@example.com', fromName: '田中 太郎',
      content: 'ログ確認したところアカウントが一時ロックされている状態。社内で解除依頼を出した。',
      isHtml: false, sentAt: minus(20),
    },
    {
      id: 3, ticketId: 1, type: 'received',
      fromEmail: 'customer@external.example', fromName: '取引先 山田',
      content: '<p>ご連絡ありがとうございます。</p><p>解除されたようです。無事ログインできました。</p>',
      isHtml: true, sentAt: minus(2),
    },
    {
      id: 4, ticketId: 3, type: 'received',
      fromEmail: 'ops@external.example', fromName: '運用',
      content: '<p>サーバ応答が断続的に消えています。Grafana のメトリクスをご確認ください。</p>',
      isHtml: true, sentAt: minus(30),
    },
    {
      id: 5, ticketId: 3, type: 'note',
      fromEmail: 'sato@example.com', fromName: '佐藤 花子',
      content: 'インフラチームに連絡済み。状況の続報待ち。',
      isHtml: false, sentAt: minus(28),
    },
  ];
  store.nextCommentId = 6;

  // Sample inbox (unprocessed)
  store.inbox = [
    {
      id: 11, subject: '見積もりのご依頼',
      bodyHtml: '<p>はじめまして、株式会社 ABC の高橋と申します。</p><p>貴社サービスについて見積もりをお願いしたく、ご連絡いたしました。</p>',
      bodyText: 'はじめまして…見積もりをお願い…',
      fromEmail: 'takahashi@abc.example', fromName: '高橋 健',
      receivedAt: minus(3), hasAttachments: false,
      conversationId: 'cv-022', owaLink: '#',
      isProcessed: false,
    },
    {
      id: 12, subject: '本日のミーティング資料',
      bodyHtml: '<p>本日 14:00 ミーティングの資料をお送りします。</p><p>添付の PDF をご確認ください。</p>',
      bodyText: '本日 14:00 ミーティングの資料…',
      fromEmail: 'pm@example.com', fromName: 'PM',
      receivedAt: minus(4), hasAttachments: true,
      conversationId: 'cv-023', owaLink: '#',
      isProcessed: false,
    },
    {
      id: 13, subject: '不具合のご報告',
      bodyHtml: '<p>管理画面の検索機能で、結果が表示されない不具合があります。</p>',
      bodyText: '管理画面の検索機能で…',
      fromEmail: 'support@partner.example', fromName: 'サポート 鈴木',
      receivedAt: minus(6), hasAttachments: false,
      conversationId: 'cv-024', owaLink: '#',
      isProcessed: false,
    },
  ];
  store.nextInboxId = 14;
}

// ---- queries ----
export function listTicketsMock(opts: { includeDeleted?: boolean } = {}): Ticket[] {
  return store.tickets.filter(t => opts.includeDeleted ? true : !t.isDeleted);
}

export function listDeletedTicketsMock(): Ticket[] {
  return store.tickets.filter(t => t.isDeleted);
}

export function getTicketMock(id: number): Ticket | null {
  return store.tickets.find(t => t.id === id) ?? null;
}

export function listCommentsMock(ticketId: number): Comment[] {
  return store.comments
    .filter(c => c.ticketId === ticketId)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

export function listInboxMock(opts: { unprocessedOnly?: boolean } = {}): InboxMail[] {
  const all = opts.unprocessedOnly ? store.inbox.filter(m => !m.isProcessed) : store.inbox;
  return [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export function listSiteUsersMock(): SiteUser[] {
  return store.users.slice();
}

// ---- mutations ----
export function createTicketMock(input: {
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
}): Ticket {
  const id = store.nextTicketId++;
  const t: Ticket = {
    id,
    title: input.title,
    description: input.description,
    status: input.status ?? '新規',
    priority: input.priority ?? 'Medium',
    assigneeEmail: input.assigneeEmail,
    assigneeName: store.users.find(u => u.email === input.assigneeEmail)?.displayName,
    reporterEmail: input.reporterEmail,
    reporterName: input.reporterName,
    dueDate: input.dueDate,
    rawSubject: input.rawSubject,
    initialConversationId: input.initialConversationId,
    createdAt: now(),
    updatedAt: now(),
  };
  store.tickets.push(t);
  return t;
}

export function updateTicketMock(id: number, patch: Partial<Ticket>): Ticket | null {
  const t = store.tickets.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  if (patch.assigneeEmail !== undefined) {
    t.assigneeName = store.users.find(u => u.email === patch.assigneeEmail)?.displayName;
  }
  t.updatedAt = now();
  return t;
}

export function softDeleteTicketMock(id: number): void {
  const t = store.tickets.find(x => x.id === id);
  if (!t) return;
  t.isDeleted = true;
  t.deletedAt = now();
  t.updatedAt = now();
}

export function restoreTicketMock(id: number): void {
  const t = store.tickets.find(x => x.id === id);
  if (!t) return;
  t.isDeleted = false;
  t.deletedAt = undefined;
  t.updatedAt = now();
}

export function hardDeleteTicketMock(id: number): void {
  store.tickets = store.tickets.filter(t => t.id !== id);
  store.comments = store.comments.filter(c => c.ticketId !== id);
}

export function emptyTrashMock(): void {
  const deletedIds = store.tickets.filter(t => t.isDeleted).map(t => t.id);
  store.tickets = store.tickets.filter(t => !t.isDeleted);
  store.comments = store.comments.filter(c => !deletedIds.includes(c.ticketId));
}

export function addCommentMock(input: {
  ticketId: number;
  type: 'received' | 'note';
  fromEmail?: string;
  fromName?: string;
  content: string;
  isHtml: boolean;
  sentAt?: string;
  sourceEmailId?: number;
}): Comment {
  const id = store.nextCommentId++;
  const c: Comment = {
    id,
    ticketId: input.ticketId,
    type: input.type,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    content: input.content,
    isHtml: input.isHtml,
    sentAt: input.sentAt ?? now(),
    sourceEmailId: input.sourceEmailId,
  };
  store.comments.push(c);
  // bump ticket updatedAt
  const t = store.tickets.find(x => x.id === input.ticketId);
  if (t) t.updatedAt = now();
  return c;
}

export function markInboxProcessedMock(id: number, patch: {
  ticketId: number;
  result: InboxState;
}): void {
  const m = store.inbox.find(x => x.id === id);
  if (!m) return;
  m.isProcessed = true;
  m.ticketId = patch.ticketId;
  m.processedAt = now();
  m.processResult = patch.result;
}

// Sync simulation: extract [#XXX] from subject, auto-link to existing tickets.
export function syncMock(): { autoLinked: number; remaining: number } {
  let autoLinked = 0;
  for (const m of store.inbox.filter(x => !x.isProcessed)) {
    const tagMatch = /\[#(\d+)\]/.exec(m.subject);
    if (!tagMatch) continue;
    const tid = parseInt(tagMatch[1]!, 10);
    const ticket = store.tickets.find(t => t.id === tid && !t.isDeleted);
    if (!ticket) continue;
    addCommentMock({
      ticketId: tid,
      type: 'received',
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      content: m.bodyHtml,
      isHtml: true,
      sentAt: m.receivedAt,
      sourceEmailId: m.id,
    });
    markInboxProcessedMock(m.id, { ticketId: tid, result: 'auto-linked' });
    autoLinked++;
  }
  const remaining = store.inbox.filter(x => !x.isProcessed).length;
  return { autoLinked, remaining };
}

// Inject a fake reply with [#001] tag, for sync demo.
export function injectFakeReplyMock(ticketId: number): void {
  const id = store.nextInboxId++;
  store.inbox.push({
    id, subject: `RE: [#${String(ticketId).padStart(3, '0')}] サンプル返信`,
    bodyHtml: '<p>返信です。タグ付き件名で送ってきたので自動で紐付くはずです。</p>',
    bodyText: '返信です。…',
    fromEmail: 'customer@external.example', fromName: '取引先 山田',
    receivedAt: now(), hasAttachments: false,
    conversationId: 'cv-001', owaLink: '#',
    isProcessed: false,
  });
}
