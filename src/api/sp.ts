// SharePoint REST API repository — same-origin auth, MERGE/DELETE via X-HTTP-Method.
// All endpoints are relative to siteUrl.
import type { Ticket, Comment, InboxMail, SiteUser, InboxState, TicketStatus, Priority, CommentType } from '../types';
import type { Repository, CreateTicketInput, AddCommentInput, SyncResult, ResetResult } from './repo';
import { sampleInboxInputs } from './sampleInbox';

export interface SpConfig {
  siteUrl: string;        // absolute, e.g. https://contoso.sharepoint.com/sites/spira
  listTickets: string;
  listComments: string;
  listInbox: string;
}

const DEFAULT_LISTS = {
  listTickets:  'Tickets',
  listComments: 'Comments',
  listInbox:    'InboxMails',
};

export function detectSpConfig(): SpConfig {
  // Prefer SP page context if available.
  const ctx = (window as unknown as { _spPageContextInfo?: { webAbsoluteUrl?: string } })._spPageContextInfo;
  let siteUrl = ctx?.webAbsoluteUrl;
  // Fallback: derive from location (`/sites/<x>` or root).
  if (!siteUrl) {
    const m = location.pathname.match(/^(\/sites\/[^/]+|\/teams\/[^/]+)/i);
    siteUrl = location.origin + (m ? m[0] : '');
  }
  return { siteUrl, ...DEFAULT_LISTS };
}

