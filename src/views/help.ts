// オンラインヘルプ (左サイドナビ + 右本文)。サイドバーの「ヘルプ」項目
// から開く独立 View。PA フロー作成手順は別途歯車メニューの「ヘルプ (PA
// フロー作成手順)」モーダルに残してあり、ここからはリンクで案内する。

import { el } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState } from '../state';

interface Section {
  key: string;
  label: string;
  icon?: string;
  render: () => HTMLElement;
}

// ── 共通スタイル ─────────────────────────────────────────────────────
const H1 = 'margin:0 0 var(--s-3);font-size:var(--fs-xl);font-weight:700;color:var(--ink)';
const H2 = 'margin:var(--s-6) 0 var(--s-3);font-size:var(--fs-lg);font-weight:600;color:var(--ink);' +
  'border-bottom:1px solid var(--line);padding-bottom:6px';
const H3 = 'margin:var(--s-4) 0 var(--s-2);font-size:var(--fs-md);font-weight:600;color:var(--ink-2)';
const P = 'margin:0 0 var(--s-3);font-size:var(--fs-sm);line-height:1.8;color:var(--ink)';
const UL = 'margin:0 0 var(--s-3);padding-left:1.4em;line-height:1.8;font-size:var(--fs-sm);color:var(--ink)';
const HINT = 'margin:var(--s-3) 0;padding:var(--s-3) var(--s-4);background:var(--paper-2);' +
  'border-left:3px solid var(--accent);border-radius:var(--r-2);font-size:var(--fs-sm);line-height:1.7';
const CODE = (s: string): HTMLElement => el('code', {
  style: 'background:var(--paper-2);padding:1px 6px;border-radius:3px;font-size:0.92em',
}, [s]);
const KBD = (s: string): HTMLElement => el('span', {
  style: 'background:var(--paper-3);border:1px solid var(--line);padding:1px 6px;' +
         'border-radius:3px;font-size:0.85em;font-family:ui-monospace,Menlo,monospace',
}, [s]);

// ────────────────────────────── 各セクション ──────────────────────────────

function renderIntro(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['はじめに']),
    el('p', { style: P }, [
      'Spira (スパイラ) はメール・Forms・Teams を 1 つのチケットに束ねて管理する軽量ツールです。',
      'ブックマークレット 1 つで起動でき、専用サーバや追加ライセンスは不要です。',
    ]),

    el('h2', { style: H2 }, ['想定する使い方']),
    el('ul', { style: UL }, [
      el('li', {}, ['外部から問い合わせメール / Forms 入力 / Teams 連絡を受ける窓口']),
      el('li', {}, ['対応中の議論を内部スレッド・外部スレッドに分けて管理']),
      el('li', {}, ['担当者の割り当て・影響度・期日・ステータス管理']),
      el('li', {}, ['過去の対応の検索 / 横串集計 (ダッシュボード)']),
    ]),

    el('h2', { style: H2 }, ['アーキテクチャ概要']),
    el('p', { style: P }, [
      'データは ', el('strong', {}, ['SharePoint Online のリスト']),
      ' に保存され、外部へ送信されることはありません (AI チャットを除く)。',
      'メール・Forms・Teams 返信の取り込みは ', el('strong', {}, ['Power Automate']),
      ' が担当し、Spira (ブックマークレット) は SharePoint を直接読み書きします。',
    ]),
    el('div', { style: HINT }, [
      '詳しいアーキ図は ',
      el('strong', {}, ['歯車 → Spira について → 技術者向け']),
      ' タブで確認できます。',
    ]),

    el('h2', { style: H2 }, ['まずやること']),
    el('ol', { style: UL }, [
      el('li', {}, ['Spira を起動 (ブックマークレットをクリック、必ず SharePoint サイトを開いた状態で)']),
      el('li', {}, ['SP サイトを選択 → 自動で必要なリストが作成される']),
      el('li', {}, ['歯車 → 設定 → 内部メンバーに自社ドメインを登録']),
      el('li', {}, ['(任意) Teams チャネル / Forms 連携 / タグ辞書 / ステータス・影響度の選択肢を整える']),
      el('li', {}, ['(任意) Power Automate でフロー①〜④を作成 (メール/Forms/Teams の自動取込)']),
    ]),
    el('div', { style: HINT }, [
      '★ ', el('strong', {}, ['install.html (配布ページ) で間違って起動した場合']),
      ' は警告ダイアログが表示されて何も起きません。SharePoint サイトを開いてから再度ブックマークをクリックしてください。',
    ]),
    el('div', { style: HINT }, [
      '★ ヘッダ左の ', el('strong', {}, ['📁 ワークスペース名']),
      ' は現在接続中の SP サイト名です。クリックで該当サイトを新規タブで開きます (複数サイトの切替確認に便利)。',
    ]),
  ]);
}

