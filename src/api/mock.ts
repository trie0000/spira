// In-memory mock repository — used in dev (off-SP host) or with ?mock=1.
import type { Ticket, Comment, InboxMail, SiteUser, InboxState, AuditRecord } from '../types';
import type {
  Repository, CreateTicketInput, AddCommentInput, SyncResult, ResetResult,
  AppendAuditInput, ListAuditOpts,
} from './repo';
import { sampleInboxInputs, toMockInbox } from './sampleInbox';
import { formatTicketTag, parseTicketTag } from '../utils/ticketTag';
import { normalizeForSearch } from '../utils/search';
import { emitAudit, ticketDiff } from '../lib/audit';

interface DataStore {
  tickets: Ticket[];
  comments: Comment[];
  inbox: InboxMail[];
  users: SiteUser[];
  settings: Map<string, string>;
  /** 監査ログ。Mock では in-memory 配列。 */
  auditLog: AuditRecord[];
  nextTicketId: number;
  nextCommentId: number;
  nextInboxId: number;
  nextAuditId: number;
}

const store: DataStore = {
  tickets: [], comments: [], inbox: [], users: [], settings: new Map(),
  auditLog: [],
  nextTicketId: 1, nextCommentId: 1, nextInboxId: 1, nextAuditId: 1,
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
      assigneeEmails: ['tanaka@example.com'], assigneeNames: ['田中 太郎'],
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
      assigneeEmails: ['sato@example.com', 'tanaka@example.com'],
      assigneeNames: ['佐藤 花子', '田中 太郎'],
      reporterEmail: 'ops@external.example', reporterName: '運用',
      dueDate: minus(2),
      createdAt: minus(30), updatedAt: minus(1),
    },
    {
      id: 4, title: '機能要望: CSV エクスポート',
      description: '一覧から CSV で出力したい',
      status: '完了', priority: 'Low',
      assigneeEmails: ['suzuki@example.com'], assigneeNames: ['鈴木 一郎'],
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
      content: '<p>サーバ応答が断続的に消えています。Grafana のメトリクスをご確認ください。</p><p><img src="data:image/svg+xml;utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'40\'%3E%3Crect width=\'80\' height=\'40\' fill=\'%23c47f1c\'/%3E%3C/svg%3E" alt="chart"/></p>',
      isHtml: true, sentAt: minus(30), hasAttachments: true,
      internetMessageId: '<a1b2c3d4-e5f6-7890-abcd-ef1234567890@external.example>',
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
    // タグ無し (タグフィルター ON 時は Inbox に表示されない — 新規問い合わせ想定)
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
    // Forms 経由 (タグ無しだが受信に表示される — 管理者の起票判断待ち)
    // bodyHtml 内の「カテゴリ:」「影響度:」が自動マッピングに使われる。
    {
      id: 10, subject: '[Forms] パスワードリセットができない',
      bodyHtml: '<div><b>お名前と所属:</b> 山田太郎 / 営業部</div><div><b>カテゴリ:</b> アカウント・権限の問題</div><div><b>影響度:</b> High（業務が停止している / 緊急対応が必要）</div><div><b>詳細:</b> ログイン画面で「パスワードを忘れた」を押しても再設定メールが届きません。</div>',
      bodyText: 'お名前と所属: 山田太郎 / 営業部\nカテゴリ: アカウント・権限の問題\n影響度: High（業務が停止している / 緊急対応が必要）\n詳細: パスワードリセット問い合わせ',
      fromEmail: 'yamada@partner.example', fromName: '山田 太郎',
      receivedAt: minus(1), hasAttachments: false,
      conversationId: 'forms-aBcDeFgH-12345', owaLink: '#',
      isProcessed: false,
    },
    // タグ付き (既存チケットへの返信扱い — Inbox に表示される)
    {
      id: 14, subject: 'RE: [CASE#00001] ログインできません',
      bodyHtml: '<p>ご連絡ありがとうございます。サーバ側で対応中です、もう少々お待ちください。</p>',
      bodyText: '対応中の連絡',
      fromEmail: 'support@partner.example', fromName: 'サポート 鈴木',
      receivedAt: minus(1), hasAttachments: false,
      conversationId: 'cv-025', owaLink: '#',
      isProcessed: false,
    },
    {
      id: 15, subject: 'Re: [CASE#00003] 【至急】サーバ応答なし',
      bodyHtml: '<p>再起動で復旧しました。原因切り分けの詳細は別途共有します。</p>',
      bodyText: '復旧報告',
      fromEmail: 'ops@external.example', fromName: '運用',
      receivedAt: minus(2), hasAttachments: false,
      conversationId: 'cv-026', owaLink: '#',
      isProcessed: false,
    },
  ];
  store.nextInboxId = 16;
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
  async searchAll(query: string): Promise<{ tickets: Ticket[]; commentsByTicket: Map<number, Comment[]> }> {
    const q = normalizeForSearch(query);
    if (!q) return { tickets: [], commentsByTicket: new Map() };
    const tickets = store.tickets.filter(t => !t.isDeleted && (
      normalizeForSearch(t.title).includes(q) ||
      normalizeForSearch(t.description ?? '').includes(q) ||
      normalizeForSearch(t.reporterName ?? '').includes(q) ||
      normalizeForSearch(t.reporterEmail ?? '').includes(q)
    ));
    const matchedTicketIds = new Set(tickets.map(t => t.id));
    const commentMatches = store.comments.filter(c =>
      normalizeForSearch(c.content).includes(q) ||
      normalizeForSearch(c.fromName ?? '').includes(q) ||
      normalizeForSearch(c.fromEmail ?? '').includes(q),
    );
    const commentsByTicket = new Map<number, Comment[]>();
    for (const c of commentMatches) {
      const arr = commentsByTicket.get(c.ticketId) ?? [];
      arr.push(c);
      commentsByTicket.set(c.ticketId, arr);
      // Pull in the ticket if not already in the title match set.
      if (!matchedTicketIds.has(c.ticketId)) {
        const t = store.tickets.find(x => x.id === c.ticketId && !x.isDeleted);
        if (t) {
          tickets.push(t);
          matchedTicketIds.add(t.id);
        }
      }
    }
    return { tickets, commentsByTicket };
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
      assigneeEmails: input.assigneeEmails && input.assigneeEmails.length > 0 ? input.assigneeEmails : undefined,
      assigneeNames: input.assigneeEmails && input.assigneeEmails.length > 0
        ? input.assigneeEmails.map(e => store.users.find(u => u.email === e)?.displayName ?? e)
        : undefined,
      department: input.department,
      inquiryCategory: input.inquiryCategory,
      reporterEmail: input.reporterEmail,
      reporterName: input.reporterName,
      dueDate: input.dueDate,
      rawSubject: input.rawSubject,
      initialConversationId: input.initialConversationId,
      source: input.source,
      tags: input.tags ?? undefined,
      createdAt: now(),
      updatedAt: now(),
    };
    store.tickets.push(t);
    void emitAudit({
      action: 'ticket.create',
      ticketId: t.id,
      targetType: 'ticket',
      targetId: t.id,
      details: { title: t.title, status: t.status, priority: t.priority },
    });
    return t;
  }
  async updateTicket(id: number, patch: Partial<Ticket>): Promise<Ticket | null> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return null;
    // 差分計算のため before を浅コピー
    const before: Ticket = { ...t };
    Object.assign(t, patch);
    // assigneeEmails が更新されたら、displayName を AD から引いて
    // assigneeNames も同期する。両方一括 patch しているケースは
    // (patch.assigneeNames が指定されていれば) そちらを優先。
    if (patch.assigneeEmails !== undefined && patch.assigneeNames === undefined) {
      const emails = patch.assigneeEmails ?? [];
      t.assigneeNames = emails.length > 0
        ? emails.map(e => store.users.find(u => u.email === e)?.displayName ?? e)
        : undefined;
    }
    t.updatedAt = now();
    const diff = ticketDiff(before, patch);
    if (Object.keys(diff).length > 0) {
      void emitAudit({
        action: 'ticket.update',
        ticketId: id,
        targetType: 'ticket',
        targetId: id,
        details: { changes: diff },
      });
    }
    return t;
  }
  async softDeleteTicket(id: number): Promise<void> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return;
    t.isDeleted = true;
    t.deletedAt = now();
    t.updatedAt = now();
    void emitAudit({ action: 'ticket.delete', ticketId: id, targetType: 'ticket', targetId: id });
  }
  async restoreTicket(id: number): Promise<void> {
    const t = store.tickets.find(x => x.id === id);
    if (!t) return;
    t.isDeleted = false;
    t.deletedAt = undefined;
    t.updatedAt = now();
    void emitAudit({ action: 'ticket.restore', ticketId: id, targetType: 'ticket', targetId: id });
  }
  async hardDeleteTicket(id: number): Promise<void> {
    const removed = store.comments.filter(c => c.ticketId === id).length;
    store.tickets = store.tickets.filter(t => t.id !== id);
    store.comments = store.comments.filter(c => c.ticketId !== id);
    void emitAudit({
      action: 'ticket.purge',
      ticketId: id,
      targetType: 'ticket',
      targetId: id,
      details: { purgedComments: removed },
    });
  }
  async emptyTrash(): Promise<void> {
    const ids = store.tickets.filter(t => t.isDeleted).map(t => t.id);
    store.tickets = store.tickets.filter(t => !t.isDeleted);
    store.comments = store.comments.filter(c => !ids.includes(c.ticketId));
  }

  async listCommentsForLookup(ticketId: number): Promise<Comment[]> {
    // mock では自己治癒が同期だが、副作用無しのスナップショットを返す。
    return store.comments
      .filter(c => c.ticketId === ticketId)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  async listComments(ticketId: number): Promise<Comment[]> {
    const items = store.comments
      .filter(c => c.ticketId === ticketId)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    // E: 同 InternetMessageId のコメントが 2 件以上あれば古い 1 件を残して
    // 重複を物理削除 (自己治癒)。mock では同期処理で OK。
    const byIMID = new Map<string, Comment[]>();
    for (const c of items) {
      if (c.internetMessageId && c.type === 'received') {
        const arr = byIMID.get(c.internetMessageId) ?? [];
        arr.push(c);
        byIMID.set(c.internetMessageId, arr);
      }
    }
    const dupIds = new Set<number>();
    for (const arr of byIMID.values()) {
      if (arr.length <= 1) continue;
      arr.sort((a, b) => a.id - b.id);
      for (let i = 1; i < arr.length; i++) dupIds.add(arr[i]!.id);
    }
    if (dupIds.size > 0) {
      store.comments = store.comments.filter(c => !dupIds.has(c.id));
    }
    return items.filter(c => !dupIds.has(c.id));
  }
  async updateComment(
    id: number,
    patch: {
      content?: string;
      isHtml?: boolean;
      fromName?: string | null;
      fromEmail?: string | null;
      sentAt?: string;
      source?: 'mail' | 'forms' | 'teams' | 'other';
    },
  ): Promise<void> {
    const c = store.comments.find(x => x.id === id);
    if (!c) return;
    if (patch.content !== undefined) c.content = patch.content;
    if (patch.isHtml !== undefined) c.isHtml = patch.isHtml;
    if (patch.fromName !== undefined) c.fromName = patch.fromName ?? undefined;
    if (patch.fromEmail !== undefined) c.fromEmail = patch.fromEmail ?? undefined;
    if (patch.sentAt !== undefined) c.sentAt = patch.sentAt;
    if (patch.source !== undefined) c.source = patch.source;
    const nowIso = now();
    c.updatedAt = nowIso;
    c.updatedBy = store.users[0]?.displayName ?? c.updatedBy;
    const t = store.tickets.find(x => x.id === c.ticketId);
    if (t) t.updatedAt = nowIso;
    // 受信スレッド (received) の手動編集のみ記録。メモ (note) の自動保存は
    // Strategy C で記録対象外。
    if (c.type === 'received') {
      const fields = Object.keys(patch).filter(k => (patch as Record<string, unknown>)[k] !== undefined);
      void emitAudit({
        action: 'comment.update',
        ticketId: c.ticketId,
        targetType: 'comment',
        targetId: id,
        details: { fields },
      });
    }
  }

  async deleteComment(id: number): Promise<void> {
    const c = store.comments.find(x => x.id === id);
    if (!c) return;
    const ticketId = c.ticketId;
    const wasNote = c.type === 'note';
    store.comments = store.comments.filter(x => x.id !== id);
    const t = store.tickets.find(x => x.id === ticketId);
    if (t) t.updatedAt = now();
    void emitAudit({
      action: wasNote ? 'note.delete' : 'comment.delete',
      ticketId,
      targetType: wasNote ? 'note' : 'comment',
      targetId: id,
    });
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    const id = store.nextCommentId++;
    const nowIso = now();
    const me = store.users[0];
    const c: Comment = {
      id,
      ticketId: input.ticketId,
      type: input.type,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      content: input.content,
      isHtml: input.isHtml,
      sentAt: input.sentAt ?? nowIso,
      sourceEmailId: input.sourceEmailId,
      hasAttachments: input.hasAttachments,
      internetMessageId: input.internetMessageId,
      source: input.source,
      threadKind: input.threadKind,
      createdBy: me?.displayName ?? input.fromName,
      updatedBy: me?.displayName ?? input.fromName,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    store.comments.push(c);
    const t = store.tickets.find(x => x.id === input.ticketId);
    if (t) t.updatedAt = nowIso;
    void emitAudit({
      action: input.type === 'note' ? 'note.create' : 'comment.add',
      ticketId: input.ticketId,
      targetType: input.type === 'note' ? 'note' : 'comment',
      targetId: c.id,
      details: {
        source: input.source ?? null,
        fromName: input.fromName ?? null,
      },
    });
    return c;
  }

  async bulkMigrateTicketField(
    field: 'status' | 'priority' | 'department' | 'inquiryCategory',
    renames: Map<string, string>,
    deletions: Set<string>,
  ): Promise<{ updated: number; errors: string[] }> {
    let updated = 0;
    const nowIso = now();
    for (const t of store.tickets) {
      if (t.isDeleted) continue;
      const cur = (t as Record<string, unknown>)[field] as string | undefined;
      if (!cur) continue;
      if (renames.has(cur)) {
        (t as Record<string, unknown>)[field] = renames.get(cur);
        t.updatedAt = nowIso;
        updated++;
      } else if (deletions.has(cur)) {
        (t as Record<string, unknown>)[field] = undefined;
        t.updatedAt = nowIso;
        updated++;
      }
    }
    return { updated, errors: [] };
  }

  async bulkMigrateTicketTags(
    renames: Map<string, string>,
    deletions: Set<string>,
  ): Promise<{ updated: number; errors: string[] }> {
    let updated = 0;
    const nowIso = now();
    for (const t of store.tickets) {
      if (t.isDeleted) continue;
      const cur = t.tags;
      if (!cur || cur.length === 0) continue;
      const next: string[] = [];
      let changed = false;
      const seen = new Set<string>();
      for (const name of cur) {
        if (deletions.has(name)) { changed = true; continue; }
        const newName = renames.get(name) ?? name;
        if (newName !== name) changed = true;
        if (!seen.has(newName)) {
          seen.add(newName);
          next.push(newName);
        } else {
          changed = true;
        }
      }
      if (!changed) continue;
      t.tags = next.length > 0 ? next : undefined;
      t.updatedAt = nowIso;
      updated++;
    }
    return { updated, errors: [] };
  }

  async getInboxItem(id: number): Promise<InboxMail | null> {
    return store.inbox.find(m => m.id === id) ?? null;
  }

  async listInbox(opts: { unprocessedOnly?: boolean; includeHidden?: boolean } = {}): Promise<InboxMail[]> {
    let all = opts.includeHidden ? store.inbox.slice() : store.inbox.filter(m => !m.isHidden);
    if (opts.unprocessedOnly) all = all.filter(m => !m.isProcessed);
    return [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }
  async hideInboxItems(ids: number[], reason?: string): Promise<void> {
    const reasonTrim = (reason ?? '').trim();
    for (const m of store.inbox) {
      if (ids.includes(m.id)) {
        m.isHidden = true;
        if (reasonTrim) m.exclusionReason = reasonTrim;
      }
    }
    if (ids.length > 0) {
      void emitAudit({
        action: 'inbox.hide',
        ticketId: 0,
        targetType: 'inbox',
        details: { ids, count: ids.length, reason: reasonTrim || undefined },
      });
    }
  }
  async unhideInboxItems(ids: number[]): Promise<void> {
    for (const m of store.inbox) {
      if (ids.includes(m.id)) {
        m.isHidden = false;
        m.exclusionReason = undefined;
      }
    }
  }
  async deleteInboxMail(id: number): Promise<void> {
    const i = store.inbox.findIndex(m => m.id === id);
    if (i >= 0) store.inbox.splice(i, 1);
  }
  async markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void> {
    const m = store.inbox.find(x => x.id === id);
    if (!m) return;
    m.isProcessed = true;
    m.ticketId = patch.ticketId;
    m.processedAt = now();
    m.processResult = patch.result;
    if (patch.result !== 'auto-linked') {
      void emitAudit({
        action: patch.result === 'created' ? 'inbox.ingest' : 'inbox.link',
        ticketId: patch.ticketId,
        targetType: 'inbox',
        targetId: id,
        details: { result: patch.result },
      });
    }
  }
  async syncInbox(): Promise<SyncResult> {
    let autoLinked = 0;
    let dedupedRemoved = 0;
    const errors: string[] = [];
    // C1: sp.ts と同じ threadType 情報を保持 (mock の挙動を本番と一致させる)。
    const threadMap = new Map<string, { ticketId: number; threadType: 'internal' | 'user' }>();
    for (const t of store.tickets) {
      if (t.isDeleted) continue;
      if (t.internalThreadId) threadMap.set(t.internalThreadId, { ticketId: t.id, threadType: 'internal' });
      if (t.userThreadId)     threadMap.set(t.userThreadId,     { ticketId: t.id, threadType: 'user' });
    }
    // 削除済みチケットの thread ID 集合 (sp.ts と同じく Teams 返信のノイズ
    // を InboxMails から物理削除する用途)。
    const deletedThreadIds = new Set<string>();
    for (const t of store.tickets) {
      if (!t.isDeleted) continue;
      if (t.internalThreadId) deletedThreadIds.add(t.internalThreadId);
      if (t.userThreadId)     deletedThreadIds.add(t.userThreadId);
    }
    // 走査対象を先にコピー (削除しながら回ると iteration がズレるため)
    const targets = store.inbox.filter(x => !x.isProcessed).slice();
    for (const m of targets) {
      try {
        // L10: ConversationId 正規化 (sp.ts と一致)
        const convId = (m.conversationId ?? '').trim();
        const convLower = convId.toLowerCase();
        const isForms = convLower.startsWith('forms-');
        const isTeams = convLower.startsWith('teams-');

        // Teams 返信の自動紐付け (sp.ts と同じロジック)
        if (isTeams) {
          const parentId = convId.slice('teams-'.length).trim();

          // 削除済みチケットの thread への返信は InboxMails から物理削除
          // (sp.ts と同じ挙動。詳細はそちらのコメント参照)。
          if (deletedThreadIds.has(parentId)) {
            console.warn(`[spira/sync] inbox #${m.id}: Teams reply to deleted ticket's thread (parent=${parentId}) → 物理削除`);
            await this.deleteInboxMail(m.id);
            dedupedRemoved++;
            continue;
          }

          const hit = threadMap.get(parentId);
          if (hit) {
            const ticket = store.tickets.find(t => t.id === hit.ticketId && !t.isDeleted);
            if (ticket) {
              if (!m.internetMessageId) {
                console.warn(`[spira/sync] inbox #${m.id}: Teams 返信に InternetMessageId が無いため手動トリアージ送り`);
                continue;
              }
              const dup = store.comments.some(
                c => c.ticketId === ticket.id && c.type === 'received' &&
                     c.internetMessageId === m.internetMessageId,
              );
              if (dup) {
                await this.deleteInboxMail(m.id);
                dedupedRemoved++;
                continue;
              }
              await this.addComment({
                ticketId: ticket.id, type: 'received',
                fromEmail: m.fromEmail, fromName: m.fromName,
                content: m.bodyHtml || m.bodyText, isHtml: !!m.bodyHtml,
                sentAt: m.sentAt ?? m.receivedAt, sourceEmailId: m.id,
                hasAttachments: m.hasAttachments,
                internetMessageId: m.internetMessageId,
                source: 'teams',
                threadKind: hit.threadType === 'user' ? 'external' : 'internal',
              });
              try {
                await this.deleteInboxMail(m.id);
              } catch (e) {
                console.warn(`[spira/sync] inbox #${m.id}: 削除失敗 (markProcessed):`, (e as Error).message);
                await this.markInboxProcessed(m.id, { ticketId: ticket.id, result: 'auto-linked' })
                  .catch(() => { /* swallow */ });
              }
              autoLinked++;
              continue;
            }
          }
          // ハズレ (= Spira 管理外スレッドへの post) → 受信箱から物理削除
          // (sp.ts と同じ挙動。詳細はそちらのコメント参照)。
          console.warn(`[spira/sync] inbox #${m.id}: Teams reply (parent=${parentId}) は Spira 管理外スレッド → 物理削除`);
          await this.deleteInboxMail(m.id);
          dedupedRemoved++;
          continue;
        }

        const tid = parseTicketTag(m.subject);
        if (tid == null) {
          if (isForms) {
            // Forms 経由はタグ無しが正常。受信箱に残して管理者の手動
            // 起票判断を待つ。
            console.warn(`[spira/sync] inbox #${m.id}: Forms entry kept for manual triage`);
          } else {
            // M10: タグ無しメールは物理削除ではなく非表示化 (論理削除)。
            console.warn(`[spira/sync] inbox #${m.id}: no tag mail → hide`);
            await this.hideInboxItems([m.id]).catch((e: Error) =>
              console.warn(`[spira/sync] inbox #${m.id}: 非表示化失敗:`, e.message));
          }
          continue;
        }
        const ticket = store.tickets.find(t => t.id === tid && !t.isDeleted);
        if (!ticket) {
          console.warn(`[spira/sync] inbox #${m.id}: tag parsed as #${tid} but ticket not found / deleted`);
          continue;
        }
        if (!m.internetMessageId) {
          console.warn(`[spira/sync] inbox #${m.id}: メールに InternetMessageId が無いため手動トリアージ送り`);
          continue;
        }
        // Idempotency: 既存コメントを重複追加しない
        const dup = store.comments.some(
          (c) => c.ticketId === tid && c.type === 'received' &&
            c.internetMessageId === m.internetMessageId,
        );
        if (dup) {
          await this.deleteInboxMail(m.id);
          dedupedRemoved++;
          continue;
        }
        await this.addComment({
          ticketId: tid, type: 'received',
          fromEmail: m.fromEmail, fromName: m.fromName,
          content: m.bodyHtml, isHtml: true,
          sentAt: m.sentAt ?? m.receivedAt, sourceEmailId: m.id,
          hasAttachments: m.hasAttachments,
          internetMessageId: m.internetMessageId,
          source: 'mail',
          threadKind: 'external',
        });
        // auto-link 後は物理削除 (受信箱には auto-link 待ち or Forms のみ残る運用)
        try {
          await this.deleteInboxMail(m.id);
        } catch (e) {
          console.warn(`[spira/sync] inbox #${m.id}: 削除失敗 (markProcessed):`, (e as Error).message);
          await this.markInboxProcessed(m.id, { ticketId: tid, result: 'auto-linked' })
            .catch(() => { /* swallow */ });
        }
        autoLinked++;
      } catch (e) {
        errors.push(`#${m.id}: ${(e as Error).message}`);
      }
    }
    const remaining = store.inbox.filter(x => !x.isProcessed).length;
    if (dedupedRemoved > 0) {
      console.log(`[spira/sync] dedupedRemoved=${dedupedRemoved} (mock)`);
    }
    return { autoLinked, remaining, errors };
  }

  async listSiteUsers(): Promise<SiteUser[]> {
    return store.users.slice();
  }

  async getCurrentUser(): Promise<SiteUser | null> {
    // mock 環境では最初のユーザーを「現在ユーザー」として返す。
    return store.users[0] ?? { id: 0, email: 'me@example.com', displayName: '自分 (mock)' };
  }

  /** Mock: encode the file as a base64 data URL and return it. The
   *  filename is preserved as-is (no collision logic — each upload
   *  produces an independent data URL even when names match). */
  async uploadAttachment(_ticketId: number, file: File): Promise<{ url: string; filename: string }> {
    const url: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return { url, filename: file.name };
  }

  async addSampleInbox(): Promise<{ count: number }> {
    const inputs = sampleInboxInputs();
    for (const inp of inputs) {
      const id = store.nextInboxId++;
      store.inbox.push(toMockInbox(inp, id));
    }
    return { count: inputs.length };
  }

  // ---- 設定 (key-value)

  async getSetting(key: string): Promise<string | null> {
    return store.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    if (value == null) store.settings.delete(key);
    else store.settings.set(key, value);
  }

  /** Mock: simulate the queue insert. We also fake the eventual PA
   *  callback by updating the ticket with a deepLink so the UI flips
   *  to "open thread" state on next render.
   *  SpiraSettings からチャネル設定を引いて、未設定なら mock 値で埋める。 */
  async createTeamsPostRequest(params: {
    ticketId: number;
    threadType: 'internal' | 'user';
    subject?: string;
    bodyHtml?: string;
    mentionedEmails?: string[];
  }): Promise<{ id: number }> {
    const settingKey = params.threadType === 'internal'
      ? 'teams-channel:internal'
      : 'teams-channel:external';
    let channelId = `mock-channel-${params.threadType}`;
    try {
      const raw = store.settings.get(settingKey);
      if (raw) {
        const cfg = JSON.parse(raw) as { channelId?: string };
        if (cfg.channelId) channelId = cfg.channelId;
      }
    } catch { /* keep default */ }

    const t = store.tickets.find((x) => x.id === params.ticketId);
    if (t) {
      const fakeId = `mock-msg-${Date.now()}`;
      const fakeLink = `https://teams.microsoft.com/l/message/${channelId}/${fakeId}`;
      if (params.threadType === 'internal') {
        t.internalThreadId = fakeId;
        t.internalChannelId = channelId;
        t.internalDeepLink = fakeLink;
      } else {
        t.userThreadId = fakeId;
        t.userChannelId = channelId;
        t.userDeepLink = fakeLink;
      }
      t.updatedAt = now();
    }
    const reqId = Math.floor(Math.random() * 100000);
    void emitAudit({
      action: 'teams.thread.create',
      ticketId: params.ticketId,
      targetType: 'teams',
      targetId: reqId,
      details: {
        threadType: params.threadType, channelId,
        hasSubject: !!params.subject,
        hasBody: !!params.bodyHtml,
        mentions: (params.mentionedEmails ?? []).length,
      },
    });
    return { id: reqId };
  }

  // dev helper: simulate a tagged reply landing in the inbox
  injectFakeReply(ticketId: number): void {
    const id = store.nextInboxId++;
    store.inbox.push({
      id, subject: `RE: ${formatTicketTag(ticketId)} サンプル返信`,
      bodyHtml: '<p>返信です。タグ付き件名で送ってきたので自動で紐付くはずです。</p>',
      bodyText: '返信です。',
      fromEmail: 'customer@external.example', fromName: '取引先 山田',
      receivedAt: now(), sentAt: now(), hasAttachments: false,
      conversationId: 'cv-001', owaLink: '#',
      isProcessed: false,
    });
  }

  // ---- 監査ログ
  //
  // Mock では in-memory 配列に append。`appendAudit` は best-effort
  // (例外吐かない)、`listAudit` は filter + Timestamp desc、
  // `cleanupExpiredAudit` は ExpiresAt < now の行を物理削除。

  async appendAudit(input: AppendAuditInput): Promise<void> {
    try {
      const me = store.users[0]; // mock の currentUser
      const detailsStr = input.details ? JSON.stringify(input.details) : undefined;
      const rec: AuditRecord = {
        id: store.nextAuditId++,
        timestamp: now(),
        actorEmail: input.actorEmail ?? me?.email ?? '',
        actorName: input.actorName ?? me?.displayName ?? '',
        action: input.action,
        ticketId: input.ticketId,
        targetType: input.targetType,
        targetId: input.targetId,
        details: detailsStr,
        expiresAt: input.expiresAt ?? mockDefaultExpiresAt(),
      };
      store.auditLog.push(rec);
    } catch (e) {
      console.warn('[mock/audit] append failed:', e);
    }
  }

  async listAudit(opts: ListAuditOpts = {}): Promise<AuditRecord[]> {
    let recs = store.auditLog.slice();
    if (opts.fromTime) recs = recs.filter(r => r.timestamp >= opts.fromTime!);
    if (opts.toTime)   recs = recs.filter(r => r.timestamp <= opts.toTime!);
    if (opts.ticketId != null) recs = recs.filter(r => r.ticketId === opts.ticketId);
    if (opts.action) recs = recs.filter(r => r.action === opts.action);
    if (opts.actorEmail) recs = recs.filter(r => (r.actorEmail ?? '').toLowerCase() === opts.actorEmail!.toLowerCase());
    recs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
    return recs.slice(0, limit);
  }

  async cleanupExpiredAudit(): Promise<{ deleted: number }> {
    const nowIso = new Date().toISOString();
    const before = store.auditLog.length;
    store.auditLog = store.auditLog.filter(r => r.expiresAt >= nowIso);
    return { deleted: before - store.auditLog.length };
  }
}

function mockDefaultExpiresAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}
