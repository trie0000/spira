// SharePoint REST API client + bootstrap (list auto-creation).
// Same-origin認証前提。MVP は最小実装。
import type { Ticket, Comment, InboxMail, SiteUser, TicketStatus, Priority } from '../types';

export interface SpConfig {
  siteUrl: string;             // e.g. https://contoso.sharepoint.com/sites/spira
  listTickets: string;         // 'Tickets'
  listComments: string;        // 'Comments'
  listInbox: string;           // 'InboxMails'
}

export class SpClient {
  constructor(public cfg: SpConfig) {}

  private async req<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.cfg.siteUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json;odata=nometadata');
    if (init.body) headers.set('Content-Type', 'application/json;odata=nometadata');
    const digest = await this.formDigest();
    if (init.method && init.method !== 'GET') headers.set('X-RequestDigest', digest);
    const res = await fetch(url, { ...init, headers, credentials: 'include' });
    if (!res.ok) throw new SpError(res.status, await res.text());
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private digestCache?: { value: string; expires: number };
  private async formDigest(): Promise<string> {
    if (this.digestCache && this.digestCache.expires > Date.now()) return this.digestCache.value;
    const res = await fetch(`${this.cfg.siteUrl}/_api/contextinfo`, {
      method: 'POST',
      headers: { Accept: 'application/json;odata=nometadata' },
      credentials: 'include',
    });
    if (!res.ok) throw new SpError(res.status, 'contextinfo failed');
    const data = await res.json() as { FormDigestValue: string; FormDigestTimeoutSeconds: number };
    this.digestCache = {
      value: data.FormDigestValue,
      expires: Date.now() + (data.FormDigestTimeoutSeconds - 60) * 1000,
    };
    return data.FormDigestValue;
  }

  // ---- bootstrap: ensure lists exist ----
  async ensureLists(): Promise<{ created: string[] }> {
    const created: string[] = [];
    if (!(await this.listExists(this.cfg.listTickets))) {
      await this.createList(this.cfg.listTickets, ticketFields());
      created.push(this.cfg.listTickets);
    }
    if (!(await this.listExists(this.cfg.listComments))) {
      await this.createList(this.cfg.listComments, commentFields());
      created.push(this.cfg.listComments);
    }
    if (!(await this.listExists(this.cfg.listInbox))) {
      await this.createList(this.cfg.listInbox, inboxFields());
      created.push(this.cfg.listInbox);
    }
    return { created };
  }

  private async listExists(title: string): Promise<boolean> {
    try {
      await this.req(`/_api/web/lists/getbytitle('${encodeURIComponent(title)}')?$select=Title`);
      return true;
    } catch (e) {
      if (e instanceof SpError && e.status === 404) return false;
      throw e;
    }
  }

  private async createList(title: string, fields: FieldSpec[]): Promise<void> {
    await this.req('/_api/web/lists', {
      method: 'POST',
      body: JSON.stringify({ Title: title, BaseTemplate: 100, AllowContentTypes: false, ContentTypesEnabled: false }),
    });
    for (const f of fields) {
      await this.req(`/_api/web/lists/getbytitle('${encodeURIComponent(title)}')/fields`, {
        method: 'POST',
        body: JSON.stringify(toFieldSchema(f)),
      });
    }
  }

  // ---- domain queries (stub for MVP wiring) ----
  // Implementations are intentionally minimal — verified against mock DB during dev.
  // Real SP queries will be filled in once site/list URLs are confirmed.

  async listTickets(_opts: { includeDeleted?: boolean } = {}): Promise<Ticket[]> { return []; }
  async getTicket(_id: number): Promise<Ticket | null> { return null; }
  async createTicket(_t: Partial<Ticket>): Promise<Ticket> { throw new Error('not implemented'); }
  async updateTicket(_id: number, _patch: Partial<Ticket>): Promise<void> { /* PATCH */ }
  async softDeleteTicket(_id: number): Promise<void> { /* IsDeleted=true */ }
  async restoreTicket(_id: number): Promise<void> { /* IsDeleted=false */ }
  async hardDeleteTicket(_id: number): Promise<void> { /* DELETE */ }

  async listComments(_ticketId: number): Promise<Comment[]> { return []; }
  async addComment(_c: Partial<Comment>): Promise<Comment> { throw new Error('not implemented'); }

  async listInbox(_opts: { unprocessedOnly?: boolean } = {}): Promise<InboxMail[]> { return []; }
  async markInboxProcessed(_id: number, _patch: Partial<InboxMail>): Promise<void> { /* PATCH */ }

  async listSiteUsers(): Promise<SiteUser[]> { return []; }
}

export class SpError extends Error {
  constructor(public status: number, public body: string) {
    super(`SP ${status}: ${body.slice(0, 200)}`);
  }
}

// ---- list field specs ----
type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice';
interface FieldSpec { name: string; type: FieldType; choices?: string[] }

function toFieldSchema(f: FieldSpec): unknown {
  if (f.type === 'NoteRich') {
    return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: true };
  }
  if (f.type === 'Note') {
    return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: false };
  }
  if (f.type === 'Choice') {
    return { __metadata: { type: 'SP.FieldChoice' }, FieldTypeKind: 6, Title: f.name, Choices: { results: f.choices ?? [] } };
  }
  const kindMap: Record<FieldType, number> = { Text: 2, Note: 3, NoteRich: 3, Number: 9, DateTime: 4, Boolean: 8, Choice: 6 };
  return { FieldTypeKind: kindMap[f.type], Title: f.name };
}

function ticketFields(): FieldSpec[] {
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

function commentFields(): FieldSpec[] {
  return [
    { name: 'TicketId', type: 'Number' },
    { name: 'Type', type: 'Choice', choices: ['received', 'note'] },
    { name: 'FromEmail', type: 'Text' },
    { name: 'FromName', type: 'Text' },
    { name: 'Content', type: 'NoteRich' },
    { name: 'IsHtml', type: 'Boolean' },
    { name: 'SentAt', type: 'DateTime' },
    { name: 'SourceEmailId', type: 'Number' },
  ];
}

function inboxFields(): FieldSpec[] {
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
  ];
}

// ---- helpers used across UI ----
export function ticketStatusList(): TicketStatus[] {
  return ['新規', '対応中', '確認待ち', '完了'];
}
export function priorityList(): Priority[] {
  return ['High', 'Medium', 'Low'];
}