function renderBasics(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['基本操作']),

    el('h2', { style: H2 }, ['画面構成']),
    el('ul', { style: UL }, [
      el('li', {}, [el('strong', {}, ['左サイドバー: ']), 'ダッシュボード / チケット一覧 / 受信 / ゴミ箱 / ヘルプ。']),
      el('li', {}, [el('strong', {}, ['右上ヘッダ: ']), '🔄 同期 / 検索アイコン / 歯車 (設定・ヘルプ)。']),
      el('li', {}, [el('strong', {}, ['左下: ']), '「新規チケット」ボタン。']),
    ]),

    el('h2', { style: H2 }, ['新規チケット起票']),
    el('p', { style: P }, [
      '起票の入り口は ',
      el('strong', {}, ['メール / Teams / Forms / その他 (電話・口頭・社内依頼)']),
      ' の何から始めるかで使い分けます。どの方法でも最終的には同じ「新規チケット」モーダルに集約され、件名・本文・担当者・カテゴリ・影響度・期日を編集して保存します。',
    ]),

    el('h3', { style: H3 }, ['方法 1: 空のチケットから (その他のソース全般)']),
    el('p', { style: P }, [
      '左下「', el('strong', {}, ['+ 新規チケット']), '」ボタンで空のモーダルを起動 → 件名・本文を手入力 → 保存。',
    ]),
    el('p', { style: P }, [
      el('strong', {}, ['想定ソース: ']),
      '電話で受けた問い合わせ / 口頭依頼 / 社内システムからの転記 / 関連会社からの ',
      el('strong', {}, ['ファイル (.docx / .xlsx / .pdf 等)']),
      ' で来た依頼 / 過去案件の再対応 など。',
    ]),

    el('h3', { style: H3 }, ['方法 2: 受信メールから']),
    el('p', { style: P }, [
      '「受信」一覧から該当メールを選択 → 「起票」 → 件名・本文・送信者が自動補完されたモーダルで保存。',
    ]),

    el('h3', { style: H3 }, ['方法 3: .eml / .msg ファイルから']),
    el('p', { style: P }, [
      'Outlook のメールを .eml / .msg として保存 → 新規起票モーダルに ',
      el('strong', {}, ['ドラッグ&ドロップ']),
      ' → 件名・送信者・本文・HTML 形式・添付情報が自動展開。',
      el('br'),
      'Outlook for Windows からの直接ドラッグ (本文プレビューを掴んでドロップ) でも同等に取り込まれます。',
    ]),

    el('h3', { style: H3 }, ['方法 4: Teams のチャットコピーから']),
    el('p', { style: P }, [
      'Teams で複数メッセージを範囲選択 → 右クリック → ',
      el('strong', {}, ['コピー']),
      ' → Spira の「+ 新規チケット」モーダル本文に ',
      el('strong', {}, ['貼り付け']),
      ' → 自動でメッセージ群がパースされ、送信者・送信時刻・本文がチケット履歴に展開されます。',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, [
        '★ 先頭メッセージの送信者名は Teams の仕様で取得できないため「送信者」欄に手入力 (空欄なら「不明」)',
      ]),
      el('li', {}, ['送信時刻は当日 0:00 を起点に Teams が表示している相対時刻 (例: 「14:32」「2 時間前」) を絶対時刻に解決']),
      el('li', {}, ['重複チェック: 同じ送信者 + 同じ時刻 + 同じ本文の組合せがあれば確認ダイアログで重複を除外可能']),
    ]),

    el('h3', { style: H3 }, ['方法 5: Microsoft Forms 経由 (自動)']),
    el('p', { style: P }, [
      'PA フロー③ を設定済みなら、Forms 応答が「受信」一覧に Forms バッジ付きで自動追加されます。',
      '一覧から選択 → 「起票」で、フォームの「カテゴリ」「影響度」値が自動マッピングされたモーダルが開きます。',
    ]),
    el('p', { style: P }, [
      '※ Forms は ', el('strong', {}, ['顧客からの不具合問い合わせ専用']),
      ' (社内 Forms 運用なし) のため、Forms 起票チケットの履歴は自動で ',
      el('strong', { style: 'color:#92400e' }, ['👥 外部スレッド']),
      ' に振り分けられます。',
    ]),
    el('p', { style: P }, [
      '※ 起票後のチケット詳細にはヘッダ下に ', el('strong', {}, ['📋 Forms 回答一覧を開く']),
      ' リンクが表示されます (',
      CODE('歯車 → 設定 → Forms 連携'), ' で URL を 1 件登録)。',
    ]),

    el('div', { style: HINT }, [
      el('strong', {}, ['共通: ']),
      'いずれの方法でも、起票後に件名 (タグ ',
      CODE('[CASE#NNNNN]'),
      ' 部分) を保ったまま返信メールが来ると、',
      'PA フロー① 経由で自動的にそのチケットの履歴に追加されます。',
    ]),

    el('h2', { style: H2 }, ['チケット詳細']),
    el('h3', { style: H3 }, ['左ペイン: スレッド (履歴)']),
    el('p', { style: P }, [
      '🏢 内部スレッド (社内議論) と 👥 外部スレッド (顧客向け) を表示。上部のトグルで:',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, ['🏢 内部のみ / 👥 外部のみ / ⫻ 並列 / 🔀 マージ の 4 モードに切替']),
      el('li', {}, ['並列モード: ドラッグで幅変更、ダブルクリックで 50/50 リセット']),
      el('li', {}, ['マージモード: 時系列に統合表示、内部/外部はカラー (青/橙) で区別']),
    ]),
    el('p', { style: P }, [
      '「+ 履歴を追加」で Teams のチャットや手書きメモを追加できます。',
      '「追加先」セレクタで内部/外部を選択。',
    ]),

    el('h3', { style: H3 }, ['右ペイン: 内部メモ (添付対応)']),
    el('p', { style: P }, [
      'チケットに関連する補足情報・調査メモ・ToDo 等を自由形式で書き留めます。',
      '左ペインの履歴とは独立しており、外部とのやり取りに混ざりません。',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, ['Markdown / リッチテキスト編集 (見出し / リスト / コードブロック等)']),
      el('li', {}, [
        el('strong', {}, ['📎 ファイル添付: ']),
        'メモ本文にファイルをドラッグ&ドロップ、または ',
        CODE('/file'),
        ' スラッシュコマンドで添付。SP のドキュメントライブラリに保存され、リンクチップとして表示',
      ]),
      el('li', {}, ['🖼 画像はクリップボードから直接貼り付け可能 (スクリーンショット記録に便利)']),
      el('li', {}, ['Excel / PDF / Word 等は拡張子別アイコン + Office Online Viewer リンク化']),
    ]),

    el('h3', { style: H3 }, ['Teams スレッド起票 + Forms 回答リンク']),
    el('p', { style: P }, [
      '「🏢 内部スレッド起票」「👥 外部スレッド起票」ボタンで、',
      '事前に設定したチャネルに親メッセージを投稿。以降そのスレッドへの返信は',
      'PA フロー④経由で自動的にチケット履歴に取り込まれます。',
      el('br'),
      'Forms 起票チケットの場合は右隣に ', el('strong', {}, ['📋 Forms 回答一覧']),
      ' ボタンが表示され、クリックで回答の管理者ビューを開きます。',
    ]),

    el('h3', { style: H3 }, ['タグ']),
    el('p', { style: P }, [
      'ヘッダ下「タグ」行で ', el('strong', {}, ['+ 編集']),
      ' をクリックすると ',
      CODE('設定 → タグ辞書'),
      ' に登録された色付きタグから複数選択できます (自由入力は不可、混沌防止のため厳格辞書方式)。',
      el('br'),
      el('strong', {}, ['チケット本体']),
      ' に紐付くタグです (コメント/メモ単位ではなく)。タグ辞書の admin 管理は ',
      CODE('歯車 → 設定 → タグ辞書'),
      ' で。',
    ]),

    el('h2', { style: H2 }, ['チケット一覧']),
    el('ul', { style: UL }, [
      el('li', {}, ['フィルタ: ステータス / 担当者 / 影響度 / フリーワード']),
      el('li', {}, ['ソート: ID / 件名 / ステータス / 担当 / 影響度 / 期日 / 更新日']),
      el('li', {}, ['件名横に色付きタグピル表示 (タグ辞書登録時)']),
      el('li', {}, ['バルク操作: チェックボックスで複数選択 → ステータス/影響度/担当者の一括変更']),
      el('li', {}, ['CSV エクスポート (現在のフィルタ条件 or 選択分)']),
      el('li', {}, [
        el('strong', {}, ['完了チケットの日数凍結: ']),
        'ステータスが「完了」になった瞬間に経過日 / 滞留日が止まり、行がグレーアウト',
      ]),
    ]),

    el('h2', { style: H2 }, ['チケットのエクスポート']),
    el('p', { style: P }, [
      'チケット詳細ヘッダの ', el('strong', {}, ['📤 エクスポート']),
      ' ボタンで、選択したセクションを 4 形式から書き出せます。',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, [el('strong', {}, ['対象選択: ']), '🏢 内部スレッド / 👥 外部スレッド / 📝 内部メモ の組合せ']),
      el('li', {}, [el('strong', {}, ['表示形式: ']), '併記 (独立セクション) / マージ (時系列統合、ラベル付き) を切替']),
      el('li', {}, [el('strong', {}, ['オプション: ']), 'チケット属性 / 送信者・送信時刻 / HTML 本文そのまま / 添付リンク を個別 ON/OFF']),
      el('li', {}, [
        el('strong', {}, ['形式: ']),
        '📝 Markdown / 🌐 HTML / 📄 PDF (印刷ダイアログ経由) / 🧬 JSON',
      ]),
    ]),
    el('div', { style: HINT }, [
      'PDF は新規タブで HTML を開いてブラウザの印刷ダイアログから「PDF として保存」を選びます。',
      'HTML は単独ファイルでメール添付可能 (画像は base64 でインライン埋め込み)。',
    ]),

    el('h2', { style: H2 }, ['キーボードショートカット']),
    el('table', {
      style: 'width:auto;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('td', { style: 'padding:4px 16px 4px 0' }, [KBD('⌘/Ctrl + K')]),
        el('td', {}, ['全文検索を開く']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:4px 16px 4px 0' }, [KBD('Esc')]),
        el('td', {}, ['モーダルを閉じる']),
      ]),
    ]),
  ]);
}

