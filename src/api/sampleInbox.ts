// Sample InboxMail seeds — used before PA is set up to exercise the workflow.
import type { InboxMail } from '../types';

const minus = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export interface SampleInboxInput {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromEmail: string;
  fromName: string;
  receivedAt: string;
  hasAttachments: boolean;
  conversationId: string;
}

export function sampleInboxInputs(): SampleInboxInput[] {
  return [
    {
      subject: '見積もりのご依頼',
      bodyHtml: '<p>はじめまして、株式会社 ABC の高橋と申します。</p><p>貴社の月額プランについて見積もりをお願いしたく、ご連絡いたしました。</p><p>条件としては、ユーザー数 30 名・期間 1 年でお願いいたします。</p>',
      bodyText: '見積もりのご依頼。月額プラン・30名・1年',
      fromEmail: 'takahashi@abc.example',
      fromName: '高橋 健',
      receivedAt: minus(3),
      hasAttachments: false,
      conversationId: 'sample-cv-001',
    },
    {
      subject: '不具合のご報告',
      bodyHtml: '<p>管理画面の検索機能ですが、特定の条件で結果が表示されない症状が出ています。</p><p>再現条件: ステータス「完了」+ 日付範囲指定</p>',
      bodyText: '管理画面の検索結果が表示されない不具合',
      fromEmail: 'support@partner.example',
      fromName: 'サポート 鈴木',
      receivedAt: minus(6),
      hasAttachments: false,
      conversationId: 'sample-cv-002',
    },
    {
      subject: '本日のミーティング資料',
      bodyHtml: '<p>本日 14:00 ミーティングの資料をお送りします。</p><p>添付の PDF をご確認のうえ、当日までにフィードバックいただけますと幸いです。</p>',
      bodyText: '本日 14:00 ミーティング資料',
      fromEmail: 'pm@example.com',
      fromName: 'PM 山田',
      receivedAt: minus(8),
      hasAttachments: true,
      conversationId: 'sample-cv-003',
    },
    {
      subject: 'パスワードリセットのお願い',
      bodyHtml: '<p>お世話になっております。</p><p>本日より管理画面にアクセスできない状態が続いております。</p><p>パスワードリセットの手続きをお願いできますでしょうか。</p>',
      bodyText: 'パスワードリセット依頼',
      fromEmail: 'sato@client.example',
      fromName: '佐藤 美咲',
      receivedAt: minus(12),
      hasAttachments: false,
      conversationId: 'sample-cv-004',
    },
    {
      subject: '【至急】本日中にご対応お願いします',
      bodyHtml: '<p>本番環境のレポート出力で、件数が一致しない問題が出ています。</p><p>急ぎで確認をお願いいたします。</p>',
      bodyText: 'レポート件数が一致しない',
      fromEmail: 'ops@biz.example',
      fromName: '運用 田中',
      receivedAt: minus(1),
      hasAttachments: false,
      conversationId: 'sample-cv-005',
    },
  ];
}

export function toMockInbox(input: SampleInboxInput, id: number): InboxMail {
  return {
    id,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    receivedAt: input.receivedAt,
    hasAttachments: input.hasAttachments,
    conversationId: input.conversationId,
    owaLink: '#',
    isProcessed: false,
  };
}
