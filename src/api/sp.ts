// SharePoint REST API repository — same-origin auth, MERGE/DELETE via X-HTTP-Method.
// All endpoints are relative to siteUrl.
import type {
  Ticket, Comment, InboxMail, SiteUser, InboxState, TicketStatus, Priority, CommentType,
  AuditRecord,
} from '../types';
import type {
  Repository, CreateTicketInput, AddCommentInput, SyncResult, ResetResult,
  AppendAuditInput, ListAuditOpts,
} from './repo';
import { sampleInboxInputs } from './sampleInbox';
import { parseTicketTag } from '../utils/ticketTag';
import { normalizeForSearch } from '../utils/search';
import { emitAudit, ticketDiff } from '../lib/audit';

export interface SpConfig {
  siteUrl: string;        // absolute, e.g. https://contoso.sharepoint.com/sites/spira
  listTickets: string;
  listComments: string;
  listInbox: string;
  listTeamsPostRequests: string;
  listSettings: string;
  /** 監査ログ。チケット属性変更・受信スレッド追加・メモ追加/削除 等を
   *  追記する。retention 設定 (default 30 日) で期限切れは自動削除。 */
  listAuditLog: string;
}

const DEFAULT_LISTS = {
  listTickets:           'Tickets',
  listComments:          'Comments',
  listInbox:             'InboxMails',
  listTeamsPostRequests: 'TeamsPostRequests',
  listSettings:          'SpiraSettings',
  listAuditLog:          'AuditLog',
};

/** Document library used for internal-memo attachments. Auto-created by
 *  ensureLists. Files are placed under `ticket-<5-digit-id>/`. */
const ATTACHMENT_LIBRARY = 'SpiraAttachments';

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
    const odata = init.odata ?? 'nometadata';
    const method = (init.method ?? 'GET').toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD';

    const doFetch = async (digest: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (!headers.has('Accept')) headers.set('Accept', `application/json;odata=${odata}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', `application/json;odata=${odata}`);
      }
      if (isWrite && digest) headers.set('X-RequestDigest', digest);
      return fetch(url, { ...init, headers, credentials: 'include' });
    };

    let res: Response;
    if (isWrite) {
      let digest = await this.formDigest();
      res = await doFetch(digest);
      // FormDigest が失効していると 403 (-2130575251 "security validation
      // for this page is invalid") が返る。キャッシュをクリアして新規取得 →
      // 最大 2 回までリトライ (digest fetch 自体が古いセッションで返ってきて
      // 即時 invalidate されるケースの保険)。
      let retries = 0;
      while (res.status === 403 && retries < 2) {
        const errText = await res.text();
        const isSecurityValidation =
          /2130575251|security validation|セキュリティ検証|FormDigest|SecurityValidation/i.test(errText);
        if (!isSecurityValidation) {
          throw new SpError(res.status, errText, url);
        }
        // eslint-disable-next-line no-console
        console.warn(`[spira/sp] form digest 403 — retry ${retries + 1}/2`);
        this.digest = undefined;
        digest = await this.formDigest();
        res = await doFetch(digest);
        retries++;
      }
    } else {
      res = await doFetch(null);
    }
    if (!res.ok) throw new SpError(res.status, await res.text(), url);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      const parsed = JSON.parse(text);
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
      // 300 秒 (5 分) のバッファを取って早めに refresh。SP 側で digest が
      // 早期 invalidate されるケース (別タブで活動・セッション切替等) も
      // あるので、req() で 403 を受けた場合はもう一段の retry をする。
      expires: Date.now() + (data.FormDigestTimeoutSeconds - 300) * 1000,
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

/** listComments の重複自己治癒で削除に繰り返し失敗した Comment ID。
 *  失敗が累積するとそのセッション中ずっと無駄な DELETE を投げ続けるので、
 *  1 度失敗したらこのセッションでは再試行しない (ブラウザリロードでリセット)。 */
const healFailureCache = new Set<number>();

/** M13: OData の文字列リテラル安全エスケープ。
 *  - シングルクォートは '' に二重化 (OData 仕様)
 *  - 結果を encodeURIComponent で URL 安全に
 *  使い方: `$filter=Field eq '${escOdataString(value)}'` */
function escOdataString(s: string): string {
  return encodeURIComponent(s.replace(/'/g, "''"));
}

/** M13: OData の datetime リテラル組み立て。ISO 文字列を期待し、検証して
 *  不正値ならエラー。古い `datetime'…'` 形式と裸 ISO 形式の両方の互換性が
 *  あるが、新 SP に合わせて裸の ISO を返す。 */
function fmtOdataDateTime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) {
    throw new Error(`Invalid ISO datetime for OData filter: ${iso}`);
  }
  return iso;
}

interface SpListItem {
  Id: number;
  Title?: string;
  Created: string;
  Modified: string;
  [k: string]: unknown;
}

/** カンマ区切り文字列を配列に。空文字は空配列、undefined はそのまま undefined。 */
function parseCsvField(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.split(/[,;、]/).map(p => p.trim()).filter(Boolean);
}

function asTicket(it: SpListItem): Ticket {
  return {
    id: it.Id,
    title: String(it.Title ?? ''),
    description: it.Description ? String(it.Description) : undefined,
    status: (it.Status as TicketStatus) || '新規',
    priority: (it.Priority as Priority) || 'Medium',
    // 複数担当者対応: カンマ区切りで保存されたメール/名前を配列化。
    // 旧形式 (単一値) も自然に 1 要素配列になる。
    assigneeEmails: parseCsvField(it.AssigneeEmail),
    assigneeNames: parseCsvField(it.AssigneeName),
    department: it.Department ? String(it.Department) : undefined,
    inquiryCategory: it.InquiryCategory ? String(it.InquiryCategory) : undefined,
    reporterEmail: it.ReporterEmail ? String(it.ReporterEmail) : undefined,
    reporterName: it.ReporterName ? String(it.ReporterName) : undefined,
    dueDate: it.DueDate ? String(it.DueDate) : undefined,
    rawSubject: it.RawSubject ? String(it.RawSubject) : undefined,
    initialConversationId: it.InitialConversationId ? String(it.InitialConversationId) : undefined,
    source: normalizeSource(it.Source),
    tags: parseTagsField(it.Tags),
    isDeleted: Boolean(it.IsDeleted),
    deletedAt: it.DeletedAt ? String(it.DeletedAt) : undefined,
    createdAt: it.Created,
    updatedAt: it.Modified,
    customerTeam: it.CustomerTeam ? String(it.CustomerTeam) : undefined,
    internalThreadId: it.InternalThreadId ? String(it.InternalThreadId) : undefined,
    internalChannelId: it.InternalChannelId ? String(it.InternalChannelId) : undefined,
    internalDeepLink: it.InternalDeepLink ? String(it.InternalDeepLink) : undefined,
    userThreadId: it.UserThreadId ? String(it.UserThreadId) : undefined,
    userChannelId: it.UserChannelId ? String(it.UserChannelId) : undefined,
    userDeepLink: it.UserDeepLink ? String(it.UserDeepLink) : undefined,
  };
}

/** Decode HTML entities that SharePoint's NoteRich field injects when
 *  storing characters outside the BMP (emojis like 📝 📎 💡) and a few
 *  HTML-special chars. Without this, our markdown round-trip sees
 *  `&#128221;` instead of `📝`, the file-chip regex misses, and the
 *  entity text leaks to the rendered memo.
 *
 *  We only call this on memos saved as MARKDOWN. Comments stored as
 *  HTML (legacy mail) get parsed via innerHTML downstream, which
 *  decodes entities natively.
 *
 *  ⚠ Important: HTML コメント (`<!--...-->`) は textarea パーサで剥がれて
 *  しまうので、一旦プレースホルダーに退避してデコード後に戻す。これを
 *  しないと note editor の sidecar コメント (`<!--ne-cols:...-->` で列幅、
 *  `<!--ne-thead-->` でヘッダ行) が消失して round-trip が壊れる。 */
function decodeSpEntities(s: string): string {
  // 1) Spira メタデータ markers (`[[NEM:base64]]`) を実際の HTML comment
  //    に戻す。SP の HTML サニタイザが <!--...--> を削除する環境への対策で、
  //    保存前に encodeSpContent で `[[NEM:...]]` に変換しているため。
  let pre = s.replace(/\[\[NEM:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
    try { return decodeURIComponent(escape(atob(b64))); }
    catch { return ''; }
  });
  // 2) HTML コメント (`<!--...-->`) は textarea パーサで剥がれてしまうので、
  //    一旦プレースホルダーに退避してデコード後に戻す。
  const comments: string[] = [];
  const masked = pre.replace(/<!--[\s\S]*?-->/g, (m) => {
    comments.push(m);
    return `NEC${comments.length - 1}`;
  });
  const t = document.createElement('textarea');
  t.innerHTML = masked;
  let out = t.value;
  out = out.replace(/NEC(\d+)/g, (_, i) => comments[parseInt(i, 10)] ?? '');
  return out;
}

/** SP に書き込む直前に呼び、HTML コメントを `[[NEM:base64]]` 形式に
 *  エンコードする。SP の HTML サニタイザは `[`/`]` を加工しないので
 *  reliable に round-trip できる。 */
function encodeSpContent(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, (m) => {
    const b64 = btoa(unescape(encodeURIComponent(m)));
    return `[[NEM:${b64}]]`;
  });
}

function asComment(it: SpListItem): Comment {
  const isHtml = Boolean(it.IsHtml);
  const rawContent = String(it.Content ?? '');
  // Author / Editor は $expand で取得した場合 { Title: '...' } 構造で来る。
  // 取得していない場合は undefined。
  const author = (it as { Author?: { Title?: string } }).Author;
  const editor = (it as { Editor?: { Title?: string } }).Editor;
  return {
    id: it.Id,
    ticketId: Number(it.TicketId ?? 0),
    type: (it.Type as CommentType) || 'note',
    fromEmail: it.FromEmail ? String(it.FromEmail) : undefined,
    fromName: it.FromName ? String(it.FromName) : undefined,
    content: isHtml ? rawContent : decodeSpEntities(rawContent),
    isHtml,
    sentAt: String(it.SentAt ?? it.Created),
    sourceEmailId: it.SourceEmailId != null ? Number(it.SourceEmailId) : undefined,
    hasAttachments: it.HasAttachments != null ? Boolean(it.HasAttachments) : undefined,
    internetMessageId: it.InternetMessageId ? String(it.InternetMessageId) : undefined,
    source: normalizeSource(it.Source),
    threadKind: normalizeThreadKind(it.ThreadKind),
    createdBy: author?.Title,
    updatedBy: editor?.Title,
    createdAt: it.Created ? String(it.Created) : undefined,
    updatedAt: it.Modified ? String(it.Modified) : undefined,
  };
}

function normalizeSource(v: unknown): 'mail' | 'forms' | 'teams' | 'other' | undefined {
  // C4: PA フローや管理者が手書きで 'Mail' 等のケース違いを入れる可能性が
  // あるので、文字列化 + 小文字化してからマッチ。
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'mail' || s === 'forms' || s === 'teams' || s === 'other') return s;
  return undefined;
}

/** Ticket.Tags 列 (Note) の JSON 配列パース。失敗時 / 空は undefined。 */
function parseTagsField(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      const cleaned = arr.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      return cleaned.length > 0 ? cleaned : undefined;
    }
  } catch { /* fall through to CSV fallback */ }
  // フォールバック: カンマ区切りでも受け入れ (旧データ互換)
  const csv = s.split(',').map(x => x.trim()).filter(Boolean);
  return csv.length > 0 ? csv : undefined;
}