function renderInbox(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['受信一覧']),
    el('p', { style: P }, [
      '左サイドバー「受信」には、まだチケットに紐付いていないメール・Forms 応答・Teams 返信が一覧されます。',
      '件名にチケット ID タグがあれば PA / Spira 同期時に自動で対応チケットに紐付き、',
      '紐付けに失敗したものだけがここに残ります。',
      el('br'),
      el('strong', {}, ['ソート: ']),
      'ヘッダ (件名 / 送信者 / 受信日時) クリックで昇順/降順切替。',
    ]),

    el('h2', { style: H2 }, ['行ごとのアクション']),
    el('ul', { style: UL }, [
      el('li', {}, [el('strong', {}, ['＋ 起票: ']), '新規チケットを作成 (件名・本文・送信者・送信時刻が自動入力)。保存直前に IsProcessed を再フェッチして二重起票防止']),
      el('li', {}, [el('strong', {}, ['⌬ 紐付け: ']), 'チケット ID を指定して既存チケットの履歴に追加']),
      el('li', {}, [
        el('strong', {}, ['管理外: ']),
        'チケット管理対象外にする (理由を記録)。SP 上は IsHidden=true + ExclusionReason に理由が保存される。',
        '「管理外も表示」トグルで後から確認可、「再対象化」で元に戻せる',
      ]),
      el('li', {}, [
        el('strong', { style: 'color:var(--danger)' }, ['🗑 削除: ']),
        '受信一覧リストから物理削除 (元に戻せない)。「管理外」と違い SP の InboxMails から完全に消える',
      ]),
    ]),
    el('div', { style: HINT }, [
      el('strong', {}, ['「管理外」と「削除」の使い分け: ']),
      'スパム・テスト送信・別チケットで対応中の二重通知などは ',
      el('strong', {}, ['管理外']),
      ' (理由を残して非表示) が安全。完全に不要な行を整理したい時のみ ',
      el('strong', {}, ['削除']),
      ' を使う。',
    ]),
    el('p', { style: P }, [
      el('strong', {}, ['バルク操作: ']),
      '複数行を選択するとサブバーに「N 件を管理外」「N 件削除」ボタンが出現。一括処理可能。',
    ]),

    el('h2', { style: H2 }, ['バッジの意味']),
    el('ul', { style: UL }, [
      el('li', {}, [el('strong', {}, ['📋 Forms: ']), 'Microsoft Forms 経由の応答 (起票時は自動で外部スレッド扱い)']),
      el('li', {}, [el('strong', {}, ['💬 Teams: ']), 'Teams スレッドへの返信 (チケット紐付け失敗の手動トリアージ待ち)']),
      el('li', {}, [el('strong', {}, ['管理外: ']), 'チケット管理対象外マーク (再対象化可能、理由はバッジのツールチップで確認)']),
      el('li', {}, [el('strong', {}, ['(無バッジ): ']), '通常のメール']),
    ]),

    el('h2', { style: H2 }, ['自動同期と手動同期']),
    el('p', { style: P }, [
      '受信一覧は ', el('strong', {}, ['既定 60 秒間隔で自動更新']),
      ' されます。間隔は ', CODE('歯車 → 設定 → 受信同期 — 自動更新間隔'), ' で変更可能 (0 で OFF)。',
      'すぐに更新したい場合は右上の 🔄 同期ボタンをクリックしてください。',
    ]),
  ]);
}