export class SpError extends Error {
  constructor(public status: number, public body: string, public url?: string) {
    super(`SP ${status} ${url ?? ''}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- transport

class SpTransport {
  constructor(public siteUrl: string) {}

  private digest?: { value: string; expires: number };

  /**
   * @param init.odata - 'nometadata' (default, slim responses) or 'verbose' (required by some
   *   write endpoints like POST /_api/web/lists which need typed payloads with __metadata).
   */
  async req<T = unknown>(path: string, init: RequestInit & { odata?: 'nometadata' | 'verbose' } = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.siteUrl}${path}`;
    const headers = new Headers(init.headers);
    const odata = init.odata ?? 'nometadata';
    if (!headers.has('Accept')) headers.set('Accept', `application/json;odata=${odata}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', `application/json;odata=${odata}`);
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (isWrite) headers.set('X-RequestDigest', await this.formDigest());
    const res = await fetch(url, { ...init, headers, credentials: 'include' });
    if (!res.ok) throw new SpError(res.status, await res.text(), url);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      const parsed = JSON.parse(text);
      // verbose responses wrap in { d: ... } — unwrap.
      if (odata === 'verbose' && parsed && typeof parsed === 'object' && 'd' in parsed) {
        return (parsed as { d: T }).d;
      }
      return parsed as T;
    }
    catch { return text as unknown as T; }
  }

  async formDigest(): Promise<string> {
    if (this.digest && this.digest.expires > Date.now()) return this.digest.value;
    const res = await fetch(`${this.siteUrl}/_api/contextinfo`, {
      method: 'POST',
      headers: { Accept: 'application/json;odata=nometadata' },
      credentials: 'include',
    });
    if (!res.ok) throw new SpError(res.status, 'contextinfo failed', `${this.siteUrl}/_api/contextinfo`);
    const data = await res.json() as { FormDigestValue: string; FormDigestTimeoutSeconds: number };
    this.digest = {
      value: data.FormDigestValue,
      expires: Date.now() + (data.FormDigestTimeoutSeconds - 60) * 1000,
    };
    return data.FormDigestValue;
  }

  async update(listPath: string, id: number, body: Record<string, unknown>): Promise<void> {
    await this.req(`${listPath}/items(${id})`, {
      method: 'POST',
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
      body: JSON.stringify(body),
    });
  }

  async remove(listPath: string, id: number): Promise<void> {
    await this.req(`${listPath}/items(${id})`, {
      method: 'POST',
      headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    });
  }
}

// ---------------------------------------------------------------- field mapping

interface SpListItem {
  Id: number;
  Title?: string;
  Created: string;
  Modified: string;
  [k: string]: unknown;
}

function asTicket(it: SpListItem): Ticket {
  return {
    id: it.Id,
    title: String(it.Title ?? ''),
    description: it.Description ? String(it.Description) : undefined,
    status: (it.Status as TicketStatus) || '新規',
    priority: (it.Priority as Priority) || 'Medium',
    assigneeEmail: it.AssigneeEmail ? String(it.AssigneeEmail) : undefined,
    assigneeName: it.AssigneeName ? String(it.AssigneeName) : undefined,
    reporterEmail: it.ReporterEmail ? String(it.ReporterEmail) : undefined,
    reporterName: it.ReporterName ? String(it.ReporterName) : undefined,
    dueDate: it.DueDate ? String(it.DueDate) : undefined,
    rawSubject: it.RawSubject ? String(it.RawSubject) : undefined,
    initialConversationId: it.InitialConversationId ? String(it.InitialConversationId) : undefined,
    isDeleted: Boolean(it.IsDeleted),
    deletedAt: it.DeletedAt ? String(it.DeletedAt) : undefined,
    createdAt: it.Created,
    updatedAt: it.Modified,
  };
}

function asComment(it: SpListItem): Comment {
  return {
    id: it.Id,
    ticketId: Number(it.TicketId ?? 0),
    type: (it.Type as CommentType) || 'note',
    fromEmail: it.FromEmail ? String(it.FromEmail) : undefined,
    fromName: it.FromName ? String(it.FromName) : undefined,
    content: String(it.Content ?? ''),
    isHtml: Boolean(it.IsHtml),
    sentAt: String(it.SentAt ?? it.Created),
    sourceEmailId: it.SourceEmailId != null ? Number(it.SourceEmailId) : undefined,
    hasAttachments: it.HasAttachments != null ? Boolean(it.HasAttachments) : undefined,
    internetMessageId: it.InternetMessageId ? String(it.InternetMessageId) : undefined,
  };
}

function asInbox(it: SpListItem): InboxMail {
  return {
    id: it.Id,
    subject: String(it.Subject ?? it.Title ?? ''),
    bodyHtml: String(it.BodyHtml ?? ''),
    bodyText: String(it.BodyText ?? ''),
    fromEmail: String(it.FromEmail ?? ''),
    fromName: it.FromName ? String(it.FromName) : undefined,
    receivedAt: String(it.ReceivedAt ?? it.Created),
    hasAttachments: Boolean(it.HasAttachments),
    conversationId: it.ConversationId ? String(it.ConversationId) : undefined,
    owaLink: it.OwaLink ? String(it.OwaLink) : undefined,
    isProcessed: Boolean(it.IsProcessed),
    ticketId: it.TicketId != null ? Number(it.TicketId) : undefined,
    processedAt: it.ProcessedAt ? String(it.ProcessedAt) : undefined,
    processResult: it.ProcessResult ? (String(it.ProcessResult) as InboxState) : undefined,
    isHidden: Boolean(it.IsHidden),
    internetMessageId: it.InternetMessageId ? String(it.InternetMessageId) : undefined,
  };
}

function ticketBody(input: Partial<Ticket> | CreateTicketInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if ('title' in input && input.title !== undefined) b.Title = input.title;
  if ('description' in input) b.Description = input.description ?? null;
  if ('status' in input) b.Status = input.status;
  if ('priority' in input) b.Priority = input.priority;
  if ('assigneeEmail' in input) b.AssigneeEmail = input.assigneeEmail ?? null;
  if ('assigneeName' in input) b.AssigneeName = input.assigneeName ?? null;
  if ('reporterEmail' in input) b.ReporterEmail = input.reporterEmail ?? null;
  if ('reporterName' in input) b.ReporterName = input.reporterName ?? null;
  if ('dueDate' in input) b.DueDate = input.dueDate ?? null;
  if ('rawSubject' in input) b.RawSubject = input.rawSubject ?? null;
  if ('initialConversationId' in input) b.InitialConversationId = input.initialConversationId ?? null;
  if ('isDeleted' in input) b.IsDeleted = input.isDeleted ?? false;
  if ('deletedAt' in input) b.DeletedAt = input.deletedAt ?? null;
  return b;
}

// ---------------------------------------------------------------- repo impl

interface ListItemsResp<T> { value: T[] }

export class SpRepository implements Repository {
  private tx: SpTransport;
  constructor(public cfg: SpConfig) {
    this.tx = new SpTransport(cfg.siteUrl);
  }

  private listPath(name: string): string {
    return `/_api/web/lists/getbytitle('${encodeURIComponent(name)}')`;
  }

  // ---- bootstrap

  async ensureLists(): Promise<{ created: string[]; addedFields: string[] }> {
    const created: string[] = [];
    const addedFields: string[] = [];

    const ensure = async (title: string, fields: FieldSpec[]) => {
      if (!(await this.listExists(title))) {
        await this.createListBare(title);
        created.push(title);
      }
      const added = await this.ensureFields(title, fields);
      for (const a of added) addedFields.push(`${title}.${a}`);
    };

    await ensure(this.cfg.listTickets, ticketFieldSpecs());
    await ensure(this.cfg.listComments, commentFieldSpecs());
    await ensure(this.cfg.listInbox, inboxFieldSpecs());

    return { created, addedFields };
  }

  // ---- destructive: clear all items (NOT drop the lists themselves)
  //
  // 注意: リスト本体を DELETE すると List GUID が変わって PA フローの参照が
  // 無効になる (PA の「項目の作成」が止まる)。なので中身だけ全削除する。
  // スキーマが古い場合は ensureLists で列追加だけ走らせる。

  async resetLists(): Promise<ResetResult> {
    const titles = [this.cfg.listTickets, this.cfg.listComments, this.cfg.listInbox];
    const cleared: string[] = [];
    for (const t of titles) {
      if (!(await this.listExists(t))) continue;
      const n = await this.truncateList(t);
      cleared.push(`${t} (${n} 件)`);
    }
    // 念のためスキーマも整合 (列が増えていれば自動追加)
    const r = await this.ensureLists();
    return { deleted: cleared, recreated: r.created, addedFields: r.addedFields ?? [] };
  }

  private async truncateList(title: string): Promise<number> {
    let count = 0;
    // ページング考慮: 一度に最大 2000 件、なくなるまでループ
    while (true) {
      const url = `${this.listPath(title)}/items?$select=Id&$top=2000`;
      const res = await this.tx.req<ListItemsResp<{ Id: number }>>(url);
      const items = res.value ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        try {
          await this.tx.remove(this.listPath(title), item.Id);
          count++;
        } catch (e) {
          if (e instanceof SpError && e.status === 404) continue; // already gone
          throw e;
        }
      }
      if (items.length < 2000) break;
    }
    return count;
  }

  private async listExists(title: string): Promise<boolean> {
    try {
      await this.tx.req(`${this.listPath(title)}?$select=Title`);
      return true;
    } catch (e) {
      if (e instanceof SpError && e.status === 404) return false;
      throw e;
    }
  }

  private async createListBare(title: string): Promise<void> {
    // /_api/web/lists POST requires verbose payload with typed __metadata.
    await this.tx.req('/_api/web/lists', {
      method: 'POST',
      odata: 'verbose',
      body: JSON.stringify({
        __metadata: { type: 'SP.List' },
        Title: title,
        BaseTemplate: 100,
        AllowContentTypes: true,
        ContentTypesEnabled: false,
      }),
    });
  }

  /** Idempotent: adds only missing fields. Returns names added. */
  private async ensureFields(title: string, fields: FieldSpec[]): Promise<string[]> {
    let existing = await this.listFieldNames(title);
    const added: string[] = [];
    for (const f of fields) {
      if (existing.has(f.name)) continue;
      try {
        await this.tx.req(`${this.listPath(title)}/fields`, {
          method: 'POST',
          odata: 'verbose',
          body: JSON.stringify(toFieldSchema(f)),
        });
        added.push(f.name);
      } catch (e) {
        // Race / retry: maybe the field actually got created on a previous attempt.
        // Re-fetch the field list and check before re-throwing.
        existing = await this.listFieldNames(title);
        if (existing.has(f.name)) continue;
        if (e instanceof SpError && e.status === 400 && isDuplicateFieldError(e.body)) continue;
        throw new Error(`field create failed: ${title}.${f.name} — ${(e as Error).message}`);
      }
    }
    return added;
  }

  private async listFieldNames(title: string): Promise<Set<string>> {
    const url = `${this.listPath(title)}/fields?$select=InternalName,Title,StaticName&$top=500`;
    const res = await this.tx.req<{ value: { InternalName: string; Title: string; StaticName: string }[] }>(url);
    const set = new Set<string>();
    for (const f of res.value ?? []) {
      if (f.InternalName) set.add(f.InternalName);
      if (f.Title) set.add(f.Title);
      if (f.StaticName) set.add(f.StaticName);
    }
    return set;
  }

  // ---- tickets

  async listTickets(opts: { includeDeleted?: boolean } = {}): Promise<Ticket[]> {
    const filter = opts.includeDeleted ? '' : `&$filter=IsDeleted eq 0`;
    const url = `${this.listPath(this.cfg.listTickets)}/items?$top=500&$orderby=Modified desc${filter}`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    return (res.value ?? []).map(asTicket);
  }

  async listDeletedTickets(): Promise<Ticket[]> {
    const url = `${this.listPath(this.cfg.listTickets)}/items?$top=500&$orderby=DeletedAt desc&$filter=IsDeleted eq 1`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    return (res.value ?? []).map(asTicket);
  }

  async getTicket(id: number): Promise<Ticket | null> {
    try {
      const it = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listTickets)}/items(${id})`);
      return asTicket(it);
    } catch (e) {
      if (e instanceof SpError && e.status === 404) return null;
      throw e;
    }
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const body = ticketBody(input);
    if (!body.Status) body.Status = '新規';
    if (!body.Priority) body.Priority = 'Medium';
    body.IsDeleted = false;
    const created = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listTickets)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return asTicket(created);
  }

  async updateTicket(id: number, patch: Partial<Ticket>): Promise<Ticket | null> {
    await this.tx.update(this.listPath(this.cfg.listTickets), id, ticketBody(patch));
    return this.getTicket(id);
  }

  async softDeleteTicket(id: number): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listTickets), id, {
      IsDeleted: true,
      DeletedAt: new Date().toISOString(),
    });
  }

  async restoreTicket(id: number): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listTickets), id, {
      IsDeleted: false,
      DeletedAt: null,
    });
  }

  async hardDeleteTicket(id: number): Promise<void> {
    // delete related Comments first (avoid orphans)
    const comments = await this.listComments(id);
    for (const c of comments) {
      await this.tx.remove(this.listPath(this.cfg.listComments), c.id);
    }
    await this.tx.remove(this.listPath(this.cfg.listTickets), id);
  }

  async emptyTrash(): Promise<void> {
    const deleted = await this.listDeletedTickets();
    for (const t of deleted) {
      await this.hardDeleteTicket(t.id);
    }
  }

  // ---- comments

  async listComments(ticketId: number): Promise<Comment[]> {
    const url = `${this.listPath(this.cfg.listComments)}/items?$top=500&$orderby=SentAt asc&$filter=TicketId eq ${ticketId}`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    return (res.value ?? []).map(asComment);
  }

  async updateComment(id: number, patch: { content: string }): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listComments), id, {
      Content: patch.content,
    });
  }

  async deleteComment(id: number): Promise<void> {
    await this.tx.remove(this.listPath(this.cfg.listComments), id);
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    const body: Record<string, unknown> = {
      Title: `c-${input.ticketId}-${Date.now()}`, // SP requires Title; not displayed
      TicketId: input.ticketId,
      Type: input.type,
      FromEmail: input.fromEmail ?? null,
      FromName: input.fromName ?? null,
      Content: input.content,
      IsHtml: input.isHtml,
      SentAt: input.sentAt ?? new Date().toISOString(),
      SourceEmailId: input.sourceEmailId ?? null,
      HasAttachments: input.hasAttachments ?? false,
      InternetMessageId: input.internetMessageId ?? null,
    };
    const created = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listComments)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return asComment(created);
  }

  // ---- inbox

  async listInbox(opts: { unprocessedOnly?: boolean; includeHidden?: boolean } = {}): Promise<InboxMail[]> {
    const conds: string[] = [];
    if (!opts.includeHidden) conds.push('IsHidden ne 1');
    if (opts.unprocessedOnly) conds.push('IsProcessed eq 0');
    const filter = conds.length > 0 ? `&$filter=${encodeURIComponent(conds.join(' and '))}` : '';
    const url = `${this.listPath(this.cfg.listInbox)}/items?$top=500&$orderby=ReceivedAt desc${filter}`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    return (res.value ?? []).map(asInbox);
  }

  async hideInboxItems(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.tx.update(this.listPath(this.cfg.listInbox), id, { IsHidden: true });
    }
  }

  async unhideInboxItems(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.tx.update(this.listPath(this.cfg.listInbox), id, { IsHidden: false });
    }
  }

  async markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listInbox), id, {
      IsProcessed: true,
      TicketId: patch.ticketId,
      ProcessedAt: new Date().toISOString(),
      ProcessResult: patch.result,
    });
  }

  async syncInbox(): Promise<SyncResult> {
    const unprocessed = await this.listInbox({ unprocessedOnly: true });
    const tickets = await this.listTickets();
    const byId = new Map(tickets.map(t => [t.id, t]));
    let autoLinked = 0;
    const errors: string[] = [];
    for (const m of unprocessed) {
      try {
        const tag = /\[#(\d+)\]/.exec(m.subject);
        if (!tag) continue;
        const tid = parseInt(tag[1]!, 10);
        const ticket = byId.get(tid);
        if (!ticket || ticket.isDeleted) continue;
        await this.addComment({
          ticketId: tid, type: 'received',
          fromEmail: m.fromEmail, fromName: m.fromName,
          content: m.bodyHtml || m.bodyText, isHtml: !!m.bodyHtml,
          sentAt: m.receivedAt, sourceEmailId: m.id,
          hasAttachments: m.hasAttachments,
          internetMessageId: m.internetMessageId,
        });
        await this.markInboxProcessed(m.id, { ticketId: tid, result: 'auto-linked' });
        autoLinked++;
      } catch (e) {
        errors.push(`#${m.id}: ${(e as Error).message}`);
      }
    }
    const remaining = (await this.listInbox({ unprocessedOnly: true })).length;
    return { autoLinked, remaining, errors };
  }

  // ---- sample data

  async addSampleInbox(): Promise<{ count: number }> {
    const inputs = sampleInboxInputs();
    for (const inp of inputs) {
      const body: Record<string, unknown> = {
        Title: `sample-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        Subject: inp.subject,
        BodyHtml: inp.bodyHtml,
        BodyText: inp.bodyText,
        FromEmail: inp.fromEmail,
        FromName: inp.fromName,
        HasAttachments: inp.hasAttachments,
        ConversationId: inp.conversationId,
        ReceivedAt: inp.receivedAt,
        OwaLink: null,
        IsProcessed: false,
      };
      await this.tx.req(`${this.listPath(this.cfg.listInbox)}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    return { count: inputs.length };
  }

  // ---- users

  async listSiteUsers(): Promise<SiteUser[]> {
    // PrincipalType 1 = User. Filter empty Email (system accounts).
    const url = `/_api/web/siteusers?$select=Id,Title,Email,PrincipalType&$filter=PrincipalType eq 1`;
    const res = await this.tx.req<ListItemsResp<{ Id: number; Title: string; Email: string }>>(url);
    return (res.value ?? [])
      .filter(u => u.Email)
      .map(u => ({ id: u.Id, email: u.Email, displayName: u.Title }));
  }
}

// ---------------------------------------------------------------- field specs

type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice';
interface FieldSpec { name: string; type: FieldType; choices?: string[] }

function toFieldSchema(f: FieldSpec): unknown {
  // SP REST `/_api/web/lists/.../fields` POST requires odata=verbose payload
  // with a properly-typed `__metadata.type`. Generic SP.Field is rejected.
  switch (f.type) {
    case 'Text':
      return { __metadata: { type: 'SP.FieldText' }, FieldTypeKind: 2, Title: f.name };
    case 'Note':
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: false, NumberOfLines: 6 };
    case 'NoteRich':
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: true, NumberOfLines: 6 };
    case 'Number':
      return { __metadata: { type: 'SP.FieldNumber' }, FieldTypeKind: 9, Title: f.name };
    case 'DateTime':
      // DisplayFormat 1 = DateTime (date+time). 0 = Date only.
      return { __metadata: { type: 'SP.FieldDateTime' }, FieldTypeKind: 4, Title: f.name, DisplayFormat: 1 };
    case 'Boolean':
      return { __metadata: { type: 'SP.Field' }, FieldTypeKind: 8, Title: f.name };
    case 'Choice':
      return { __metadata: { type: 'SP.FieldChoice' }, FieldTypeKind: 6, Title: f.name, Choices: { results: f.choices ?? [] } };
  }
}