function normalizeThreadKind(v: unknown): 'internal' | 'external' | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'internal' || s === 'external') return s;
  return undefined;
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
    // SentAt is new in 2026-05 — old rows won't have it. Callers should
    // fall back to receivedAt when sentAt is missing.
    sentAt: it.SentAt ? String(it.SentAt) : undefined,
    hasAttachments: Boolean(it.HasAttachments),
    conversationId: it.ConversationId ? String(it.ConversationId) : undefined,
    owaLink: it.OwaLink ? String(it.OwaLink) : undefined,
    isProcessed: Boolean(it.IsProcessed),
    ticketId: it.TicketId != null ? Number(it.TicketId) : undefined,
    processedAt: it.ProcessedAt ? String(it.ProcessedAt) : undefined,
    processResult: it.ProcessResult ? (String(it.ProcessResult) as InboxState) : undefined,
    isHidden: Boolean(it.IsHidden),
    exclusionReason: it.ExclusionReason ? String(it.ExclusionReason) : undefined,
    internetMessageId: it.InternetMessageId ? String(it.InternetMessageId) : undefined,
  };
}

function ticketBody(input: Partial<Ticket> | CreateTicketInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if ('title' in input && input.title !== undefined) b.Title = input.title;
  if ('description' in input) b.Description = input.description ?? null;
  if ('status' in input) b.Status = input.status;
  if ('priority' in input) b.Priority = input.priority;
  if ('assigneeEmails' in input) {
    const arr = (input as { assigneeEmails?: string[] }).assigneeEmails ?? [];
    b.AssigneeEmail = arr.length > 0 ? arr.join(', ') : null;
  }
  if ('assigneeNames' in input) {
    const arr = (input as { assigneeNames?: string[] }).assigneeNames ?? [];
    b.AssigneeName = arr.length > 0 ? arr.join(', ') : null;
  }
  if ('department' in input) b.Department = (input as { department?: string }).department ?? null;
  if ('inquiryCategory' in input) b.InquiryCategory = (input as { inquiryCategory?: string }).inquiryCategory ?? null;
  if ('reporterEmail' in input) b.ReporterEmail = input.reporterEmail ?? null;
  if ('reporterName' in input) b.ReporterName = input.reporterName ?? null;
  if ('dueDate' in input) b.DueDate = input.dueDate ?? null;
  if ('rawSubject' in input) b.RawSubject = input.rawSubject ?? null;
  if ('initialConversationId' in input) b.InitialConversationId = input.initialConversationId ?? null;
  if ('source' in input) b.Source = (input as { source?: string }).source ?? null;
  if ('tags' in input) {
    const arr = (input as { tags?: string[] }).tags;
    b.Tags = arr && arr.length > 0 ? JSON.stringify(arr) : null;
  }
  if ('isDeleted' in input) b.IsDeleted = input.isDeleted ?? false;
  if ('deletedAt' in input) b.DeletedAt = input.deletedAt ?? null;
  if ('customerTeam' in input) b.CustomerTeam = input.customerTeam ?? null;
  if ('internalThreadId' in input) b.InternalThreadId = input.internalThreadId ?? null;
  if ('internalChannelId' in input) b.InternalChannelId = input.internalChannelId ?? null;
  if ('internalDeepLink' in input) b.InternalDeepLink = input.internalDeepLink ?? null;
  if ('userThreadId' in input) b.UserThreadId = input.userThreadId ?? null;
  if ('userChannelId' in input) b.UserChannelId = input.userChannelId ?? null;
  if ('userDeepLink' in input) b.UserDeepLink = input.userDeepLink ?? null;
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
      // Schema drift: フィールドが旧型 (Text) で作られていて、現在の
      // 定義が Note などに変わっている場合は、互換性を保つために
      // 古い列を DELETE してから ensureFields で再作成する。
      // 影響: 旧列にあったデータは失われる (Teams DeepLink のみ該当)。
      await this.migrateFieldTypeMismatches(title, fields);
      const added = await this.ensureFields(title, fields);
      for (const a of added) addedFields.push(`${title}.${a}`);
    };

    await ensure(this.cfg.listTickets, ticketFieldSpecs());
    await ensure(this.cfg.listComments, commentFieldSpecs());
    await ensure(this.cfg.listInbox, inboxFieldSpecs());
    await ensure(this.cfg.listTeamsPostRequests, teamsPostRequestFieldSpecs());
    await ensure(this.cfg.listSettings, settingsFieldSpecs());
    await ensure(this.cfg.listAuditLog, auditLogFieldSpecs());

    // Attachment library — a single document library shared across all
    // tickets. Per-ticket sub-folders are created on first upload.
    if (!(await this.listExists(ATTACHMENT_LIBRARY))) {
      await this.tx.req('/_api/web/lists', {
        method: 'POST',
        odata: 'verbose',
        body: JSON.stringify({
          __metadata: { type: 'SP.List' },
          Title: ATTACHMENT_LIBRARY,
          BaseTemplate: 101, // Document Library
          AllowContentTypes: false,
        }),
      });
      created.push(ATTACHMENT_LIBRARY);
    }

    return { created, addedFields };
  }

  // ---- attachments -----------------------------------------------------

  /** Upload a file under SpiraAttachments/ticket-{N}/, auto-creating the
   *  per-ticket sub-folder on first use, and renaming the file with a
   *  ` (1)`, ` (2)` … suffix if the same filename already exists in that
   *  folder. Returns the absolute URL plus the (possibly-renamed) filename
   *  so the caller can put `[📎 <filename>](<url>)` in the memo. */
  async uploadAttachment(ticketId: number, file: File): Promise<{ url: string; filename: string }> {
    const subFolder = `ticket-${String(ticketId).padStart(5, '0')}`;
    const folderServerRel = await this.ensureAttachmentFolder(subFolder);
    // NFC-normalize the filename before sending it to SharePoint. macOS
    // hands us filenames in NFD (e.g. `ねずこ` has its dakuten encoded as
    // a separate combining mark) but SP stores everything in NFC. Without
    // this the URL we embed later can fail to match the stored file.
    const safeName = file.name.normalize('NFC');
    const finalName = await this.resolveNonCollidingName(folderServerRel, safeName);
    const buffer = await file.arrayBuffer();
    const uploadUrl =
      `${this.cfg.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(folderServerRel)}')` +
      `/Files/add(url='${encodeURIComponent(finalName)}',overwrite=false)`;
    const digest = await this.tx.formDigest();
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json;odata=nometadata',
        'X-RequestDigest': digest,
      },
      credentials: 'include',
      body: buffer,
    });
    if (!res.ok) throw new SpError(res.status, await res.text(), uploadUrl);
    // The site-relative URL is what we want to embed in the memo (works
    // when the bookmarklet runs from a different sub-site, etc.).
    // IMPORTANT: encode the filename segment with encodeURIComponent so
    // reserved URL chars (`#`, `?`, `&`, ` `, etc.) don't get interpreted
    // as a fragment/query when the user clicks the chip. The folder path
    // came straight from our own code (only ASCII + ticket-NNNNN) so it
    // doesn't need per-segment encoding, but we still pre-encode it for
    // safety in case the site-relative path ever picks up a non-ASCII
    // sub-segment from a renamed SP site.
    const tenantOrigin = new URL(this.cfg.siteUrl).origin;
    const safePath = folderServerRel
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    return {
      url: `${tenantOrigin}${safePath}/${encodeURIComponent(finalName)}`,
      filename: finalName,
    };
  }

  /** Ensure `<site>/SpiraAttachments/<subFolder>/` exists. Returns the
   *  server-relative URL (e.g. `/sites/spira/SpiraAttachments/ticket-00042`).
   *
   *  IMPORTANT: SharePoint's `GetFolderByServerRelativeUrl` does NOT return
   *  HTTP 404 for missing folders — it returns 200 OK with `Exists: false`
   *  in the payload. So we have to inspect the body, not just the status.
   *  Earlier versions of this method relied on a 404 that never came,
   *  which silently skipped folder creation and surfaced as a
   *  `DirectoryNotFoundException` on the subsequent `Files/add` call. */
  private async ensureAttachmentFolder(subFolder: string): Promise<string> {
    const siteServerRel = new URL(this.cfg.siteUrl).pathname.replace(/\/$/, '');
    const libRel = `${siteServerRel}/${ATTACHMENT_LIBRARY}`;
    const fullRel = `${libRel}/${subFolder}`;
    let exists = false;
    try {
      const info = await this.tx.req<{ Exists?: boolean }>(
        `/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(fullRel)}')?$select=Exists`,
      );
      exists = info?.Exists === true;
    } catch (e) {
      // Some SP variants do return 404; treat that as "missing" too.
      if (!(e instanceof SpError) || e.status !== 404) throw e;
      exists = false;
    }
    if (exists) return fullRel;
    await this.tx.req('/_api/web/folders', {
      method: 'POST',
      odata: 'verbose',
      body: JSON.stringify({
        __metadata: { type: 'SP.Folder' },
        ServerRelativeUrl: fullRel,
      }),
    });
    return fullRel;
  }

  /** Probe for an unused filename in `folderServerRel`. Mirrors OS file
   *  managers: `report.xlsx` → `report (1).xlsx` → `report (2).xlsx` … */
  private async resolveNonCollidingName(folderServerRel: string, original: string): Promise<string> {
    const dot = original.lastIndexOf('.');
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? original : `${base} (${i})${ext}`;
      const exists = await this.fileExists(folderServerRel, candidate);
      if (!exists) return candidate;
    }
    // Give up after 100 tries — extremely unlikely in practice.
    throw new Error(`Too many duplicate filenames for ${original}`);
  }

  private async fileExists(folderServerRel: string, name: string): Promise<boolean> {
    // Same gotcha as the folder probe: SP returns 200 with `Exists: false`
    // for missing files, not 404. Inspect the body.
    const url =
      `/_api/web/GetFileByServerRelativeUrl('${encodeURIComponent(folderServerRel + '/' + name)}')?$select=Exists`;
    try {
      const info = await this.tx.req<{ Exists?: boolean }>(url);
      return info?.Exists === true;
    } catch (e) {
      if (e instanceof SpError && e.status === 404) return false;
      throw e;
    }
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

  /** スキーマドリフト対策: 既存列の TypeAsString が現在の定義と
   *  違う場合、古い列を DELETE する (次の ensureFields でほしい型で再作成)。
   *
   *  C5 セーフガード:
   *  - 互換ペア (Text ↔ Note 等) はそのまま残す (データロスを起こさない)
   *  - 列に既存データが入っている場合は削除しない (count>0 で skip + 警告)
   *  - PA が拾う Choice 列 (Status / Priority など) も保護リストで除外
   */
  private async migrateFieldTypeMismatches(title: string, fields: FieldSpec[]): Promise<void> {
    const url = `${this.listPath(title)}/fields?$select=InternalName,Title,StaticName,TypeAsString&$top=500`;
    let res: { value: { InternalName: string; Title: string; StaticName: string; TypeAsString: string }[] };
    try { res = await this.tx.req(url); }
    catch { return; }
    const byName = new Map<string, string>();
    for (const f of res.value ?? []) {
      const t = f.TypeAsString;
      if (f.InternalName) byName.set(f.InternalName, t);
      if (f.StaticName) byName.set(f.StaticName, t);
      if (f.Title) byName.set(f.Title, t);
    }
    // 「実質互換」とみなして移行をスキップする型ペア集合。
    // 例: Text と Note は格納先が違うが文字列という意味では互換、Choice ↔ Text も
    // ユーザーが意図して Choice にしているケースを尊重する。
    const compatible = (cur: string, want: string): boolean => {
      const pair = `${cur}|${want}`;
      return (
        pair === 'Text|Note'   || pair === 'Note|Text'   ||
        pair === 'Text|Choice' || pair === 'Choice|Text' ||
        pair === 'Number|Currency' || pair === 'Currency|Number'
      );
    };
    for (const spec of fields) {
      const cur = byName.get(spec.name);
      if (!cur) continue;
      const want = spFieldTypeString(spec.type);
      if (cur === want) continue;
      if (compatible(cur, want)) {
        console.log(`[spira] field type drift tolerated: ${title}.${spec.name} (${cur} ≈ ${want})`);
        continue;
      }
      // C5: 既存値がある列を破壊的に削除しない。$top=1 で値の有無を先に確認。
      try {
        const probe = await this.tx.req<ListItemsResp<SpListItem>>(
          `${this.listPath(title)}/items?$select=Id,${encodeURIComponent(spec.name)}` +
          `&$filter=${encodeURIComponent(`${spec.name} ne null`)}&$top=1`
        );
        if (probe.value && probe.value.length > 0) {
          console.warn(
            `[spira] field migrate SKIPPED (列にデータあり): ${title}.${spec.name} (${cur} → ${want}). ` +
            `データロスを避けるため自動マイグレーションは行いません。手動で列の型を ${want} に揃えてください。`,
          );
          continue;
        }
      } catch (e) {
        // データ確認に失敗 (権限不足など) なら安全側で削除しない
        console.warn(`[spira] field migrate aborted (probe failed): ${title}.${spec.name}`, (e as Error).message);
        continue;
      }
      // ここまで到達: 空の列で型が違うので削除して作り直す。
      try {
        await this.tx.req(
          `${this.listPath(title)}/fields/getbyinternalnameortitle('${encodeURIComponent(spec.name)}')`,
          { method: 'POST', headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' } },
        );
        console.log(`[spira] field migrated: ${title}.${spec.name} (${cur} → ${want})`);
      } catch (e) {
        // 削除権限なし or 必須列 → スキップ。次の ensureFields は既存列を
        // そのまま残すので、書き込み時に再度エラーになる (ユーザー対処要)。
        console.warn(`[spira] field migrate failed: ${title}.${spec.name}`, e);
      }
    }
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

  /** M14: SP REST のページング (`__next` URL) を辿って全件取得するヘルパ。
   *  $top で 1 ページ件数を指定。`maxPages` で暴走を防止 (既定 20 = 最大 1 万件)。
   *  値の上限を超えた場合は警告を出して中断する。 */
  private async fetchAllPaged<T extends SpListItem>(
    initialUrl: string,
    maxPages = 20,
  ): Promise<T[]> {
    let url: string | undefined = initialUrl;
    const out: T[] = [];
    let pages = 0;
    while (url && pages < maxPages) {
      const res = await this.tx.req<ListItemsResp<T> & { 'odata.nextLink'?: string; '__next'?: string }>(url);
      if (res.value) out.push(...res.value);
      // nodata の場合 odata.nextLink、verbose の場合 __next
      const next = (res as { 'odata.nextLink'?: string; '__next'?: string })['odata.nextLink']
        ?? (res as { '__next'?: string }).__next;
      url = next;
      pages++;
    }
    if (url) {
      console.warn(`[spira/paging] maxPages=${maxPages} 到達 (中断)。初期 URL: ${initialUrl}`);
    }
    return out;
  }

  async listTickets(opts: { includeDeleted?: boolean } = {}): Promise<Ticket[]> {
    const filter = opts.includeDeleted ? '' : `&$filter=IsDeleted eq 0`;
    const url = `${this.listPath(this.cfg.listTickets)}/items?$top=500&$orderby=Modified desc${filter}`;
    const all = await this.fetchAllPaged<SpListItem>(url);
    return all.map(asTicket);
  }

  async listDeletedTickets(): Promise<Ticket[]> {
    const url = `${this.listPath(this.cfg.listTickets)}/items?$top=500&$orderby=DeletedAt desc&$filter=IsDeleted eq 1`;
    const all = await this.fetchAllPaged<SpListItem>(url);
    return all.map(asTicket);
  }

  async searchAll(query: string): Promise<{ tickets: Ticket[]; commentsByTicket: Map<number, Comment[]> }> {
    if (!query.trim()) return { tickets: [], commentsByTicket: new Map() };
    // SP の substringof は Note 系列で HTML エンティティ越しに検索する
    // ので、ユーザーが見ている文字列ではマッチしないことがある (例:
    // 「ログイン」と打っても Content には `&#12525;...` で入っている)。
    // したがって server-side フィルターは使わず、リスト全件を取得して
    // クライアント側で normalizeForSearch を通して照合する。
    // データセットがそこまで大きくないという前提 (Tickets <= 数百, Comments <= 数千)。
    const ticketUrl = `${this.listPath(this.cfg.listTickets)}/items?$top=500&$filter=IsDeleted eq 0&$orderby=Modified desc`;
    const commentUrl = `${this.listPath(this.cfg.listComments)}/items?$top=2000&$orderby=SentAt desc`;

    const [ticketsRes, commentsRes] = await Promise.all([
      this.tx.req<ListItemsResp<SpListItem>>(ticketUrl).catch(() => ({ value: [] as SpListItem[] })),
      this.tx.req<ListItemsResp<SpListItem>>(commentUrl).catch(() => ({ value: [] as SpListItem[] })),
    ]);
    const allTickets: Ticket[] = (ticketsRes.value ?? []).map(asTicket);
    const allComments: Comment[] = (commentsRes.value ?? []).map(asComment);

    const qNorm = normalizeForSearch(query);
    const hit = (s: string | undefined): boolean =>
      !!s && normalizeForSearch(s).includes(qNorm);

    // Tickets: タイトル / 説明 / 起票元
    const matchedTickets = allTickets.filter(t =>
      hit(t.title) || hit(t.description) || hit(t.reporterName) || hit(t.reporterEmail),
    );
    const ticketIds = new Set(matchedTickets.map(t => t.id));

    // Comments: 本文 / 送信者
    const commentsByTicket = new Map<number, Comment[]>();
    for (const c of allComments) {
      if (!hit(c.content) && !hit(c.fromName) && !hit(c.fromEmail)) continue;
      const arr = commentsByTicket.get(c.ticketId) ?? [];
      arr.push(c);
      commentsByTicket.set(c.ticketId, arr);
    }

    // コメントだけでヒットしたチケットも結果に含める
    const tickets: Ticket[] = [...matchedTickets];
    for (const id of commentsByTicket.keys()) {
      if (ticketIds.has(id)) continue;
      const found = allTickets.find(t => t.id === id);
      if (found) tickets.push(found);
    }
    return { tickets, commentsByTicket };
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
    // M18: assigneeEmails が指定されていて assigneeNames が無いとき、
    // listSiteUsers から display name を解決して併せて保存する。
    // 旧仕様では sp の AssigneeName が null → 一覧で「未割当」表示になる
    // 状態だった (mock では emails → names を解決していたので挙動が一致しなかった)。
    if (input.assigneeEmails && input.assigneeEmails.length > 0 && !input.assigneeNames) {
      try {
        const users = await this.listSiteUsers();
        const emailToName = new Map(users.map(u => [u.email.toLowerCase(), u.displayName]));
        const names = input.assigneeEmails.map(e => emailToName.get(e.toLowerCase()) ?? e);
        body.AssigneeName = names.join(', ');
      } catch (e) {
        console.warn('[spira/createTicket] assigneeNames resolution failed:', (e as Error).message);
      }
    }
    const created = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listTickets)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const t = asTicket(created);
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
    const before = await this.getTicket(id);
    await this.tx.update(this.listPath(this.cfg.listTickets), id, ticketBody(patch));
    const after = await this.getTicket(id);
    if (before && after) {
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
    }
    return after;
  }

  async softDeleteTicket(id: number): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listTickets), id, {
      IsDeleted: true,
      DeletedAt: new Date().toISOString(),
    });
    void emitAudit({ action: 'ticket.delete', ticketId: id, targetType: 'ticket', targetId: id });
  }

  async restoreTicket(id: number): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listTickets), id, {
      IsDeleted: false,
      DeletedAt: null,
    });
    void emitAudit({ action: 'ticket.restore', ticketId: id, targetType: 'ticket', targetId: id });
  }

  async hardDeleteTicket(id: number): Promise<void> {
    // M15: コメントを残さず全件削除する (孤児防止)。listComments は最大 500
    // 件しか返さないので、Id のみのページング取得で全件 ID を集めてから削除。
    const url = `${this.listPath(this.cfg.listComments)}/items` +
      `?$select=Id&$top=2000&$filter=TicketId eq ${id}`;
    const allIds = (await this.fetchAllPaged<SpListItem>(url, /* maxPages */ 50))
      .map(it => it.Id);
    let purged = 0;
    for (const cid of allIds) {
      try {
        await this.tx.remove(this.listPath(this.cfg.listComments), cid);
        purged++;
      } catch (e) {
        console.warn(`[spira/hardDeleteTicket] コメント ${cid} 削除失敗:`, (e as Error).message);
      }
    }
    await this.tx.remove(this.listPath(this.cfg.listTickets), id);
    void emitAudit({
      action: 'ticket.purge',
      ticketId: id,
      targetType: 'ticket',
      targetId: id,
      details: { purgedComments: purged, totalComments: allIds.length },
    });
  }

  async emptyTrash(): Promise<void> {
    const deleted = await this.listDeletedTickets();
    for (const t of deleted) {
      await this.hardDeleteTicket(t.id);
    }
  }

  // ---- comments

  /** M1: lookup 専用 (自己治癒スキップ)。findDuplicateTicket 等の重複検知で
   *  全チケットを舐めるときに、各チケットの listComments で DELETE が大量に
   *  飛ぶのを防ぐ。 */
  async listCommentsForLookup(ticketId: number): Promise<Comment[]> {
    const url = `${this.listPath(this.cfg.listComments)}/items` +
      `?$top=500&$orderby=SentAt desc&$filter=TicketId eq ${ticketId}` +
      `&$select=Id,TicketId,Type,FromEmail,FromName,Content,IsHtml,SentAt,SourceEmailId,HasAttachments,InternetMessageId,Source,ThreadKind,Created,Modified`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    const items = (res.value ?? []).map(asComment);
    items.sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
    return items;
  }

  async listComments(ticketId: number): Promise<Comment[]> {
    // Author / Editor を expand して登録者・最終更新者の表示名も取得。
    // ★ orderby=desc + top=500 で「最新の 500 件」を取得し、クライアントで
    //   asc (古い順) に並べ直す。500 件超のチケットでは古い方が打ち切られる
    //   挙動になり、最新コメントが消えない (UI の意図に合致)。
    const url = `${this.listPath(this.cfg.listComments)}/items` +
      `?$top=500&$orderby=SentAt desc&$filter=TicketId eq ${ticketId}` +
      `&$expand=Author,Editor&$select=*,Author/Title,Editor/Title`;
    const res = await this.tx.req<ListItemsResp<SpListItem>>(url);
    const items = (res.value ?? []).map(asComment);
    // SentAt asc に戻す (display 側は古い順を期待)
    items.sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));

    // E: 同 InternetMessageId のコメントが 2 件以上あれば古い 1 件を残して
    // 新しい方を物理削除する (自動同期 race による重複自己治癒)。
    // A4: Promise.allSettled で削除完了を待ち、実際に成功した分だけ UI から
    // 除外する。削除失敗のループ累積も healFailureCache で抑止。
    const byIMID = new Map<string, Comment[]>();
    for (const c of items) {
      if (c.internetMessageId && c.type === 'received') {
        const arr = byIMID.get(c.internetMessageId) ?? [];
        arr.push(c);
        byIMID.set(c.internetMessageId, arr);
      }
    }
    const dupCandidates: number[] = [];
    for (const arr of byIMID.values()) {
      if (arr.length <= 1) continue;
      // L7: 残すコメントの選択ロジック:
      //   1. ユーザー編集 (updatedAt > createdAt) が入っているものを最優先で残す
      //      → 受信本文を手で直したケースで編集を失わない
      //   2. なければ ID 昇順 (= 古い順) で先頭を残す
      const editedFirst = arr.filter(c =>
        c.updatedAt && c.createdAt && new Date(c.updatedAt).getTime() > new Date(c.createdAt).getTime() + 1000
      );
      const sorted = editedFirst.length > 0
        ? [...editedFirst, ...arr.filter(c => !editedFirst.includes(c))].sort((a, b) => a.id - b.id)
        : [...arr].sort((a, b) => a.id - b.id);
      // sorted[0] を残す。それ以外を削除候補に。
      const keep = sorted[0]!;
      for (const c of sorted) {
        if (c.id === keep.id) continue;
        if (healFailureCache.has(c.id)) continue;
        dupCandidates.push(c.id);
      }
    }
    const dupConfirmed = new Set<number>();
    if (dupCandidates.length > 0) {
      console.warn(`[spira/comments] 重複コメント ${dupCandidates.length} 件を自動削除 (InternetMessageId 一致)`);
      const results = await Promise.allSettled(
        dupCandidates.map(id => this.tx.remove(this.listPath(this.cfg.listComments), id))
      );
      for (let i = 0; i < results.length; i++) {
        const id = dupCandidates[i]!;
        const r = results[i]!;
        if (r.status === 'fulfilled') {
          dupConfirmed.add(id);
        } else {
          healFailureCache.add(id);
          console.warn(`[spira/comments] 重複削除失敗 id=${id}:`, (r.reason as Error)?.message);
        }
      }
    }
    return items.filter(c => !dupConfirmed.has(c.id));
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
    const body: Record<string, unknown> = {};
    if (patch.content !== undefined) {
      // HTML コメント (sidecar メタデータ: 列幅 / ヘッダ行 / 空段落) を SP の
      // HTML サニタイザに削除されない形式 (`[[NEM:base64]]`) にエンコード。
      // 読み出し時は decodeSpEntities が逆変換する。
      body.Content = patch.isHtml ? patch.content : encodeSpContent(patch.content);
    }
    if (patch.isHtml !== undefined) body.IsHtml = patch.isHtml;
    if (patch.fromName !== undefined) body.FromName = patch.fromName || null;
    if (patch.fromEmail !== undefined) body.FromEmail = patch.fromEmail || null;
    if (patch.sentAt !== undefined) body.SentAt = patch.sentAt;
    if (patch.source !== undefined) body.Source = patch.source;
    if (Object.keys(body).length === 0) return;
    await this.tx.update(this.listPath(this.cfg.listComments), id, body);
    // 監査: コメント編集。メモの「内容」自動保存は記録対象外 (Strategy C) だが、
    // 「履歴 (received) 編集」は手動操作なので記録する。type を取得して切り分け。
    const meta = await this.fetchCommentMeta(id).catch(() => null);
    if (meta && meta.type === 'received') {
      const changed: Record<string, true> = {};
      for (const k of ['content', 'isHtml', 'fromName', 'fromEmail', 'sentAt', 'source']) {
        if ((patch as Record<string, unknown>)[k] !== undefined) changed[k] = true;
      }
      void emitAudit({
        action: 'comment.update',
        ticketId: meta.ticketId,
        targetType: 'comment',
        targetId: id,
        details: { fields: Object.keys(changed) },
      });
    }
  }

  /** 監査削除前の type 判定用に、最小限の列だけ取得。 */
  private async fetchCommentMeta(id: number): Promise<{ ticketId: number; type: 'received' | 'note' } | null> {
    const url = `${this.listPath(this.cfg.listComments)}/items(${id})?$select=TicketId,Type`;
    try {
      const res = await this.tx.req<{ TicketId: number; Type: string }>(url);
      return { ticketId: Number(res.TicketId ?? 0), type: (res.Type === 'note' ? 'note' : 'received') };
    } catch { return null; }
  }

  async deleteComment(id: number): Promise<void> {
    const meta = await this.fetchCommentMeta(id).catch(() => null);
    await this.tx.remove(this.listPath(this.cfg.listComments), id);
    if (meta) {
      void emitAudit({
        action: meta.type === 'note' ? 'note.delete' : 'comment.delete',
        ticketId: meta.ticketId,
        targetType: meta.type === 'note' ? 'note' : 'comment',
        targetId: id,
      });
    }
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    const body: Record<string, unknown> = {
      Title: `c-${input.ticketId}-${Date.now()}`, // SP requires Title; not displayed
      TicketId: input.ticketId,
      Type: input.type,
      FromEmail: input.fromEmail ?? null,
      FromName: input.fromName ?? null,
      Content: input.isHtml ? input.content : encodeSpContent(input.content),
      IsHtml: input.isHtml,
      SentAt: input.sentAt ?? new Date().toISOString(),
      SourceEmailId: input.sourceEmailId ?? null,
      HasAttachments: input.hasAttachments ?? false,
      InternetMessageId: input.internetMessageId ?? null,
      Source: input.source ?? null,
      ThreadKind: input.threadKind ?? null,
    };
    const created = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listComments)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const c = asComment(created);
    // L9: POST レスポンスでは Author/Editor が expand されていないので
    // createdBy / updatedBy が undefined になる。UI で「登録者なし」と
    // 表示されるのを避けるため、現在ユーザーの displayName で暫定的に埋める。
    // 次回 listComments で正規の値に上書きされる。
    if (!c.createdBy || !c.updatedBy) {
      try {
        const me = await this.getCurrentUser();
        if (me) {
          if (!c.createdBy) c.createdBy = me.displayName;
          if (!c.updatedBy) c.updatedBy = me.displayName;
        }
      } catch { /* swallow */ }
    }
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

  // ---- inbox

  async bulkMigrateTicketField(
    field: 'status' | 'priority' | 'department' | 'inquiryCategory',
    renames: Map<string, string>,
    deletions: Set<string>,
  ): Promise<{ updated: number; errors: string[] }> {
    const SP_FIELD: Record<typeof field, string> = {
      status: 'Status',
      priority: 'Priority',
      department: 'Department',
      inquiryCategory: 'InquiryCategory',
    } as const;
    const spField = SP_FIELD[field];
    let updated = 0;
    const errors: string[] = [];

    const updateMatching = async (oldVal: string, newVal: string | null): Promise<void> => {
      if (!oldVal) return;
      const url = `${this.listPath(this.cfg.listTickets)}/items?$select=Id&` +
        `$filter=${encodeURIComponent(`IsDeleted eq 0 and ${spField} eq '${oldVal.replace(/'/g, "''")}'`)}&$top=500`;
      let all: SpListItem[];
      try {
        all = await this.fetchAllPaged<SpListItem>(url);
      } catch (e) {
        errors.push(`${spField}='${oldVal}' 検索失敗: ${(e as Error).message}`);
        return;
      }
      for (const it of all) {
        try {
          await this.tx.update(this.listPath(this.cfg.listTickets), it.Id, { [spField]: newVal });
          updated++;
        } catch (e) {
          errors.push(`#${it.Id} ${spField}='${oldVal}' → '${newVal ?? '(空)'}' 失敗: ${(e as Error).message}`);
        }
      }
    };

    for (const [oldVal, newVal] of renames.entries()) {
      await updateMatching(oldVal, newVal);
    }
    for (const oldVal of deletions) {
      await updateMatching(oldVal, null);
    }
    if (updated > 0 || errors.length > 0) {
      void emitAudit({
        action: 'ticket.update',
        ticketId: 0,
        targetType: 'ticket',
        details: {
          bulkMigrateField: spField,
          renames: Array.from(renames.entries()),
          deletions: Array.from(deletions),
          updated,
          errors: errors.length,
        },
      });
    }
    return { updated, errors };
  }

  async bulkMigrateTicketTags(
    renames: Map<string, string>,
    deletions: Set<string>,
  ): Promise<{ updated: number; errors: string[] }> {
    let updated = 0;
    const errors: string[] = [];
    // タグは Note 列に JSON 文字列で保存されており $filter で値検索ができない
    // (substringof は文字列マッチが不安定)。よって IsDeleted=false の全
    // チケットをスキャンして判定する。listTickets は paged 取得済み。
    const tickets = await this.listTickets();
    for (const t of tickets) {
      const cur = t.tags;
      if (!cur || cur.length === 0) continue;
      // 改名 + 削除をまとめて 1 パスで処理
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
      try {
        await this.tx.update(this.listPath(this.cfg.listTickets), t.id, {
          Tags: next.length > 0 ? JSON.stringify(next) : null,
        });
        updated++;
      } catch (e) {
        errors.push(`#${t.id}: ${(e as Error).message}`);
      }
    }
    if (updated > 0 || errors.length > 0) {
      void emitAudit({
        action: 'ticket.update',
        ticketId: 0,
        targetType: 'ticket',
        details: {
          bulkMigrateTags: true,
          renames: Array.from(renames.entries()),
          deletions: Array.from(deletions),
          updated,
          errors: errors.length,
        },
      });
    }
    return { updated, errors };
  }

  async getInboxItem(id: number): Promise<InboxMail | null> {
    try {
      const it = await this.tx.req<SpListItem>(`${this.listPath(this.cfg.listInbox)}/items(${id})`);
      return it ? asInbox(it) : null;
    } catch (e) {
      if (e instanceof SpError && e.status === 404) return null;
      throw e;
    }
  }

  async listInbox(opts: { unprocessedOnly?: boolean; includeHidden?: boolean } = {}): Promise<InboxMail[]> {
    const conds: string[] = [];
    if (!opts.includeHidden) conds.push('IsHidden ne 1');
    if (opts.unprocessedOnly) conds.push('IsProcessed eq 0');
    const filter = conds.length > 0 ? `&$filter=${encodeURIComponent(conds.join(' and '))}` : '';
    const url = `${this.listPath(this.cfg.listInbox)}/items?$top=500&$orderby=ReceivedAt desc${filter}`;
    const all = await this.fetchAllPaged<SpListItem>(url);
    return all.map(asInbox);
  }

  async hideInboxItems(ids: number[], reason?: string): Promise<void> {
    const reasonTrim = (reason ?? '').trim();
    for (const id of ids) {
      const patch: Record<string, unknown> = { IsHidden: true };
      if (reasonTrim) patch.ExclusionReason = reasonTrim;
      await this.tx.update(this.listPath(this.cfg.listInbox), id, patch);
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
    for (const id of ids) {
      await this.tx.update(this.listPath(this.cfg.listInbox), id, { IsHidden: false, ExclusionReason: null });
    }
  }

  async deleteInboxMail(id: number): Promise<void> {
    await this.tx.remove(this.listPath(this.cfg.listInbox), id);
  }

  async markInboxProcessed(id: number, patch: { ticketId: number; result: InboxState }): Promise<void> {
    await this.tx.update(this.listPath(this.cfg.listInbox), id, {
      IsProcessed: true,
      TicketId: patch.ticketId,
      ProcessedAt: new Date().toISOString(),
      ProcessResult: patch.result,
    });
    // 手動 (manual-linked / created) のみ操作ログに残す。auto-linked は
    // 単なる同期処理 (PA で取り込み済みのメールを Spira が紐付けただけ) で
    // ノイズになるので除外。
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
    const unprocessed = await this.listInbox({ unprocessedOnly: true });
    // 削除済みチケットも取得して "削除済みスレッド" の検出に使う。
    // 削除されたチケットに紐づく Teams スレッドへの返信が PA 経由で
    // InboxMails に積まれ続けると一覧に紛れ込むので、それを判別して
    // 物理削除するため。生きているチケットの threadMap だけ別途用意する。
    const allTickets = await this.listTickets({ includeDeleted: true });
    const tickets = allTickets.filter(t => !t.isDeleted);
    const byId = new Map(tickets.map(t => [t.id, t]));
    // Teams スレッド ID → チケット ID の逆引き map (internalThreadId と
    // userThreadId 両方を 1 つの map に詰める)。PA フロー④ が
    // ConversationId に "teams-<parentMessageId>" を埋め込んでくるので、
    // それを使って既存チケットに自動紐付けする。
    const threadMap = new Map<string, { ticketId: number; threadType: 'internal' | 'user' }>();
    for (const t of tickets) {
      if (t.internalThreadId) threadMap.set(t.internalThreadId, { ticketId: t.id, threadType: 'internal' });
      if (t.userThreadId)     threadMap.set(t.userThreadId,     { ticketId: t.id, threadType: 'user' });
    }
    // 削除済みチケットの thread ID 集合。Teams 返信がこれにヒットしたら
    // 「死んだスレッドへの post」なので InboxMails から物理削除する
    // (チケット復元後の再収集よりも、ノイズ排除を優先する運用判断)。
    const deletedThreadIds = new Set<string>();
    for (const t of allTickets) {
      if (!t.isDeleted) continue;
      if (t.internalThreadId) deletedThreadIds.add(t.internalThreadId);
      if (t.userThreadId)     deletedThreadIds.add(t.userThreadId);
    }
    // M8: チケットごとの InternetMessageId 集合をメモ化。同 syncInbox 内で
    // 同じチケットへの auto-link が複数発生した時に listComments を 1 回しか
    // 呼ばないようにする (起票多数時の N×listComments 爆発を抑止)。
    const imidCache = new Map<number, Set<string>>();
    const fetchImids = async (ticketId: number): Promise<Set<string>> => {
      let s = imidCache.get(ticketId);
      if (s) return s;
      const cs = await this.listComments(ticketId);
      s = new Set<string>();
      for (const c of cs) {
        if (c.type === 'received' && c.internetMessageId) s.add(c.internetMessageId);
      }
      imidCache.set(ticketId, s);
      return s;
    };
    let autoLinked = 0;
    // 既存コメントと InternetMessageId 一致のため auto-link 不要だが、行だけ削除
    // した件数 (UI 上は autoLinked と区別しない既存挙動だがログには出す)。
    let dedupedRemoved = 0;
    const errors: string[] = [];
    for (const m of unprocessed) {
      try {
        // L10: ConversationId は前後空白 / 改行 / 大小不一致を正規化してから判定。
        // PA フローを後から書き換えた場合の typo / 末尾改行で auto-link を
        // 取り逃すのを防ぐ。
        const convId = (m.conversationId ?? '').trim();
        const convLower = convId.toLowerCase();
        const isForms = convLower.startsWith('forms-');
        const isTeams = convLower.startsWith('teams-');

        // ── Teams 返信の自動紐付け ──────────────────────────────
        // PA フロー④ が ConversationId に "teams-<parentMessageId>" を入れて
        // InboxMails に投入してくる。parentMessageId は Spira がチケット
        // 起票時に保管した Internal/UserThreadId と一致するはず。
        // ヒット → Comments に追加、InboxMails 物理削除 (= auto-link)
        // ハズレ → 受信一覧に残して手動トリアージ (チャネル外の議論など)
        if (isTeams) {
          // 元の大小ケースを保ったまま prefix 部分のみ削除 (parentId は
          // Teams の messageId なので case-sensitive 比較されうる)。
          const parentId = convId.slice('teams-'.length).trim();

          // 削除済みチケットの thread への返信は受信箱の純粋なノイズ。
          // 表示させたくないので InboxMails 行を物理削除して終了。
          // (チケット復元後にチャットを再収集したい運用なら、
          //  hideInboxItems への置換も検討余地あり。)
          if (deletedThreadIds.has(parentId)) {
            console.warn(`[spira/sync] inbox #${m.id}: Teams reply to deleted ticket's thread (parent=${parentId}) → 物理削除`);
            await this.deleteInboxMail(m.id).catch((e: Error) => {
              console.warn(`[spira/sync] inbox #${m.id}: 削除済みスレッド宛 reply の削除失敗:`, e.message);
            });
            dedupedRemoved++;
            continue;
          }

          const hit = threadMap.get(parentId);
          if (hit) {
            const ticket = byId.get(hit.ticketId);
            // 完了済みチケットも紐付ける (議論の補足が後から来る場合あり)。
            // 「完了は紐付けない」運用に変えたければここで !== '完了' に変更可。
            if (ticket && !ticket.isDeleted) {
              // A5: internetMessageId が無い行は重複判定キーが取れないので
              // auto-add しない (deleteInboxMail 失敗で永久増殖するため)。
              // 手動トリアージ送りにする。
              if (!m.internetMessageId) {
                console.warn(`[spira/sync] inbox #${m.id}: Teams 返信に InternetMessageId が無いため手動トリアージ送り (PA フローで messageId をマップしてください)`);
                continue;
              }
              // 重複防止 (M8: per-ticket cache 経由で listComments を抑止)
              const imids = await fetchImids(ticket.id);
              if (imids.has(m.internetMessageId)) {
                await this.deleteInboxMail(m.id).catch((e: Error) => {
                  console.warn(`[spira/sync] inbox #${m.id}: 重複行の削除失敗:`, e.message);
                });
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
                // threadMap.threadType (internal / user) を threadKind に変換。
                // 'user' → 'external' (顧客向けスレッド)、'internal' → 'internal'。
                threadKind: hit.threadType === 'user' ? 'external' : 'internal',
              });
              imids.add(m.internetMessageId);
              // A5: deleteInboxMail 失敗時のフォールバック → markInboxProcessed で
              // 「処理済み」マーキング。これで次回 sync で再 add されない。
              try {
                await this.deleteInboxMail(m.id);
              } catch (e) {
                console.warn(`[spira/sync] inbox #${m.id}: 削除失敗 (markProcessed にフォールバック):`, (e as Error).message);
                await this.markInboxProcessed(m.id, { ticketId: ticket.id, result: 'auto-linked' })
                  .catch((e2: Error) => console.warn(`[spira/sync] inbox #${m.id}: markProcessed もエラー:`, e2.message));
              }
              autoLinked++;
              continue;
            }
          }
          // ハズレ (= Spira 管理外スレッドへの post) → 受信箱から物理削除。
          // Teams チャネルで Spira を介さずに立てられたスレッド、
          // ハード削除されたチケットの thread への返信などが該当。
          // ノイズ排除を優先する運用判断 (元データは Teams 上に残っている)。
          console.warn(`[spira/sync] inbox #${m.id}: Teams reply (parent=${parentId}) は Spira 管理外スレッド → 物理削除`);
          await this.deleteInboxMail(m.id).catch((e: Error) => {
            console.warn(`[spira/sync] inbox #${m.id}: 管理外スレッド reply の削除失敗:`, e.message);
          });
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
            // M10: メールでタグ無し = 無関係メール。物理削除ではなく非表示化
            // (論理削除) して、後から「非表示も表示」トグルで復元可能にする。
            // 重要メールがタグ忘れで物理消失するリスクを排除。
            console.warn(`[spira/sync] inbox #${m.id}: no tag mail → hide (論理削除)`);
            await this.hideInboxItems([m.id]).catch((e: Error) => {
              console.warn(`[spira/sync] inbox #${m.id}: 非表示化失敗:`, e.message);
            });
          }
          continue;
        }
        const ticket = byId.get(tid);
        if (!ticket || ticket.isDeleted) {
          console.warn(`[spira/sync] inbox #${m.id}: tag parsed as #${tid} but ticket ${ticket ? 'is deleted' : 'not found'}`);
          continue;
        }
        // A5: internetMessageId が無い行は重複判定不可なので手動トリアージへ。
        // (PA フロー① の InternetMessageId 動的コンテンツマッピング漏れ対策)
        if (!m.internetMessageId) {
          console.warn(`[spira/sync] inbox #${m.id}: メールに InternetMessageId が無いため手動トリアージ送り`);
          continue;
        }
        // Idempotency (M8: per-ticket cache 経由で listComments を抑止)
        const imids = await fetchImids(tid);
        if (imids.has(m.internetMessageId)) {
          await this.deleteInboxMail(m.id).catch((e: Error) => {
            console.warn(`[spira/sync] inbox #${m.id}: 重複行の削除失敗:`, e.message);
          });
          dedupedRemoved++;
          continue;
        }
        await this.addComment({
          ticketId: tid, type: 'received',
          fromEmail: m.fromEmail, fromName: m.fromName,
          content: m.bodyHtml || m.bodyText, isHtml: !!m.bodyHtml,
          sentAt: m.sentAt ?? m.receivedAt, sourceEmailId: m.id,
          hasAttachments: m.hasAttachments,
          internetMessageId: m.internetMessageId,
          source: 'mail',
          // メール経由はすべて外部 (顧客/外部ユーザーとのやり取り) として扱う
          threadKind: 'external',
        });
        imids.add(m.internetMessageId);
        // A5: 削除失敗時の markInboxProcessed フォールバック (永久増殖防止)
        try {
          await this.deleteInboxMail(m.id);
        } catch (e) {
          console.warn(`[spira/sync] inbox #${m.id}: 削除失敗 (markProcessed にフォールバック):`, (e as Error).message);
          await this.markInboxProcessed(m.id, { ticketId: tid, result: 'auto-linked' })
            .catch((e2: Error) => console.warn(`[spira/sync] inbox #${m.id}: markProcessed もエラー:`, e2.message));
        }
        autoLinked++;
      } catch (e) {
        errors.push(`#${m.id}: ${(e as Error).message}`);
      }
    }
    const remaining = (await this.listInbox({ unprocessedOnly: true })).length;
    if (dedupedRemoved > 0) {
      console.log(`[spira/sync] dedupedRemoved=${dedupedRemoved} (既存と同 InternetMessageId のため削除のみ実施)`);
    }
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
        SentAt: inp.sentAt ?? inp.receivedAt,
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

  // ---- Teams 連携キュー

  /** TeamsPostRequests に 1 行 INSERT する。PA フロー 2 が SP トリガーで
   *  拾い、Teams にメッセージを投稿 → Tickets リストへ DeepLink を書き
   *  戻し → この行を削除する流れ。
   *  ChannelId / TeamId は Spira 側で SpiraSettings から解決して埋め込む
   *  ので、PA は行から直接取り出すだけで OK。 */
  async createTeamsPostRequest(params: {
    ticketId: number;
    threadType: 'internal' | 'user';
    /** Teams 親メッセージの件名 (subject)。省略時は PA 側のテンプレート任せ。 */
    subject?: string;
    /** 投稿本文 (HTML)。省略時は PA 側のテンプレート任せ。 */
    bodyHtml?: string;
    /** メンション対象のメールアドレス。PA 側で AAD ObjectId に解決して <at> 化。 */
    mentionedEmails?: string[];
  }): Promise<{ id: number }> {
    // 起票時点でチャネル設定を解決。未設定でも行は作る (PA 側で空文字で
    // 失敗 → エラー通知という流れに乗せる方がデバッグしやすい)。
    const settingKey = params.threadType === 'internal'
      ? 'teams-channel:internal'
      : 'teams-channel:external';
    let channelId = '';
    let teamId = '';
    try {
      const raw = await this.getSetting(settingKey);
      if (raw) {
        const cfg = JSON.parse(raw) as { channelId?: string; teamId?: string };
        channelId = cfg.channelId ?? '';
        teamId = cfg.teamId ?? '';
      }
    } catch { /* fall through with empty ids */ }

    const mentionsCsv = (params.mentionedEmails ?? [])
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
      .join(',');

    const body: Record<string, unknown> = {
      Title: `teams-post-${params.ticketId}-${params.threadType}-${Date.now()}`,
      TicketId: params.ticketId,
      ThreadType: params.threadType,
      ChannelId: channelId,
      TeamId: teamId,
      RequestedAt: new Date().toISOString(),
      Status: 'Pending',
      Subject: params.subject ?? null,
      BodyHtml: params.bodyHtml ? encodeSpContent(params.bodyHtml) : null,
      MentionedEmails: mentionsCsv || null,
    };
    const created = await this.tx.req<SpListItem>(
      `${this.listPath(this.cfg.listTeamsPostRequests)}/items`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    void emitAudit({
      action: 'teams.thread.create',
      ticketId: params.ticketId,
      targetType: 'teams',
      targetId: created.Id,
      details: {
        threadType: params.threadType, channelId, teamId,
        hasSubject: !!params.subject,
        hasBody: !!params.bodyHtml,
        mentions: (params.mentionedEmails ?? []).length,
      },
    });
    return { id: created.Id };
  }

  // ---- 設定 (Key/Value 共通設定)

  /** SpiraSettings リストから SettingKey 一致のアイテムを 1 件取得。
   *  見つからなければ null。 */
  async getSetting(key: string): Promise<string | null> {
    const url =
      `${this.listPath(this.cfg.listSettings)}/items?$select=Id,SettingKey,SettingValue` +
      `&$filter=SettingKey eq '${escOdataString(key)}'&$top=1`;
    const res = await this.tx.req<ListItemsResp<{ Id: number; SettingKey: string; SettingValue: string }>>(url);
    const row = res.value?.[0];
    return row?.SettingValue ?? null;
  }

  /** SpiraSettings に upsert (キーが既にあれば更新、無ければ作成)。
   *  value=null で削除。 */
  async setSetting(key: string, value: string | null): Promise<void> {
    const url =
      `${this.listPath(this.cfg.listSettings)}/items?$select=Id&` +
      `$filter=SettingKey eq '${escOdataString(key)}'&$top=1`;
    const res = await this.tx.req<ListItemsResp<{ Id: number }>>(url);
    const existing = res.value?.[0];
    if (value == null) {
      if (existing) await this.tx.remove(this.listPath(this.cfg.listSettings), existing.Id);
      return;
    }
    if (existing) {
      await this.tx.update(this.listPath(this.cfg.listSettings), existing.Id, {
        SettingValue: value,
      });
    } else {
      await this.tx.req(`${this.listPath(this.cfg.listSettings)}/items`, {
        method: 'POST',
        body: JSON.stringify({
          Title: key,           // Title も Key と同じにして可視性を上げる
          SettingKey: key,
          SettingValue: value,
        }),
      });
    }
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

  async getCurrentUser(): Promise<SiteUser | null> {
    try {
      const res = await this.tx.req<{ Id: number; Title: string; Email: string; LoginName?: string }>(
        '/_api/web/currentuser?$select=Id,Title,Email,LoginName',
      );
      // L6: LoginName から推測したメールは UPN と primary SMTP が違う
      // テナントで誤メールになりうるので、Email が空のときは空のまま返し、
      // 「不明」として扱う側に判定を委ねる (誤った監査ログ書込みを防止)。
      const email = res.Email ?? '';
      return { id: res.Id, email, displayName: res.Title || email || '(不明)' };
    } catch { return null; }
  }

  // ---- 監査ログ (AuditLog)
  //
  // appendAudit / listAudit / cleanupExpiredAudit。書込は best-effort
  // (失敗してもユーザ操作は通す)、listAudit はフィルタ + 並び順 desc、
  // cleanup は ExpiresAt < now の行を物理削除。
  //
  // 主要 mutation メソッド (createTicket / updateTicket / softDeleteTicket /
  // restoreTicket / hardDeleteTicket / addComment / updateComment /
  // deleteComment / markInboxProcessed / hideInboxItems /
  // createTeamsPostRequest) からは emitAudit ヘルパー経由で呼ばれる。

  async appendAudit(input: AppendAuditInput): Promise<void> {
    try {
      const me = await this.getCurrentUser().catch(() => null);
      const now = new Date();
      const detailsStr = input.details ? JSON.stringify(input.details) : '';
      const body: Record<string, unknown> = {
        Title: `${input.action} #${input.ticketId}`,
        Timestamp: now.toISOString(),
        ActorEmail: input.actorEmail ?? me?.email ?? '',
        ActorName: input.actorName ?? me?.displayName ?? '',
        Action: input.action,
        TicketId: input.ticketId,
        TargetType: input.targetType,
        TargetId: input.targetId ?? null,
        Details: detailsStr,
        ExpiresAt: input.expiresAt ?? defaultAuditExpiresAt(now),
      };
      await this.tx.req(`${this.listPath(this.cfg.listAuditLog)}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (e) {
      // 監査書込失敗はユーザに影響を伝播させない (操作はもう成功している)
      console.warn('[spira/audit] appendAudit failed:', e);
    }
  }

  async listAudit(opts: ListAuditOpts = {}): Promise<AuditRecord[]> {
    const filters: string[] = [];
    if (opts.fromTime) filters.push(`Timestamp ge datetime'${fmtOdataDateTime(opts.fromTime)}'`);
    if (opts.toTime)   filters.push(`Timestamp le datetime'${fmtOdataDateTime(opts.toTime)}'`);
    if (opts.ticketId != null) filters.push(`TicketId eq ${opts.ticketId}`);
    // M13: action / actorEmail を escOdataString で安全に。encodeURIComponent は
    // 後段の filterStr で一括適用されるのでここでは ' のエスケープのみ。
    if (opts.action) filters.push(`Action eq '${opts.action.replace(/'/g, "''")}'`);
    if (opts.actorEmail) filters.push(`ActorEmail eq '${opts.actorEmail.replace(/'/g, "''")}'`);
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
    const filterStr = filters.length > 0 ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : '';
    const url =
      `${this.listPath(this.cfg.listAuditLog)}/items` +
      `?$select=Id,Timestamp,ActorEmail,ActorName,Action,TicketId,TargetType,TargetId,Details,ExpiresAt` +
      `&$orderby=Timestamp desc&$top=${limit}${filterStr}`;
    interface AuditItem {
      Id: number; Timestamp: string; ActorEmail?: string; ActorName?: string;
      Action: string; TicketId: number; TargetType?: string; TargetId?: number | null;
      Details?: string | null; ExpiresAt?: string;
    }
    const res = await this.tx.req<ListItemsResp<AuditItem>>(url);
    return (res.value ?? []).map(asAuditRecord);
  }

  async cleanupExpiredAudit(): Promise<{ deleted: number }> {
    const nowIso = new Date().toISOString();
    const url =
      `${this.listPath(this.cfg.listAuditLog)}/items?$select=Id` +
      `&$filter=ExpiresAt lt datetime'${fmtOdataDateTime(nowIso)}'&$top=500`;
    const all = await this.fetchAllPaged<SpListItem>(url);
    const ids = all.map(r => r.Id);
    for (const id of ids) {
      try { await this.tx.remove(this.listPath(this.cfg.listAuditLog), id); }
      catch (e) { console.warn('[spira/audit] cleanup remove failed:', e); }
    }
    return { deleted: ids.length };
  }
}

function defaultAuditExpiresAt(from: Date): string {
  // appendAudit に明示的な expiresAt を渡さなかった場合のフォールバック。
  // 通常は呼出側 (lib/audit.ts の emitAudit) が retention 設定から計算
  // した値を渡すので、ここに来るのはレアケース。安全な 30 日デフォルト。
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}

function asAuditRecord(it: {
  Id: number; Timestamp: string; ActorEmail?: string; ActorName?: string;
  Action: string; TicketId: number; TargetType?: string; TargetId?: number | null;
  Details?: string | null; ExpiresAt?: string;
}): AuditRecord {
  return {
    id: it.Id,
    timestamp: it.Timestamp,
    actorEmail: it.ActorEmail ?? undefined,
    actorName: it.ActorName ?? undefined,
    action: it.Action as AuditRecord['action'],
    ticketId: Number(it.TicketId ?? 0),
    targetType: (it.TargetType ?? 'ticket') as AuditRecord['targetType'],
    targetId: it.TargetId != null ? Number(it.TargetId) : undefined,
    details: it.Details ?? undefined,
    expiresAt: it.ExpiresAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- field specs

type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice';
interface FieldSpec { name: string; type: FieldType; choices?: string[] }

/** FieldSpec の type を SP の TypeAsString (REST `Fields` の値) にマップ。
 *  schema migration の比較に使用。 */
function spFieldTypeString(t: FieldType): string {
  switch (t) {
    case 'Text': return 'Text';
    case 'Note': return 'Note';
    case 'NoteRich': return 'Note';      // Note + RichText フラグだが TypeAsString は同じ
    case 'Number': return 'Number';
    case 'DateTime': return 'DateTime';
    case 'Boolean': return 'Boolean';
    case 'Choice': return 'Choice';
  }
}

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
    { name: 'Department', type: 'Text' },
    { name: 'InquiryCategory', type: 'Text' },
    { name: 'ReporterEmail', type: 'Text' },
    { name: 'ReporterName', type: 'Text' },
    { name: 'DueDate', type: 'DateTime' },
    { name: 'RawSubject', type: 'Text' },
    { name: 'InitialConversationId', type: 'Text' },
    // チケットの起源ソース (mail / forms / teams / other)。詳細プロパティから変更可能。
    { name: 'Source', type: 'Text' },
    // タグ (辞書 SpiraSettings.tags.dictionary から選択した名前を JSON 配列で保存)。
    // 色・説明はチケット本体には持たない (辞書側で一元管理)。
    { name: 'Tags', type: 'Note' },
    { name: 'IsDeleted', type: 'Boolean' },
    { name: 'DeletedAt', type: 'DateTime' },
    // Teams 連携 (Forms → Spira → Teams 運用案)
    // DeepLink は Teams URL が 255 文字を超える場合があるので Note 型。
    // ChannelId / ThreadId は短いので Text で十分。
    { name: 'CustomerTeam', type: 'Text' },
    { name: 'InternalThreadId', type: 'Text' },
    { name: 'InternalChannelId', type: 'Text' },
    { name: 'InternalDeepLink', type: 'Note' },
    { name: 'UserThreadId', type: 'Text' },
    { name: 'UserChannelId', type: 'Text' },
    { name: 'UserDeepLink', type: 'Note' },
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
    // Origin of this comment ('mail' / 'teams' / 'other'). Drives the
    // card icon. Optional — legacy rows without this field default to
    // 'mail' in the renderer.
    { name: 'Source', type: 'Text' },
    // 'internal' / 'external' — どちらのスレッドペインに表示するか。
    // syncInbox の Teams auto-link 時に threadMap.threadType をそのまま入れる。
    // 手動追加時は UI で選択。未指定 (legacy) は UI 側で external にフォールバック。
    { name: 'ThreadKind', type: 'Text' },
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
    { name: 'SentAt', type: 'DateTime' },
    { name: 'OwaLink', type: 'Text' },
    { name: 'IsProcessed', type: 'Boolean' },
    { name: 'TicketId', type: 'Number' },
    { name: 'ProcessedAt', type: 'DateTime' },
    { name: 'ProcessResult', type: 'Choice', choices: ['auto-linked', 'manual-linked', 'created'] },
    { name: 'IsHidden', type: 'Boolean' },
    // 「管理外」マーク時の理由メモ (UI 上は IsHidden=true と同時に書き込み)。
    // 後から「なぜチケット管理対象外にしたか」を追跡できる監査用。
    { name: 'ExclusionReason', type: 'Note' },
    { name: 'InternetMessageId', type: 'Text' },
  ];
}

/** Spira の共通設定 (Key/Value)。
 *  例: Key="teams-channel:internal", Value=URL JSON
 *  PA フロー側からも参照可能 (Get item by Key)。 */
function settingsFieldSpecs(): FieldSpec[] {
  return [
    // Title 列を Key として流用 (SP の Title は必須・一意性を取りやすい)
    { name: 'SettingKey', type: 'Text' },
    { name: 'SettingValue', type: 'Note' },
  ];
}

/** Spira → Teams スレッド起票キュー。SP の「項目が作成されたとき」
 *  トリガーで PA フロー 2 が拾い、Teams にメッセージを投稿後、
 *  Tickets リストに DeepLink を書き戻して、この行を削除する。
 *  ChannelId / TeamId は SpiraSettings から起票時に解決して埋め込む
 *  ので、PA 側で SpiraSettings を再取得する必要がない。 */
function teamsPostRequestFieldSpecs(): FieldSpec[] {
  return [
    { name: 'TicketId', type: 'Number' },
    { name: 'ThreadType', type: 'Choice', choices: ['internal', 'user'] },
    { name: 'ChannelId', type: 'Text' },
    { name: 'TeamId', type: 'Text' },
    { name: 'RequestedAt', type: 'DateTime' },
    { name: 'Status', type: 'Choice', choices: ['Pending', 'Completed', 'Failed'] },
    { name: 'ErrorMessage', type: 'Note' },
    // Spira からチケット起票時にユーザが「タイトル」「本文」「メンション対象」を
    // 直接編集できるよう、3 つの列を追加。
    //   - Subject:        Teams 親メッセージの件名 (subject) として渡す
    //   - BodyHtml:       本文 (HTML 可)。PA はそのまま投稿 body に使う
    //   - MentionedEmails: メンションしたいユーザの email カンマ区切り。
    //                     PA 側で Get user profile (V2) → AAD ObjectId を引いて
    //                     <at> タグ + mentions[] を組み立てる。
    { name: 'Subject', type: 'Text' },
    { name: 'BodyHtml', type: 'NoteRich' },
    { name: 'MentionedEmails', type: 'Text' },
  ];
}

/** 監査ログ。チケット管理 / 受信スレッド / メモのライフサイクル
 *  イベントを追記する。retention 設定で期限切れは Spira クライアントが
 *  起動時に物理削除する。
 *  Title は表示用 (`<Action> #<TicketId>` の形)。 */
function auditLogFieldSpecs(): FieldSpec[] {
  return [
    { name: 'Timestamp', type: 'DateTime' },
    { name: 'ActorEmail', type: 'Text' },
    { name: 'ActorName', type: 'Text' },
    { name: 'Action', type: 'Text' },
    { name: 'TicketId', type: 'Number' },
    { name: 'TargetType', type: 'Text' },
    { name: 'TargetId', type: 'Number' },
    { name: 'Details', type: 'Note' },
    { name: 'ExpiresAt', type: 'DateTime' },
  ];
}

// ---------------------------------------------------------------- helpers reused by views
// 設定モーダルから編集可能 (warmOptionLists で起動時にキャッシュ済み)。
// 型は as cast でゆるく扱う (ユーザー追加値も許容)。
import { getStatusOptionsSync, getPriorityOptionsSync } from '../utils/optionLists';
export function ticketStatusList(): TicketStatus[] {
  return getStatusOptionsSync() as TicketStatus[];
}
export function priorityList(): Priority[] {
  return getPriorityOptionsSync() as Priority[];
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
