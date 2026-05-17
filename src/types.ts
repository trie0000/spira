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
  /** 担当者のメールアドレス (複数可)。SP には AssigneeEmail 列に
   *  カンマ区切りで保存。空配列または undefined = 未割当。 */
  assigneeEmails?: string[];
  /** 担当者の表示名 (assigneeEmails と同順)。 */
  assigneeNames?: string[];
  /** 問い合わせ部門 (設定で改廃可能なリストから選択)。 */
  department?: string;
  /** 問い合わせ種別 (設定で改廃可能なリストから選択)。
   *  Forms 起票時は応答のカテゴリ値が自動で入る。 */
  inquiryCategory?: string;
  reporterEmail?: string;
  reporterName?: string;
  dueDate?: string;            // ISO datetime
  rawSubject?: string;
  initialConversationId?: string;
  isDeleted?: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  // --- Teams 連携 (Forms → Spira → Teams 運用案) ---
  /** 顧客 Team 識別子（外部スレッド起票先の切替用） */
  customerTeam?: string;
  /** 内部スレッド (社内議論用) の Teams messageId / channelId / DeepLink */
  internalThreadId?: string;
  internalChannelId?: string;
  internalDeepLink?: string;
  /** ユーザースレッド (顧客向け) の Teams messageId / channelId / DeepLink */
  userThreadId?: string;
  userChannelId?: string;
  userDeepLink?: string;
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
  /** Origin of this comment, used to pick the icon on the card.
   *   - 'mail'  : received via auto-sync from InboxMails, or manually
   *               added through the "履歴を追加" modal with source=mail.
   *   - 'teams' : pasted from Teams via the "履歴を追加" modal.
   *   - 'other' : any other manual entry (phone, in-person, etc.).
   *  Legacy comments without this field render with the mail icon. */
  source?: 'mail' | 'teams' | 'other';
  /** SP の Author (登録者) と Editor (最終更新者)。SP 側の自動付与で、
   *  受信スレッドカードに「誰がいつ登録/更新したか」を表示するために使う。 */
  createdBy?: string;
  updatedBy?: string;
  /** SP の Created / Modified タイムスタンプ (ISO)。sentAt は送信時刻、
   *  これらは SP リストへの登録/更新時刻。 */
  createdAt?: string;
  updatedAt?: string;
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