function ticketFieldSpecs(): FieldSpec[] {
  return [
    { name: 'Description', type: 'Note' },
    { name: 'Status', type: 'Choice', choices: ['新規', '対応中', '確認待ち', '完了'] },
    { name: 'Priority', type: 'Choice', choices: ['High', 'Medium', 'Low'] },
    { name: 'AssigneeEmail', type: 'Text' },
    { name: 'AssigneeName', type: 'Text' },
    { name: 'ReporterEmail', type: 'Text' },
    { name: 'ReporterName', type: 'Text' },
    { name: 'DueDate', type: 'DateTime' },
    { name: 'RawSubject', type: 'Text' },
    { name: 'InitialConversationId', type: 'Text' },
    { name: 'IsDeleted', type: 'Boolean' },
    { name: 'DeletedAt', type: 'DateTime' },
  ];
}

function commentFieldSpecs(): FieldSpec[] {
  return [
    { name: 'TicketId', type: 'Number' },
    { name: 'Type', type: 'Choice', choices: ['received', 'note'] },
    { name: 'FromEmail', type: 'Text' },
    { name: 'FromName', type: 'Text' },
    { name: 'Content', type: 'NoteRich' },
    { name: 'IsHtml', type: 'Boolean' },
    { name: 'SentAt', type: 'DateTime' },
    { name: 'SourceEmailId', type: 'Number' },
    { name: 'HasAttachments', type: 'Boolean' },
    { name: 'InternetMessageId', type: 'Text' },
  ];
}

