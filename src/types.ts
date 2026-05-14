// Spira domain types — UI 観点。SP リスト列名と整合。

export type TicketStatus = '新規' | '対応中' | '確認待ち' | '完了';
export type Priority    = 'High' | 'Medium' | 'Low';
export type CommentType = 'received' | 'note';
export type InboxState  = 'unprocessed' | 'auto-linked' | 'manual-linked' | 'created';

export interface Ticket {
  id: number;                  // SP の Id を流用、`#001` 表示
  title: string;
  description?: string;
  status: TicketStatus;
  priority: Priority;
  assigneeEmail?: string;
  assigneeName?: string;
  reporterEmail?: string;
  reporterName?: string;
  dueDate?: string;            // ISO datetime
  rawSubject?: string;
  initialConversationId?: string;
  isDeleted?: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  ticketId: number;
  type: CommentType;
  fromEmail?: string;
  fromName?: string;
  content: string;             // HTML for received, plain text for note
  isHtml: boolean;
  sentAt: string;
  sourceEmailId?: number;
  hasAttachments?: boolean;    // true when the source mail had real attachments
  internetMessageId?: string;  // RFC 822 Message-ID (世界で一意)。OWA messageid: 検索用
}

export interface InboxMail {
  id: number;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromEmail: string;
  fromName?: string;
  /** When the recipient mailbox received the message. Stable for display
   *  / sorting; can drift between mailboxes for the same message. */
  receivedAt: string;
  /** When the sender pressed "send". Identical across all recipients of
   *  the same message, so this is the field Spira uses for duplicate-
   *  ticket detection. PA flow must populate it from the `Sent Time`
   *  dynamic content. Optional for backward compat — legacy rows that
   *  only had `receivedAt` keep working via fallback. */
  sentAt?: string;
  hasAttachments: boolean;
  conversationId?: string;
  owaLink?: string;
  isProcessed: boolean;
  ticketId?: number;
  processedAt?: string;
  processResult?: InboxState;
  isHidden?: boolean;
  internetMessageId?: string;
}

export interface SiteUser {
  id: number;
  email: string;
  displayName: string;
}

export type ViewName = 'tickets' | 'inbox' | 'trash';