function renderThreads(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['内部スレッド / 外部スレッドの使い分け']),

    el('p', { style: P }, [
      'Spira では 1 つのチケットに対して 2 種類のスレッド (履歴) を並列管理できます:',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, [
        el('strong', { style: 'color:#1e40af' }, ['🏢 内部スレッド: ']),
        '社内議論・調査メモ・関係者間の調整。社外には見せない情報。',
      ]),
      el('li', {}, [
        el('strong', { style: 'color:#92400e' }, ['👥 外部スレッド: ']),
        '顧客・お客様・取引先とのやり取り。受信メールはここに集約。',
      ]),
    ]),

    el('h2', { style: H2 }, ['自動振り分けのルール']),
    el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['取込元']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['振り分け先']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['メール (PA フロー①)']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['👥 外部 (常に)']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['Teams 返信 (PA フロー④)']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          'チケットの ', CODE('internalThreadId'), ' に紐付くなら 🏢 内部、',
          CODE('userThreadId'), ' に紐付くなら 👥 外部',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px' }, ['手動追加']),
        el('td', { style: 'padding:6px 8px' }, ['モーダルの「追加先」セレクタで選択 (現在の表示モードに応じて初期値が変わる)']),
      ]),
    ]),

    el('h2', { style: H2 }, ['表示モード']),
    el('ul', { style: UL }, [
      el('li', {}, [el('strong', {}, ['🏢 内部のみ / 👥 外部のみ: ']), '片方だけフル幅で集中表示']),
      el('li', {}, [el('strong', {}, ['⫻ 並列: ']), '両方を横並びで表示。間のリサイザで幅調整。それぞれ独立スクロール']),
      el('li', {}, [el('strong', {}, ['🔀 マージ: ']), '時系列で 1 列に統合。連続する同種は外側カードでグループ化、青/橙で区別']),
    ]),

    el('div', { style: HINT }, [
      '選択した表示モードは ',
      CODE('localStorage'),
      ' に保存され、すべてのチケットで共通の初期値になります。',
    ]),
  ]);
}

