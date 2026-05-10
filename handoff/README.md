# Spira — 設計ドキュメント一式 (Claude Code 用)

このディレクトリは Spira (M365/SharePoint メール起票型チケット管理) の設計ハンドオフ資料です。
**そのまま Claude Code に渡して実装を依頼できます。**

---

## 含まれているもの

| ファイル | 役割 | 用途 |
|---|---|---|
| `README.md` | この入り口 | 最初に読む |
| `CLAUDE.md` | Claude Code への指示書 | プロジェクトルートに置くと自動で読まれる |
| `Spira Design Spec.md` | 設計スペック本体 | デザイントークン / コンポーネント / レイアウト / インタラクション / データモデル |
| `Spira Wireframes.html` | UI ワイヤフレーム (ブラウザで開ける) | 7 画面 × 2–3 バリエーションの低忠実度モック |
| `tokens.css` | CSS 変数スターター | そのまま `app.css` の冒頭に使える |

---

## Claude Code への渡し方 (推奨)

```bash
# 1. 解凍
unzip spira-handoff.zip
cd spira-handoff/

# 2. 実装プロジェクトを開く
cd /path/to/spira-impl
claude
```

Claude Code セッションで以下のように指示:

```
@spira-handoff/CLAUDE.md を読んで、@spira-handoff/Spira Design Spec.md と
@spira-handoff/Spira Wireframes.html に基づいて Spira の MVP を実装してください。
まず src/ ディレクトリの初期構造とトークン CSS から始めてください。
```

---

## 実装方針 (要約)

- **Vanilla TypeScript** (フレームワーク不要)
- ブックマークレットで `<body>` に注入される overlay
- すべてのクラスは `spira-` prefix
- n365 (Shapion) と同一トーン&マナー — moss green `#7a8a78` をアクセント
- light/dark 両対応
- フェーズ:
  1. **MVP** = Shell + 一覧 + 詳細 + Inbox + 3 modals (light のみ)
  2. **Phase 2** = dark / ⌘K / saved views
  3. **Phase 3** = kanban / template reply

---

## ワイヤフレームの見方

`Spira Wireframes.html` をブラウザで開くと:

- 上部タブで 7 画面を切替 (overview / shell / list / detail / inbox / modals / components / states)
- 各画面 2–3 案を並列に表示 — **採用案は Spec の §3 に記載**
- 右下「⚙ tweaks」で背景グリッド / borderスタイル / dark プレビュー / 密度切替

ワイヤフレームは構造とフローの確認用です。実装は Spec の値を正とすること。

---

## 不明点が出たら

`Spira Wireframes.html` の **overview タブ** にある **Open questions パネル** を確認。
未決事項は以下:

1. Ticket ID `#001` の表示位置
2. List デフォルトビュー (テーブル採用)
3. Inbox の出し方 (専用画面採用)
4. Status の段数 (4 段で確定)
5. 担当者 unset の表現
6. SP API 失敗のフィードバック方法
7. スレッド方向 (古→新で確定)
8. 期限超過の強調方法 (期限セルのみ採用)

**変更があれば Spec を最初に更新** してから実装に手を入れてください。
