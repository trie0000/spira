// Spira 概要モーダル — 利用者向け / 技術者向けの 2 タブ。
// アーキ図 (SVG) を技術者タブに掲載。外部 (委託先・引継ぎ先) への
// 説明資料として、このモーダルを画面共有・スクショで使う想定。

import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { buildPaFlowsHelpBody } from './shell';

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

// ── 共通スタイル ─────────────────────────────────────────────────────
const H2 = 'margin:var(--s-5) 0 var(--s-2);font-size:var(--fs-md);' +
  'font-weight:600;color:var(--ink);border-bottom:1px solid var(--line);padding-bottom:6px';
const H3 = 'margin:var(--s-4) 0 var(--s-2);font-size:var(--fs-sm);font-weight:600;color:var(--ink-2)';
const P = 'margin:0 0 var(--s-3);font-size:var(--fs-sm);line-height:1.8;color:var(--ink)';
const UL = 'margin:0 0 var(--s-3);padding-left:1.4em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)';
const CODE = (s: string): HTMLElement => el('code', {
  style: 'background:var(--paper-2);padding:1px 6px;border-radius:3px;font-size:0.92em',
}, [s]);
const KBD = (s: string): HTMLElement => el('span', {
  style: 'background:var(--paper-3);border:1px solid var(--line);padding:1px 6px;' +
         'border-radius:3px;font-size:0.85em;font-family:ui-monospace,Menlo,monospace',
}, [s]);

// ── 利用者向けタブ ───────────────────────────────────────────────────
function renderUserTab(): HTMLElement {
  return el('div', { style: 'max-width:760px' }, [
    el('p', { style: P }, [
      el('strong', {}, ['Spira (読み: エスピラ)']),
      ' は SharePoint / Power Automate / Microsoft Teams を組み合わせた、',
      el('strong', {}, ['メール・Forms・Teams を 1 つのチケットに束ねる軽量な対応管理ツール']),
      ' です。専用サーバ不要、ブックマークレット 1 つで起動します。',
    ]),

    el('h2', { style: H2 }, ['🎯 このツールでできること']),
    el('ul', { style: UL }, [
      el('li', {}, ['📧 受信メール (個人 Outlook の To/Cc に特定 ML が含まれるものだけ PA で選別) を起票画面に自動取り込み']),
      el('li', {}, ['📋 Microsoft Forms の回答を起票画面に自動取り込み']),
      el('li', {}, ['💬 Teams スレッドでの議論・返信をチケット履歴に自動反映']),
      el('li', {}, ['🏢👥 1 チケット内で「内部スレッド (社内議論)」と「外部スレッド (顧客向け)」を並列管理']),
      el('li', {}, ['🔍 全文検索・ステータス/担当者/優先度フィルタ・CSV エクスポート']),
      el('li', {}, ['📊 ダッシュボード (オープン件数・担当別ワークロード・経過日数等)']),
      el('li', {}, ['🤖 AI チャット (社内 Azure OpenAI ゲートウェイ) でチケット内容について質問・要約']),
      el('li', {}, ['🗑 ゴミ箱から復元可能なソフトデリート + 監査ログ']),
    ]),

    el('h2', { style: H2 }, ['📍 基本の使い方']),
    el('h3', { style: H3 }, ['起動']),
    el('p', { style: P }, [
      'ブラウザに登録した ', el('strong', {}, ['Spira ブックマークレット']),
      ' を SharePoint サイト上で実行 → サイト選択 → 画面が表示されます。',
    ]),
    el('h3', { style: H3 }, ['新規チケット']),
    el('p', { style: P }, [
      '左下「新規チケット」ボタン、または「受信」一覧から該当メールを選んで「起票」。',
      '件名にチケット ID タグ (例: ', CODE('#ABC-0001'), ') が自動付与され、以降のメール返信が自動で履歴に紐付きます。',
    ]),
    el('h3', { style: H3 }, ['履歴を追加']),
    el('p', { style: P }, [
      'チケット詳細の左ペイン上部「+ 履歴を追加」から、',
      '・Teams のチャット (右クリック → コピー → 貼り付け)',
      '・メール本文 (.eml / .msg のドラッグ&ドロップ可)',
      '・電話・口頭メモなど、手書きの履歴',
      ' を追加できます。「追加先」セレクタで内部/外部スレッドを選択。',
    ]),
    el('h3', { style: H3 }, ['Teams スレッド連動']),
    el('p', { style: P }, [
      'チケット詳細の「🏢 内部スレッド起票」「👥 外部スレッド起票」ボタンで Teams にスレッドを作成。',
      '以降そのスレッドへの返信は自動で履歴に反映されます (PA フロー④経由)。',
    ]),
    el('h3', { style: H3 }, ['キーボードショートカット']),
    el('ul', { style: UL }, [
      el('li', {}, [KBD('⌘/Ctrl + K'), ' — 全文検索を開く']),
      el('li', {}, [KBD('Esc'), ' — モーダルを閉じる']),
    ]),

    el('h2', { style: H2 }, ['💾 データはどこに保存される?']),
    el('p', { style: P }, [
      'すべての情報 (チケット・履歴・受信メール・設定) は ',
      el('strong', {}, ['会社の SharePoint Online サイト上の専用リスト']),
      ' に保存されます。外部クラウドへの送信は一切ありません ',
      '(AI チャットを利用する場合のみ、社内 AI ゲートウェイ経由でチケット本文が送信されます。AI 設定で OFF 可能)。',
    ]),

    el('h2', { style: H2 }, ['🔐 誰がアクセスできる?']),
    el('p', { style: P }, [
      'SharePoint サイトに招待されたメンバーのみが Spira を起動できます。',
      'Spira 自体は SharePoint の権限をそのまま継承するので、サイトへのアクセス権がない人はチケットも見られません。',
    ]),
  ]);
}