function renderAi(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['AI チャット']),

    el('p', { style: P }, [
      'チケット詳細の右上 ✨ ボタンで AI チャットペインを開けます。',
      'チケット本文・履歴を文脈として、要約・回答案作成・情報抽出などを指示できます。',
    ]),

    el('h2', { style: H2 }, ['利用するゲートウェイ']),
    el('p', { style: P }, [
      el('strong', {}, ['社内 AI (Azure OpenAI 互換) ゲートウェイ']),
      ' 経由でのみ利用します。Base URL とデプロイ ID のプレフィクス・API キーを設定します。',
      '外部 AI サービスへ直接接続することはありません。',
    ]),

    el('h2', { style: H2 }, ['データの流れ']),
    el('p', { style: P }, [
      'AI チャットを開いた瞬間に該当チケットの本文・履歴が社内 AI ゲートウェイに送信されます。',
      '機密情報を扱う場合はモデル選択や利用シーンに注意してください。',
      'AI 設定でプロバイダを使用しなければ送信は発生しません。',
    ]),

    el('h2', { style: H2 }, ['コスト']),
    el('p', { style: P }, [
      '社内 AI ゲートウェイ経由でも ', el('strong', {}, ['モデル毎の従量課金']),
      ' (トークン消費量で計上) が発生します。コストを抑えるには',
      'AI 設定で安価なモデルを選択する、もしくは利用シーンを限定してください。',
    ]),

    el('h2', { style: H2 }, ['設定場所']),
    el('p', { style: P }, [
      CODE('歯車 → 設定 → AI 設定'),
      ' から API キー・モデル・Base URL・デプロイ ID プレフィクスを設定できます。',
    ]),
  ]);
}

function renderAdmin(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['管理者向け']),

    el('h2', { style: H2 }, ['初回セットアップ']),
    el('ol', { style: UL }, [
      el('li', {}, ['SP サイトの所有者権限で Spira を起動 → リスト自動作成']),
      el('li', {}, [CODE('歯車 → 設定 → 内部メンバー'), ' で社内ドメインを登録']),
      el('li', {}, [CODE('歯車 → 設定 → チケット ID 形式'), ' で件名タグの接頭辞・桁数を決定']),
      el('li', {}, [
        CODE('歯車 → 設定 → ステータス / 影響度 / 部門 / 問い合わせ種別 / タグ辞書'),
        ' で各選択肢を整える',
      ]),
      el('li', {}, [CODE('歯車 → 設定 → Teams チャネル / Forms 連携'), ' を登録 (任意)']),
      el('li', {}, ['Power Automate で 4 フロー (メール / Teams投稿 / Forms / Teams返信) を作成']),
    ]),

    el('h2', { style: H2 }, ['選択肢の管理 (ステータス / 影響度 / 部門 / 種別 / タグ辞書)']),
    el('p', { style: P }, [
      '設定ハブの「基本」カテゴリで編集可能。共通機能:',
    ]),
    el('ul', { style: UL }, [
      el('li', {}, ['追加 / 削除 / 並び替え']),
      el('li', {}, ['各行をクリックで ', el('strong', {}, ['名称をインライン編集'])]),
      el('li', {}, [
        el('strong', {}, ['保存ボタンを押すと既存チケットも一括更新: ']),
        '名称変更 → 該当チケットを新名に書き換え / 削除 → 該当チケットの値をブランクにリセット',
      ]),
    ]),
    el('div', { style: HINT }, [
      el('strong', {}, ['注意: ']),
      'ステータス / 影響度は SP の Choice 列なので、新しい選択肢を追加した場合は ',
      el('strong', {}, ['SP リスト側 Choice 列にも同名値を手動追加']),
      ' する必要があります (SP リスト設定 → 列 → Status / Priority)。',
    ]),

    el('h2', { style: H2 }, ['タグ辞書 (admin 管理)']),
    el('p', { style: P }, [
      CODE('歯車 → 設定 → タグ辞書'),
      ' で名前 + 色 (10 色プリセット) + 説明 を登録。利用者はチケット詳細の「タグ」行で辞書から選択のみ可能 (自由入力不可で表記揺れ防止)。',
      el('br'),
      'タグ名変更 / 削除時は既存チケットの tags 配列も自動で書き換え/除去されます (保存時の一括更新)。',
    ]),

    el('h2', { style: H2 }, ['Forms 連携']),
    el('p', { style: P }, [
      CODE('歯車 → 設定 → Forms 連携'),
      ' で Forms 管理画面の URL を 1 件登録。Forms 起票チケット詳細のヘッダボタン ',
      el('strong', {}, ['📋 Forms 回答一覧']),
      ' から該当フォームの回答管理者ビューにジャンプできます。回答 ID はボタンの title 属性で確認。',
    ]),

    el('h2', { style: H2 }, ['監査ログ']),
    el('p', { style: P }, [
      CODE('歯車 → 設定 → 監査ログ'),
      ' で全ユーザーの操作履歴 (チケット作成・更新・削除・受信処理・Teams 投稿等) を一覧できます。',
      '既定 30 日保持で自動クリーンアップ。',
      ' 保持日数は SpiraSettings の ', CODE('audit.retention.days'), ' で変更可能。',
    ]),

    el('h2', { style: H2 }, ['バージョン管理']),
    el('p', { style: P }, [
      'install.html (ブックマークレット配布ページ) を新しいビルドで更新したあと、',
      CODE('歯車 → 設定 → バージョン管理'), ' で「現在のビルドを最新として登録」をクリック。',
      'これで古いブックマークを使っているユーザーに、起動時に更新案内バナーが出るようになります。',
    ]),

    el('h2', { style: H2 }, ['SP リストのリセット']),
    el('div', { style: HINT + ';border-left-color:#dc2626;background:rgba(239,68,68,0.05)' }, [
      el('strong', { style: 'color:#dc2626' }, ['⚠ 警告: ']),
      'Tickets / Comments / InboxMails / TeamsPostRequests を削除して再作成します。',
      'すべての起票履歴が消えます。本番では絶対に押さないでください。',
      '開発・検証環境のクリーンアップ用です。',
    ]),
  ]);
}

