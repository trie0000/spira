// Spira domain types — UI 観点。SP リスト列名と整合。

export type TicketStatus = '新規' | '対応中' | '確認待ち' | '完了';
export type Priority    = 'High' | 'Medium' | 'Low';
export type CommentType = 'received' | 'note';
export type InboxState  = 'unprocessed' | 'auto-linked' | 'manual-linked' | 'created';
/** チケット / コメントの起源を表すソース種別。
 *  - 'mail'  : メール (Outlook 経由)
 *  - 'forms' : Microsoft Forms 経由
 *  - 'teams' : Teams スレッド経由
 *  - 'other' : 電話・口頭・社内システム転記等のその他 */
export type SourceKind = 'mail' | 'forms' | 'teams' | 'other';

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
  /** チケットの起源ソース。新規起票時に設定 (inbox 由来なら推定、新規ボタンなら
   *  ユーザー選択)。チケット詳細プロパティから後で変更可能。 */
  source?: SourceKind;
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
  /** 外部スレッド (顧客向け) の Teams messageId / channelId / DeepLink。
   *  内部フィールド名は userThreadId / userChannelId / userDeepLink のまま (DB 互換)。 */
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
  source?: SourceKind;
  /** スレッド種別:
   *   - 'internal' : 内部スレッド (社内議論用、Tickets.internalThreadId 由来)
   *   - 'external' : 外部スレッド (顧客/ユーザー向け、Tickets.userThreadId 由来、
   *                  またはメール等の外部由来)
   *  syncInbox の Teams auto-link 時に threadMap の hit.threadType をそのまま
   *  入れる。手動「履歴を追加」では UI 上で選択。
   *  未指定 (legacy) の場合は UI 側で source / fromEmail から推定 (デフォ external)。 */
  threadKind?: 'internal' | 'external';
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

export type ViewName = 'tickets' | 'inbox' | 'trash' | 'dashboard' | 'help';

// ─── 監査ログ (AuditLog リスト) ─────────────────────────────────────────
// 「いつ・誰が・何を更新したか」を保管する追記専用 (Append-only) ログ。
// 内容そのもの (メモ本文等) は保持せず、属性変更の前後値のような
// メタデータだけを Details (JSON) に残す。
//
// 保持期間 (default 30 日) は SpiraSettings の `audit.retention.days` で
// 設定可能。書込時に ExpiresAt = now + retention を一緒に保存し、起動時
// クリーンアップで ExpiresAt < now の行を物理削除する。

/** Audit イベントのアクション種別。文字列にしてあるのは SP の Choice 列で
 *  値が増えた場合の安全マージン用 (新規 enum を足しても SP マイグレーションが
 *  不要)。UI で表示時は AUDIT_ACTION_LABEL で日本語に変換。 */
export type AuditAction =
  | 'ticket.create'
  | 'ticket.update'
  | 'ticket.delete'        // ゴミ箱へ
  | 'ticket.restore'       // ゴミ箱から戻す
  | 'ticket.purge'         // 物理削除
  | 'note.create'
  | 'note.delete'
  | 'comment.add'          // 受信スレッドへの履歴追加
  | 'comment.update'       // 受信履歴の編集
  | 'comment.delete'
  | 'inbox.ingest'         // PA から受信メール取り込み (Spira から処理開始した時点)
  | 'inbox.link'           // 受信メールを既存チケットに紐付け
  | 'inbox.hide'           // 受信メールを非表示
  | 'teams.thread.create'  // Teams スレッド起票キュー
  | 'ai.note.save';        // AI 生成テキストをメモとして保存

export type AuditTargetType = 'ticket' | 'comment' | 'note' | 'inbox' | 'teams' | 'ai';

export interface AuditRecord {
  id: number;
  /** 操作時刻 (ISO)。 */
  timestamp: string;
  /** 実行ユーザのメール / 表示名。currentUser 未取得時は空欄。 */
  actorEmail?: string;
  actorName?: string;
  action: AuditAction;
  /** 対象チケット ID。受信メール起票前など、まだ Ticket が存在しないイベント
   *  では 0 (= ticket-less) を入れる。 */
  ticketId: number;
  targetType: AuditTargetType;
  /** 対象オブジェクトの SP Id (Comment / Inbox 等)。省略可。 */
  targetId?: number;
  /** 詳細 JSON 文字列。例: '{"status":["新規","対応中"]}' のような差分。
   *  パースは UI 側 (AuditLogModal) で行う。 */
  details?: string;
  /** 保持期限 (ISO)。これより古い行はクリーンアップで物理削除される。 */
  expiresAt: string;
}