function inboxFieldSpecs(): FieldSpec[] {
  return [
    { name: 'Subject', type: 'Text' },
    { name: 'BodyHtml', type: 'NoteRich' },
    { name: 'BodyText', type: 'Note' },
    { name: 'FromEmail', type: 'Text' },
    { name: 'FromName', type: 'Text' },
    { name: 'HasAttachments', type: 'Boolean' },
    { name: 'ConversationId', type: 'Text' },
    { name: 'ReceivedAt', type: 'DateTime' },
    { name: 'OwaLink', type: 'Text' },
    { name: 'IsProcessed', type: 'Boolean' },
    { name: 'TicketId', type: 'Number' },
    { name: 'ProcessedAt', type: 'DateTime' },
    { name: 'ProcessResult', type: 'Choice', choices: ['auto-linked', 'manual-linked', 'created'] },
    { name: 'IsHidden', type: 'Boolean' },
    { name: 'InternetMessageId', type: 'Text' },
  ];
}

// ---------------------------------------------------------------- helpers reused by views
export function ticketStatusList(): TicketStatus[] {
  return ['新規', '対応中', '確認待ち', '完了'];
}
export function priorityList(): Priority[] {
  return ['High', 'Medium', 'Low'];
}

// SP error message patterns indicating "field/column already exists".
// Covers English + Japanese messages observed across SP Online tenants.
function isDuplicateFieldError(body: string): boolean {
  return (
    /already exists/i.test(body) ||
    /duplicate/i.test(body) ||
    /既に存在/.test(body) ||
    /重複/.test(body) ||
    /同じ名前/.test(body)
  );
}
