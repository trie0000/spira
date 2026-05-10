// In-memory mock repository — used in dev (off-SP host) or with ?mock=1.
import type { Ticket, Comment, InboxMail, SiteUser, InboxState } from '../types';
import type { Repository, CreateTicketInput, AddCommentInput, SyncResult, ResetResult } from './repo';
import { sampleInboxInputs, toMockInbox } from './sampleInbox';

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
  tickets: [], comments: [], inbox: [], users: [],
  nextTicketId: 1, nextCommentId: 1, nextInboxId: 1,
};

const now = () => new Date().toISOString();
const minus = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const plus = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export function seedMock(): void {
  if (store.tickets.length > 0) return; // idempotent

  store.users = [
    { id: 1, email: 'tanaka@example.com', displayName: '田中 太郎' },
    { id: 2, email: 'sato@example.com',   displayName: '佐藤 花子' },
    { id: 3, email: 'suzuki@example.com', displayName: '鈴木 一郎' },
    { id: 4, email: 'yamada@example.com', displayName: '山田 次郎' },
  ];

  const tickets: Ticket[] = [
    {
      id: 1, title: 'ログインできません',
      description: 'ID とパスワードを入力するとエラーが出ます',
      status: '対応中', priority: 'High',
      assigneeEmail: 'tanaka@example.com', assigneeName: '田中 太郎',
      reporterEmail: 'customer@external.example', reporterName: '取引先 山田',
      dueDate: plus(6), rawSubject: 'ログインできません',
      initialConversationId: 'cv-001',
      createdAt: minus(26), updatedAt: minus(2),
    },
    {
      id: 2, title: '請求書フォーマットの相談',
      description: '次回からのフォーマット変更について',
      status: '新規', priority: 'Medium',
      reporterEmail: 'biz@external.example', reporterName: 'ビジネス部',
      dueDate: plus(72),
      createdAt: minus(8), updatedAt: minus(8),
    },
    {
      id: 3, title: '【至急】サーバ応答なし',
      description: '本日 10:00 ごろから応答が断続的に消失',
      status: '確認待ち', priority: 'High',
      assigneeEmail: 'sato@example.com', assigneeName: '佐藤 花子',
      reporterEmail: 'ops@external.example', reporterName: '運用',
      dueDate: minus(2),
      createdAt: minus(30), updatedAt: minus(1),
    },
    {
      id: 4, title: '機能要望: CSV エクスポート',
      description: '一覧から CSV で出力したい',
      status: '完了', priority: 'Low',
      assigneeEmail: 'suzuki@example.com', assigneeName: '鈴木 一郎',
      reporterEmail: 'pm@example.com', reporterName: 'PM',
      createdAt: minus(120), updatedAt: minus(48),
    },
  ];
  store.tickets = tickets;
  store.nextTicketId = 5;

  store.comments = [
    {
      id: 1, ticketId: 1, type: 'received',
      fromEmail: 'customer@external.example', fromName: '取引先 山田',
      content: '<p>お世話になっております。</p><p>本日 9:00 ごろから管理画面にログインできない状態です。<br>ID/パスワードは問題ないはずなのですが、エラーが出てしまいます。</p><p>お手隙のときに確認いただけますでしょうか。</p>',
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
      content: '<p>ご連絡ありがとうございます。解除されたようです、無事ログインできました。</p>',
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

  store.inbox = [
    {
      id: 11, subject: '見積もりのご依頼',
      bodyHtml: '<p>はじめまして、株式会社 ABC の高橋と申します。貴社サービスについて見積もりをお願いしたく、ご連絡いたしました。</p>',
      bodyText: '見積もりのご依頼…',
      fromEmail: 'takahashi@abc.example', fromName: '高橋 健',
      receivedAt: minus(3), hasAttachments: false,
      conversationId: 'cv-022', owaLink: '#',
      isProcessed: false,
    },
    {
      id: 12, subject: '本日のミーティング資料',
      bodyHtml: '<p>本日 14:00 ミーティングの資料をお送りします。添付の PDF をご確認ください。</p>',
      bodyText: 'ミーティング資料…',
      fromEmail: 'pm@example.com', fromName: 'PM',
      receivedAt: minus(4), hasAttachments: true,
      conversationId: 'cv-023', owaLink: '#',
      isProcessed: false,
    },
    {
      id: 13, subject: '不具合のご報告',
      bodyHtml: '<p>管理画面の検索機能で、結果が表示されない不具合があります。</p>',
      bodyText: '不具合報告…',
      fromEmail: 'support@partner.example', fromName: 'サポート 鈴木',
      receivedAt: minus(6), hasAttachments: false,
      conversationId: 'cv-024', owaLink: '#',
      isProcessed: false,
    },
  ];
  store.nextInboxId = 14;
}

export class MockRepository implements Repository {
  async ensureLists(): Promise<{ created: string[]; addedFields?: string[] }> {
    return { created: [], addedFields: [] };
  }

  async resetLists(): Promise<ResetResult> {
    store.tickets = [];
    store.comments = [];
    store.inbox = [];
    store.users = [];
    store.nextTicketId = 1;
    store.nextCommentId = 1;
    store.nextInboxId = 1;
    seedMock();
    return {
      deleted: ['Tickets', 'Comments', 'InboxMails'],
      recreated: ['Tickets', 'Comments', 'InboxMails'],
      addedFields: [],
    };
  }

  async listTickets(opts: { includeDeleted?: boolean } = {}): Promise<Ticket[]> {
    return store.tickets.filter(t => opts.includeDeleted ? true : !t.isDeleted);
  }
  async listDeletedTickets(): Promise<Ticket[]> {
    return store.tickets.filter(t => t.isDeleted);
  }
  async getTicket(id: number): Promise<Ticket | null> {
    return store.tickets.find(t => t.id === id) ?? null;
  }
  async createTicket(input: CreateTicketInput): Promise<Ticket> {
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
  async updateTicket(id: number, patch: Partial<Ticket>): Promise<Ticket | null> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch);
    if (patch.assigneeEmail !== undefined) {
      t.assigneeName = store.users.find(u => u.email === patch.assigneeEmail)?.displayName;
    }
    t.updatedAt = now();
    return t;
  }
  async softDeleteTicket(id: number): Promise<void> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return;
    t.isDeleted = true;
    t.deletedAt = now();
    t.updatedAt = now();
  }
  async restoreTicket(id: number): Promise<void> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return;
    t.isDeleted = false;
    t.deletedAt = undefined;
    t.updatedAt = now();
  }
  async hardDeleteTicket(id: number): Promise<void> {
    store.tickets = store.tickets.filter(t => t.id !== id);
    store.comments = store.comments.filter(c => c.ticketId !== id);
  }
  async emptyTrash(): Promise<void> {
    const ids = store.tickets.filter(t => t.isDeleted).map(t => t.id);
    store.tickets = store.tickets.filter(t => !t.isDeleted);
    store.comments = store.comments.filter(c => !ids.includes(c.ticketId));
  }

  async listComments(ticketId: number): Promise<Comment[]> {
    return store.comments
      .filter(c => c.ticketId === ticketId)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }
  async updateComment(id: number, patch: { content: string }): Promise<void> {
    const c = store.comments.find(x => x.id === id);
    if (!c) return;
    c.content = patch.content;
    const t = store.tickets.find(x => x.id === c.ticketId);
    if (t) t.updatedAt = now();
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
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
    const t = store.tickets.find(x => x.id === input.ticketId);
    if (t) t.updatedAt = now();
    return c;
  }

  async listInbox(opts: { unprocessedOnly?: boolean } = {}): Promise<InboxMail[]> {
    const all = opts.unprocessedOnly ? store.inbox.filter(m => !m.isProcessed) : store.inbox;
    return [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }
  async markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void> {
    const m = store.inbox.find(x => x.id === id);
    if (!m) return;
    m.isProcessed = true;
    m.ticketId = patch.ticketId;
    m.processedAt = now();
    m.processResult = patch.result;
  }
  async syncInbox(): Promise<SyncResult> {
    let autoLinked = 0;
    const errors: string[] = [];
    for (const m of store.inbox.filter(x => !x.isProcessed)) {
      try {
        const tagMatch = /\[#(\d+)\]/.exec(m.subject);
        if (!tagMatch) continue;
        const tid = parseInt(tagMatch[1]!, 10);
        const ticket = store.tickets.find(t => t.id === tid && !t.isDeleted);
        if (!ticket) continue;
        await this.addComment({
          ticketId: tid, type: 'received',
          fromEmail: m.fromEmail, fromName: m.fromName,
          content: m.bodyHtml, isHtml: true,
          sentAt: m.receivedAt, sourceEmailId: m.id,
        });
        await this.markInboxProcessed(m.id, { ticketId: tid, result: 'auto-linked' });
        autoLinked++;
      } catch (e) {
        errors.push(`#${m.id}: ${(e as Error).message}`);
      }
    }
    const remaining = store.inbox.filter(x => !x.isProcessed).length;
    return { autoLinked, remaining, errors };
  }

  async listSiteUsers(): Promise<SiteUser[]> {
    return store.users.slice();
  }

  async addSampleInbox(): Promise<{ count: number }> {
    const inputs = sampleInboxInputs();
    for (const inp of inputs) {
      const id = store.nextInboxId++;
      store.inbox.push(toMockInbox(inp, id));
    }
    return { count: inputs.length };
  }

  // dev helper: simulate a tagged reply landing in the inbox
  injectFakeReply(ticketId: number): void {
    const id = store.nextInboxId++;
    store.inbox.push({
      id, subject: `RE: [#${String(ticketId).padStart(3, '0')}] サンプル返信`,
      bodyHtml: '<p>返信です。タグ付き件名で送ってきたので自動で紐付くはずです。</p>',
      bodyText: '返信です。',
      fromEmail: 'customer@external.example', fromName: '取引先 山田',
      receivedAt: now(), hasAttachments: false,
      conversationId: 'cv-001', owaLink: '#',
      isProcessed: false,
    });
  }
}