// ── アーキテクチャ図 (SVG) ───────────────────────────────────────────
function renderArchDiagram(): HTMLElement {
  // Inline SVG. 800x520 内に 5 つのブロック (Sources / PA / SP / Spira / Admin) を配置。
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 540" style="width:100%;max-width:760px;height:auto;font-family:system-ui,-apple-system,sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/>
    </marker>
    <marker id="arrowBlue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6"/>
    </marker>
  </defs>

  <!-- Sources row -->
  <g font-size="12" text-anchor="middle">
    <rect x="40"  y="20" width="140" height="60" rx="6" fill="#fef3c7" stroke="#f59e0b"/>
    <text x="110" y="44" font-weight="600">📧 Outlook 共有</text>
    <text x="110" y="62" fill="#78350f">メールボックス</text>

    <rect x="220" y="20" width="140" height="60" rx="6" fill="#fef3c7" stroke="#f59e0b"/>
    <text x="290" y="44" font-weight="600">📋 Microsoft Forms</text>
    <text x="290" y="62" fill="#78350f">問い合わせフォーム</text>

    <rect x="400" y="20" width="140" height="60" rx="6" fill="#dbeafe" stroke="#3b82f6"/>
    <text x="470" y="44" font-weight="600">💬 Teams</text>
    <text x="470" y="62" fill="#1e3a8a">スレッド返信</text>

    <rect x="580" y="20" width="180" height="60" rx="6" fill="#e0e7ff" stroke="#6366f1"/>
    <text x="670" y="44" font-weight="600">👤 起票/担当者</text>
    <text x="670" y="62" fill="#3730a3">(社内ユーザー)</text>
  </g>

  <!-- Arrows down to PA -->
  <line x1="110" y1="80"  x2="110" y2="130" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="290" y1="80"  x2="290" y2="130" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="470" y1="80"  x2="470" y2="130" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- PA layer -->
  <g>
    <rect x="40"  y="135" width="540" height="80" rx="8" fill="#f0fdf4" stroke="#22c55e"/>
    <text x="310" y="160" text-anchor="middle" font-size="14" font-weight="700" fill="#14532d">⚡ Power Automate (Standard tier)</text>
    <g font-size="11" text-anchor="middle" fill="#166534">
      <text x="90"  y="190">①メール</text>
      <text x="90"  y="204">→ Inbox</text>
      <text x="200" y="190">②Teams 投稿</text>
      <text x="200" y="204">親メッセージ</text>
      <text x="310" y="190">③Forms</text>
      <text x="310" y="204">→ Inbox</text>
      <text x="420" y="190">④Teams 返信</text>
      <text x="420" y="204">→ Inbox</text>
      <text x="530" y="190">⑤(任意)</text>
      <text x="530" y="204">通知 etc</text>
    </g>
  </g>

  <!-- Arrows: PA → SP -->
  <line x1="310" y1="215" x2="310" y2="260" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- SP layer -->
  <g>
    <rect x="40"  y="265" width="540" height="100" rx="8" fill="#fff7ed" stroke="#f97316"/>
    <text x="310" y="290" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">🗂 SharePoint リスト群 (このサイト内)</text>
    <g font-size="11" text-anchor="middle" fill="#9a3412">
      <rect x="60"  y="305" width="100" height="42" rx="4" fill="#fff" stroke="#fdba74"/>
      <text x="110" y="324" font-weight="600">Tickets</text>
      <text x="110" y="338">チケット本体</text>

      <rect x="170" y="305" width="100" height="42" rx="4" fill="#fff" stroke="#fdba74"/>
      <text x="220" y="324" font-weight="600">Comments</text>
      <text x="220" y="338">履歴・スレッド</text>

      <rect x="280" y="305" width="100" height="42" rx="4" fill="#fff" stroke="#fdba74"/>
      <text x="330" y="324" font-weight="600">InboxMails</text>
      <text x="330" y="338">受信箱 (待機)</text>

      <rect x="390" y="305" width="100" height="42" rx="4" fill="#fff" stroke="#fdba74"/>
      <text x="440" y="324" font-weight="600">SpiraSettings</text>
      <text x="440" y="338">設定 (チャネル等)</text>

      <rect x="495" y="305" width="80"  height="42" rx="4" fill="#fff" stroke="#fdba74"/>
      <text x="535" y="324" font-weight="600">AuditLog</text>
      <text x="535" y="338">操作履歴</text>
    </g>
  </g>

  <!-- Spira (Bookmarklet) -->
  <line x1="310" y1="365" x2="310" y2="405" stroke="#3b82f6" stroke-width="2" marker-end="url(#arrowBlue)" stroke-dasharray="0"/>
  <line x1="310" y1="365" x2="310" y2="405" stroke="#3b82f6" stroke-width="2" marker-start="url(#arrowBlue)" transform="translate(20,0)"/>

  <g>
    <rect x="40"  y="410" width="540" height="100" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="310" y="435" text-anchor="middle" font-size="14" font-weight="700" fill="#1e3a8a">🔷 Spira (ブラウザブックマークレット)</text>
    <g font-size="11" text-anchor="middle" fill="#1e40af">
      <text x="110" y="460">起票/編集</text>
      <text x="110" y="478">CSV エクスポート</text>
      <text x="240" y="460">スレッド管理</text>
      <text x="240" y="478">内部/外部分離</text>
      <text x="370" y="460">検索/フィルタ</text>
      <text x="370" y="478">ダッシュボード</text>
      <text x="500" y="460">AI チャット</text>
      <text x="500" y="478">監査ログ閲覧</text>
    </g>
  </g>

  <!-- Admin lateral -->
  <line x1="670" y1="80" x2="670" y2="460" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="4,3"/>
  <line x1="670" y1="460" x2="580" y2="460" stroke="#6366f1" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="700" y="270" font-size="11" fill="#4338ca" text-anchor="middle">  </text>
  <text x="700" y="285" font-size="11" fill="#4338ca" text-anchor="middle">ブックマーク</text>
  <text x="700" y="299" font-size="11" fill="#4338ca" text-anchor="middle">レット起動</text>

  <!-- Legend -->
  <g font-size="10" fill="#475569">
    <rect x="40" y="525" width="10" height="10" fill="#fef3c7" stroke="#f59e0b"/>
    <text x="56" y="534">外部入口</text>
    <rect x="120" y="525" width="10" height="10" fill="#f0fdf4" stroke="#22c55e"/>
    <text x="136" y="534">自動化 (PA)</text>
    <rect x="220" y="525" width="10" height="10" fill="#fff7ed" stroke="#f97316"/>
    <text x="236" y="534">データ保存 (SP)</text>
    <rect x="340" y="525" width="10" height="10" fill="#eff6ff" stroke="#2563eb"/>
    <text x="356" y="534">UI (Spira)</text>
    <rect x="430" y="525" width="10" height="10" fill="#e0e7ff" stroke="#6366f1"/>
    <text x="446" y="534">ユーザー</text>
  </g>
</svg>`;
  return el('div', {
    html: svg,
    style: 'margin:var(--s-3) 0;padding:var(--s-3);background:#fff;border:1px solid var(--line);border-radius:var(--r-2)',
  });
}

// ── 技術者向けタブ ───────────────────────────────────────────────────
function renderTechTab(): HTMLElement {
  return el('div', { style: 'max-width:920px' }, [
    el('p', { style: P }, [
      el('strong', {}, ['Spira (読み: エスピラ)']),
      ' のアーキ概要・データソース・管理者操作の解説。',
      el('strong', {}, ['追加サーバ / 専用ライセンス不要']),
      ' で、SharePoint + Power Automate Standard tier のみで完結します。',
    ]),

    el('h2', { style: H2 }, ['🏗 アーキテクチャ全体図']),
    renderArchDiagram(),
    el('p', {
      style: P + ';font-size:var(--fs-xs);color:var(--ink-3)',
    }, [
      '外部入口 (黄) → Power Automate (緑) → SharePoint リスト (橙) → Spira UI (青) の単方向データフロー。',
      'Spira は SP REST API を現在ログインユーザーのコンテキストで直接呼び出し、書き込みも Bookmarklet 側から行う。',
      'PA は SP への書き込み専用 (Spira 側からトリガしない疎結合)。',
    ]),

    el('h2', { style: H2 }, ['📦 構成要素']),
    el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2);width:160px' }, ['要素']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['説明']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['Spira (Bookmarklet)']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'esbuild で 1 ファイルにバンドルした JS (約 600KB)。',
          'ブラウザのブックマークに JS URL として登録し、SharePoint タブで実行すると DOM にオーバーレイ表示。',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['SharePoint Online']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'データ保管庫。専用リスト 6 種類を自動作成 (初回起動時)。',
          '権限は SP サイトの権限を継承 (Spira 独自の権限管理なし)。',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['Power Automate']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'Standard tier (Premium / Graph API なし)。',
          '4 + α のフローでメール/Forms/Teams 返信を SP に書き込み + Teams 親メッセージ投稿。',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['Teams (任意)']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          '内部議論用 / 顧客向けチャネルを 1 つ以上。',
          'Spira がチケット起票時に親メッセージを投稿、以降の返信は PA フロー④で自動取り込み。',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px' }, ['AI ゲートウェイ (任意)']),
        el('td', { style: 'padding:6px 8px' }, [
          '社内 Azure OpenAI 互換ゲートウェイ。',
          'チケット詳細の AI チャットでのみ使用。',
        ]),
      ]),
    ]),

    el('h2', { style: H2 }, ['🗂 SharePoint リスト一覧']),
    el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2);width:180px' }, ['リスト']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['用途']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [CODE('Tickets')]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['チケット本体。件名・ステータス・優先度・担当者・部門・期日・Teams スレッド ID 等']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [CODE('Comments')]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'チケット内のすべての履歴 (受信メール・Teams 返信・手書きメモ)。Type=received/note、ThreadKind=internal/external で分類',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [CODE('InboxMails')]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'PA から書き込まれる受信メールキュー。Spira 同期時にチケット紐付け or 残置 (起票待ち)',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [CODE('TeamsPostRequests')]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'Spira → PA フロー② への Teams 投稿依頼キュー。投稿後に messageId が Tickets に保存される',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [CODE('SpiraSettings')]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'Key/Value 形式の設定保管 (Teams チャネル一覧 / ID 形式 / 部門・種別の選択肢 / 内部メンバー / 監査保持日数 / 自動同期間隔 等)',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px' }, [CODE('AuditLog')]),
        el('td', { style: 'padding:6px 8px' }, [
          '操作監査ログ (誰がいつ何をしたか)。既定 30 日保持で自動クリーンアップ',
        ]),
      ]),
    ]),

    el('h2', { style: H2 }, ['⚡ Power Automate フロー一覧']),
    el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2);width:160px' }, ['#']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['処理']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['① メール取込'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          '個人 Outlook の新着メールから To/Cc に特定 ML を含むものを PA 側で条件選別 → InboxMails に行追加 (件名にチケット ID タグがあれば自動紐付け、なければ起票待ち)',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['② Teams 投稿'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'TeamsPostRequests に新規行 → 指定チャネルに親メッセージ投稿 → messageId を Tickets に保存',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['③ Forms 取込'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'Forms 応答 → 応答詳細を取得 → BodyHtml 整形 → InboxMails に行追加 (ConversationId=forms-...)',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px' }, [el('strong', {}, ['④ Teams 返信取込'])]),
        el('td', { style: 'padding:6px 8px' }, [
          '監視チャネルへの返信 → メッセージ詳細取得 → 返信のみ AND aadUser 通過 → InboxMails (ConversationId=teams-<parentId>) → Spira が自動紐付け',
        ]),
      ]),
    ]),

    el('h2', { style: H2 }, ['🔐 認証と権限']),
    el('ul', { style: UL }, [
      el('li', {}, [
        el('strong', {}, ['Spira 側: ']),
        'ブラウザのログインセッション (SharePoint) をそのまま使用。',
        'OAuth / API キー設定は不要 (AI チャットを除く)。',
      ]),
      el('li', {}, [
        el('strong', {}, ['PA 側: ']),
        '各コネクタ (Outlook / SP / Teams / Forms) は PA フロー作成者のアカウントで認証。',
        '個人メールボックスを対象にする運用 (共有メールボックスは使用しない)。フロー作成者が ML の受信者である必要あり。',
      ]),
      el('li', {}, [
        el('strong', {}, ['SP 権限: ']),
        'リストの作成は SP サイトの「フルコントロール」または「サイトの所有者」が必要 (初回起動時のみ)。',
        '通常利用は「投稿」権限以上。',
      ]),
    ]),

    el('h2', { style: H2 }, ['🛠 管理者ができること']),
    el('ul', { style: UL }, [
      el('li', {}, ['設定モーダル (歯車 → 設定) で内部メンバー・部門・問い合わせ種別・チケット ID 形式を編集']),
      el('li', {}, ['Teams チャネル設定でスレッド投稿先チャネル群を管理 (channelId/teamId は Teams からコピー)']),
      el('li', {}, ['監査ログで全ユーザーの操作履歴を閲覧 (誰がいつ何を変更したか)']),
      el('li', {}, ['受信同期間隔 (秒) の調整']),
      el('li', {}, ['AI 設定でプロバイダ・モデル・API キーを切り替え']),
      el('li', {}, ['バージョン管理で最新ビルドを SP に登録 → 古いブックマーク利用者に更新案内を表示']),
      el('li', {}, ['(緊急) SP リストリセット — 全データ消去して再構築']),
    ]),

    el('h2', { style: H2 }, ['💰 ランニングコスト']),
    el('p', { style: P }, [
      'Spira 本体 (Bookmarklet + SP リスト + PA フロー) は ',
      el('strong', {}, ['¥0']),
      ' (既存の Microsoft 365 ライセンス枠内)。Power Automate Standard tier の Premium connector は使用していないため、追加ライセンス不要。',
      el('br'),
      el('strong', {}, ['AI チャット利用時のみ別途コスト発生: ']),
      '社内 AI ゲートウェイ経由でもモデル毎の従量課金 (使用したトークン量で計上)。',
      'コストを抑えたい場合は AI 機能を使用しないか、AI 設定で安価なモデル (例: GPT-4.1 mini 系) を選択。',
    ]),
  ]);
}

// ── PA フロー手順タブ (shell.ts の buildPaFlowsHelpBody を埋め込み) ────
function renderPaFlowsTab(): HTMLElement {
  const root = getRoot();
  const wrap = el('div', { style: 'min-height:300px' }, [
    el('p', { style: P }, [
      'メール / Forms / Teams からの自動取込と Teams スレッド投稿を担当する ',
      el('strong', {}, ['4 つの Power Automate フロー']),
      ' の作成手順です。すべて Standard tier (Premium / Graph API 不要) で動作します。',
    ]),
  ]);
  try {
    wrap.appendChild(buildPaFlowsHelpBody(root));
  } catch (e) {
    wrap.appendChild(el('div', { style: 'color:var(--danger);font-size:var(--fs-sm)' }, [
      `PA フロー手順の読み込みに失敗: ${(e as Error).message}`,
    ]));
  }
  return wrap;
}

// ── モーダル本体 ─────────────────────────────────────────────────────
type AboutTab = 'user' | 'tech' | 'pa';

export function openAboutModal(): void {
  let activeTab: AboutTab = 'user';

  const content = el('div', { style: 'min-height:520px' }, []);
  const renderContent = (): void => {
    if (activeTab === 'user') content.replaceChildren(renderUserTab());
    else if (activeTab === 'tech') content.replaceChildren(renderTechTab());
    else content.replaceChildren(renderPaFlowsTab());
  };

  const tabBtn = (label: string, key: AboutTab): HTMLElement => {
    const isActive = activeTab === key;
    return el('button', {
      style:
        'border:0;background:transparent;padding:10px 18px;cursor:pointer;' +
        `font-size:var(--fs-sm);font-weight:${isActive ? '600' : '400'};` +
        `color:${isActive ? 'var(--ink)' : 'var(--ink-3)'};` +
        `border-bottom:2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
      onclick: () => {
        if (activeTab === key) return;
        activeTab = key;
        rebuildTabs();
        renderContent();
      },
    }, [label]);
  };

  const tabBar = el('div', {
    style: 'display:flex;gap:0;border-bottom:1px solid var(--line);margin-bottom:var(--s-4)',
  }, []);

  const rebuildTabs = (): void => {
    tabBar.replaceChildren(
      tabBtn('👤 利用者向け', 'user'),
      tabBtn('🛠 技術者向け', 'tech'),
      tabBtn('⚡ PA フロー作成手順', 'pa'),
    );
  };
  rebuildTabs();
  renderContent();

  const body = el('div', { style: 'width:100%;height:100%;overflow-y:auto' }, [
    tabBar,
    content,
  ]);

  openModal(getRoot(), {
    title: '📘 Spira (エスピラ) について',
    body,
    size: 'xl',
    primaryLabel: '閉じる',
    onPrimary: async () => { /* close only */ },
  });
}