function renderPaFlows(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['Power Automate フロー作成手順']),
    el('p', { style: P }, [
      'メール / Forms / Teams からの自動取込と Teams スレッド投稿を担当する 4 つのフローを作成します。',
      'すべて Power Automate ', el('strong', {}, ['Standard tier']),
      ' (Premium / Graph API 不要) で動きます。',
    ]),

    el('div', { style: HINT }, [
      '★ 詳細な手順 (パラメータ・式・トラブルシューティング) は ',
      el('strong', {}, ['歯車 → ヘルプ (PA フロー作成手順)']),
      ' で開けるモーダルにまとめています。',
      'スクショ付きの完全版はそちらで確認してください。',
    ]),

    el('h2', { style: H2 }, ['フロー一覧']),
    el('table', {
      style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)',
    }, [
      el('tr', {}, [
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2);width:130px' }, ['フロー']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2);width:80px' }, ['必須/任意']),
        el('th', { style: 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--paper-2)' }, ['処理']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['① メール'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['必須']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [
          '個人メールボックスへの新着メールのうち、To/Cc に特定の ML を含むものだけ → InboxMails に行追加',
        ]),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['② Teams 投稿'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['任意']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['TeamsPostRequests に新規行 → Teams チャネルに親メッセージ投稿']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, [el('strong', {}, ['③ Forms'])]),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['任意']),
        el('td', { style: 'padding:6px 8px;border-bottom:1px solid var(--line)' }, ['Forms 応答 → InboxMails (ConversationId=forms-...)']),
      ]),
      el('tr', {}, [
        el('td', { style: 'padding:6px 8px' }, [el('strong', {}, ['④ Teams 返信'])]),
        el('td', { style: 'padding:6px 8px' }, ['任意']),
        el('td', { style: 'padding:6px 8px' }, ['監視チャネルへの返信 → InboxMails (ConversationId=teams-...) → Spira が自動紐付け']),
      ]),
    ]),

    el('h2', { style: H2 }, ['前提環境']),
    el('ul', { style: UL }, [
      el('li', {}, ['Microsoft 365 環境 (SharePoint Online / Teams / Outlook が同テナント)']),
      el('li', {}, ['Power Automate のアクセス権 (フロー作成可能なライセンス)']),
      el('li', {}, ['担当者個人の Outlook メールボックス (PA フロー① 用)。問い合わせ対応の ML を To/Cc 受信できる設定であること']),
      el('li', {}, ['Microsoft Forms (PA フロー③ 用、任意)']),
      el('li', {}, ['Spira 専用 Teams チャネル (PA フロー②④ 用、任意)']),
    ]),
  ]);
}

function renderTroubleshooting(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['トラブルシューティング']),

    el('h2', { style: H2 }, ['受信一覧が更新されない']),
    el('ul', { style: UL }, [
      el('li', {}, ['右上 🔄 同期ボタンを押す']),
      el('li', {}, [CODE('歯車 → 設定 → 受信同期 — 自動更新間隔'), ' で 60 秒等が設定されているか確認']),
      el('li', {}, ['PA フローの実行履歴で「成功」になっているか確認']),
    ]),

    el('h2', { style: H2 }, ['受信メールがチケットに紐付かない']),
    el('ul', { style: UL }, [
      el('li', {}, ['件名に ', CODE('#ABC-0001'), ' のようなチケット ID タグが含まれているか']),
      el('li', {}, ['ID 形式設定が PA フロー側と一致しているか']),
      el('li', {}, ['受信一覧で「既存に紐付け」で手動紐付け可能']),
    ]),

    el('h2', { style: H2 }, ['Teams 返信が反映されない']),
    el('ul', { style: UL }, [
      el('li', {}, ['チケット側に InternalThreadId / UserThreadId が保存されているか SP の Tickets リストで確認']),
      el('li', {}, ['受信一覧に「💬 Teams」バッジ付きで残っていれば、紐付け先が見つからなかった状態。手動紐付け可']),
      el('li', {}, ['PA フロー④の実行履歴で GetMessage アクションの ', CODE("body('GetMessage')?['replyToId']"), ' に値があるか確認']),
    ]),

    el('h2', { style: H2 }, ['ブックマークレットがドラッグできない (Windows)']),
    el('ul', { style: UL }, [
      el('li', {}, ['一度ブラウザを再起動 (OS のドラッグ状態が固まっていることがある)']),
      el('li', {}, ['install.html の最新版を取得 (古いビルドだと未圧縮で動かない場合あり)']),
    ]),

    el('h2', { style: H2 }, ['チケット詳細で AI ペインが空]']),
    el('ul', { style: UL }, [
      el('li', {}, [CODE('歯車 → 設定 → AI 設定'), ' で API キーとモデルが設定されているか確認']),
      el('li', {}, ['ブラウザのコンソール (F12) で 401 / 403 エラーが出ていないか']),
      el('li', {}, ['社内 AI なら Base URL がプロキシ経由になっているか']),
    ]),

    el('h2', { style: H2 }, ['その他]']),
    el('p', { style: P }, [
      el('strong', {}, ['ビルド ID を確認: ']),
      '歯車 → 「build: xxx」をクリックでコピー。バグ報告時に添付してください。',
    ]),
  ]);
}

