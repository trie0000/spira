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
}

export interface InboxMail {
  id: number;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromEmail: string;
  fromName?: string;
  receivedAt: string;
  hasAttachments: boolean;
  conversationId?: string;
  owaLink?: string;
  isProcessed: boolean;
  ticketId?: number;
  processedAt?: string;
  processResult?: InboxState;
  isHidden?: boolean;
}

export interface SiteUser {
  id: number;
  email: string;
  displayName: string;
}

export type ViewName = 'tickets' | 'inbox' | 'trash';