function renderFaq(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['FAQ']),

    el('h3', { style: H3 }, ['Q. 専用サーバは要りますか?']),
    el('p', { style: P }, [
      'A. 不要です。SharePoint Online + Power Automate Standard tier だけで動きます。',
    ]),

    el('h3', { style: H3 }, ['Q. 月額費用は?']),
    el('p', { style: P }, [
      'A. Spira 本体は ¥0 (既存の Microsoft 365 ライセンス枠内)。',
      el('strong', {}, ['AI チャットは社内 AI ゲートウェイ経由でもモデル毎の従量課金']),
      ' (使用したトークン数で計上) があります。',
      'コストを抑えたい場合は安価なモデル (例: GPT-4.1 mini 系) を選択するか、AI 機能を使用しない運用にしてください。',
    ]),

    el('h3', { style: H3 }, ['Q. 何人まで使えますか?']),
    el('p', { style: P }, [
      'A. SharePoint の「リスト 5000 件しきい値」の範囲。チケット 5000 件、コメント 5000 件 (1 チケットあたり) までは安全。',
      'それ以上はリストビューしきい値の引き上げ + Spira 側で $top 拡張が必要。',
    ]),

    el('h3', { style: H3 }, ['Q. 既存のチケットを CSV で取り出せますか?']),
    el('p', { style: P }, [
      'A. はい。チケット一覧上部の「CSV」ボタンで現在のフィルタ条件の全件、',
      'チェックボックスで選択中なら「選択分 CSV」で選択分のみエクスポート可。',
    ]),

    el('h3', { style: H3 }, ['Q. データを完全に削除したいのですが?']),
    el('p', { style: P }, [
      'A. ',
      CODE('歯車 → 設定 → SP リストをリセット'),
      ' で全データを物理削除できます (元に戻せません)。',
      '個別チケットの削除は一覧でゴミ箱送り → ゴミ箱で完全削除。',
    ]),

    el('h3', { style: H3 }, ['Q. 内部スレッド/外部スレッドの判定はあとから変更できますか?']),
    el('p', { style: P }, [
      'A. 現状は新規作成時のみ。既存コメントの threadKind は SharePoint の Comments リストを直接編集する形で対応可能。',
    ]),

    el('h3', { style: H3 }, ['Q. AI に送信されるデータの範囲は?']),
    el('p', { style: P }, [
      'A. AI チャットを開いた瞬間に、該当チケットの ', el('strong', {}, ['件名・本文・履歴 (受信スレッド + 内部メモ)']),
      ' が社内 AI ゲートウェイに送信されます。他のチケット情報や全社データは送信しません。',
    ]),

    el('h3', { style: H3 }, ['Q. install.html を開いた状態でブックマークをクリックしたら警告が出ました']),
    el('p', { style: P }, [
      'A. Spira は SharePoint サイト上でのみ動作します。SharePoint サイト (',
      CODE('https://<tenant>.sharepoint.com/sites/<site>'),
      ') を開いた状態でブックマークをクリックしてください。',
    ]),

    el('h3', { style: H3 }, ['Q. 「管理外」と「削除」の使い分けは?']),
    el('p', { style: P }, [
      'A. ', el('strong', {}, ['管理外']), ' は IsHidden=true で論理削除 + ExclusionReason に理由メモ。',
      '「管理外も表示」トグルで後から確認・「再対象化」で復元可能。スパム/テスト/別件対応中 等の通常運用はこちら。',
      el('br'),
      el('strong', {}, ['🗑 削除']),
      ' は SP リストから物理削除 (元に戻せない)。完全に不要な行のみに使用。',
    ]),

    el('h3', { style: H3 }, ['Q. ステータスや影響度の選択肢を増やしたい']),
    el('p', { style: P }, [
      'A. ',
      CODE('歯車 → 設定 → ステータスの選択肢 / 影響度の選択肢'),
      ' で追加・名称変更・削除可能。名称変更/削除は既存チケットも一括更新されます。',
      el('br'),
      '※ Choice 列なので、新規追加した値は ', el('strong', {}, ['SP リスト側 Choice 列にも同名値を手動追加']),
      ' する必要があります。',
    ]),

    el('h3', { style: H3 }, ['Q. タグは誰でも自由に作れますか?']),
    el('p', { style: P }, [
      'A. いいえ、',
      el('strong', {}, ['admin が登録した辞書から選択する厳格方式']),
      ' です (表記揺れ防止)。新規タグの追加は ',
      CODE('歯車 → 設定 → タグ辞書'),
      ' で行います。',
    ]),

    el('h3', { style: H3 }, ['Q. メモに添付ファイルを入れられますか?']),
    el('p', { style: P }, [
      'A. はい、内部メモには ', el('strong', {}, ['ドラッグ&ドロップ / クリップボード貼付 / `/file` スラッシュコマンド']),
      ' で添付可能。画像はインライン、その他のファイルはアイコン付きリンクチップで表示されます。SP のドキュメントライブラリに保存されます。',
    ]),
  ]);
}

function renderGlossary(): HTMLElement {
  return el('div', {}, [
    el('h1', { style: H1 }, ['用語集']),

    el('dl', { style: 'font-size:var(--fs-sm);line-height:1.8' }, [
      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['チケット']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        '1 件の問い合わせや作業依頼の単位。件名・本文・ステータス・影響度・担当者などを持つ。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['履歴 / コメント']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'チケット内のスレッド要素。受信メール・Teams 返信・手書きメモ等が時系列で並ぶ。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['内部スレッド / 外部スレッド']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        '同一チケット内で、社内議論用と顧客向けを分離した 2 系統の履歴。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['チケット ID タグ']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        '件名に付与される識別子 (例: #ABC-0001)。メール返信時にこのタグを保ったまま返信すると、自動でチケット履歴に紐付く。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['受信箱 (Inbox)']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'PA から書き込まれた未処理のメール・Forms・Teams 返信が一時保管される領域。Spira 同期時に紐付け or 起票待ち。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['管理外 / 削除']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        '受信一覧の行アクション。管理外は IsHidden=true で論理削除 (理由メモ付き、復元可)、削除は SP リストから物理削除 (元に戻せない)。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['タグ (Tag)']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'チケット本体に複数付与可能な分類ラベル。色付きピル表示。admin が事前登録した辞書 (歯車 → 設定 → タグ辞書) から選択する厳格方式 (自由追加不可)。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['影響度 (旧 優先度)']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'チケットの重要度を示す軸 (既定: High / Medium / Low)。設定で選択肢を変更可能。内部の DB 列名は Priority のまま (互換性のため)。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['ワークスペース']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'Spira が現在接続中の SharePoint サイトの表示名。ヘッダ左の 📁 チップに表示、クリックで該当サイトを開く。複数サイトに Spira を入れているときの確認用。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['Power Automate (PA)']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'Microsoft 365 の自動化サービス。Spira では受信メール・Forms・Teams 返信の取込と Teams 投稿を担当。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['ブックマークレット']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        'ブラウザのブックマークに登録できる小さな JavaScript。Spira 本体はこの 1 ファイルで配布。',
      ]),

      el('dt', { style: 'font-weight:600;margin-top:var(--s-3)' }, ['監査ログ']),
      el('dd', { style: 'margin:0 0 var(--s-2) var(--s-4);color:var(--ink-2)' }, [
        '誰がいつ何を変更したかの操作履歴。SP の AuditLog リストに保存、既定 30 日保持。',
      ]),
    ]),
  ]);
}

// ─────────────────── ヘルプ View 本体 ───────────────────

const SECTIONS: Section[] = [
  { key: 'intro',           label: 'はじめに',                 render: renderIntro },
  { key: 'basics',          label: '基本操作',                 render: renderBasics },
  { key: 'threads',         label: '内部/外部スレッド',        render: renderThreads },
  { key: 'inbox',           label: '受信メール処理',           render: renderInbox },
  { key: 'ai',              label: 'AI チャット',              render: renderAi },
  { key: 'admin',           label: '管理者向け',               render: renderAdmin },
  { key: 'pa',              label: 'PA フロー作成',            render: renderPaFlows },
  { key: 'troubleshooting', label: 'トラブルシューティング',    render: renderTroubleshooting },
  { key: 'faq',             label: 'FAQ',                      render: renderFaq },
  { key: 'glossary',        label: '用語集',                   render: renderGlossary },
];

const ACTIVE_KEY_STORAGE = 'spira:help-active-section';

export function renderHelp(): HTMLElement {
  const getActive = (): Section => {
    let key = '';
    try { key = localStorage.getItem(ACTIVE_KEY_STORAGE) ?? ''; } catch { /* ignore */ }
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0]!;
  };
  let active = getActive();

  const detailPane = el('div', {
    style: 'flex:1;overflow-y:auto;padding:var(--s-6) var(--s-7);background:var(--paper);min-width:0',
  }, []);

  const sideNav = el('div', {
    style:
      'width:220px;flex-shrink:0;border-right:1px solid var(--line);' +
      'background:var(--paper-2);overflow-y:auto;padding:var(--s-3) 0',
  }, []);

  const renderDetail = (): void => {
    detailPane.replaceChildren(active.render());
    detailPane.scrollTop = 0;
  };
  const renderNav = (): void => {
    const children: HTMLElement[] = [
      el('div', {
        style: 'padding:0 var(--s-4) var(--s-3);font-size:var(--fs-md);font-weight:700;color:var(--ink)',
      }, ['📖 ヘルプ']),
    ];
    for (const s of SECTIONS) {
      const isActive = s.key === active.key;
      children.push(el('div', {
        style:
          `padding:8px 16px;cursor:pointer;font-size:var(--fs-sm);` +
          `color:${isActive ? 'var(--ink)' : 'var(--ink-2)'};` +
          `background:${isActive ? 'var(--accent-soft)' : 'transparent'};` +
          `border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
        onclick: () => {
          active = s;
          try { localStorage.setItem(ACTIVE_KEY_STORAGE, s.key); } catch { /* ignore */ }
          renderNav();
          renderDetail();
        },
      }, [s.label]));
    }
    sideNav.replaceChildren(...children);
  };
  renderNav();
  renderDetail();

  return el('div', {
    class: 'spira-content',
    style: 'display:flex;flex:1;min-height:0;overflow:hidden',
  }, [sideNav, detailPane]);
}

// 「ヘルプ」サイドバー項目クリック用のヘルパ。
export function navigateToHelp(): void {
  setState({ view: 'help', selectedTicketId: null });
  // help view は常に同じ画面なので state.view 変更で paintMain が再走するだけ。
  void getState; // keep import used in some builds
}
