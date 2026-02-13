# minits — 引き継ぎドキュメント

## プロジェクト概要
- **名前**: minits（議事録ジェネレーター）
- **パス**: `d:\Desktop\Claude\minits`
- **目的**: 社内チーム（5〜20人）がブラウザ上で会議を録音 → 自動で構造化された議事録を生成
- **デプロイ先**: Netlify（未デプロイ）

## アーキテクチャ

```
ブラウザ
  getDisplayMedia (システム音声) ─┐
  getUserMedia (マイク)          ─┤─ Web Audio API でミックス
                                  ↓
                          MediaRecorder (webm/opus)
                                  ↓ 停止後
                    decodeAudioData → resample 16kHz mono
                          → 2分チャンク分割 → WAV encode
                                  ↓ 各チャンク
                    POST /api/transcribe → Netlify Function → OpenAI Whisper
                                  ↓ 全文テキスト結合
                    POST /api/generate-minutes → Netlify Function → Gemini 2.5 Flash
                                  ↓
                          構造化された議事録JSON表示
```

## ファイル構成

```
minits/
├── index.html                          # 録音UI + プログレス + 結果表示
├── script.js                           # 録音・音声処理・API呼出・UI (~420行)
├── style.css                           # Apple風デザイン (~360行)
├── netlify/
│   └── functions/
│       ├── transcribe.mjs              # OpenAI Whisper プロキシ (FormData → Whisper API)
│       └── generate-minutes.mjs        # Gemini プロキシ (transcript → 構造化JSON)
├── netlify.toml                        # build: npm install, functions: esbuild
├── package.json                        # deps: openai, @google/genai
├── .env.example                        # OPENAI_API_KEY, GEMINI_API_KEY 等
├── .gitignore                          # node_modules, .netlify, .env
└── HANDOFF.md                          # このファイル
```

## Git 状態

```
master ブランチ, 2コミット, working tree clean, リモート未設定
acc2b09 feat: 議事録ジェネレーター Web アプリ初期実装
0c5cf19 feat: ファイルアップロードからライブ録音に切り替え
```

## 残タスク

1. **GitHub リポジトリ作成 → push**
   - `gh` CLI 未インストール。手動で https://github.com/new から作成
   - `git remote add origin <url> && git push -u origin master`

2. **Netlify 接続**
   - Netlify ダッシュボードで GitHub リポジトリをリンク

3. **環境変数設定** (Netlify Site settings > Environment variables)
   - `OPENAI_API_KEY` — Whisper 文字起こし用
   - `GEMINI_API_KEY` — Gemini 議事録生成用
   - (任意) `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `GEMINI_MODEL`

4. **動作テスト**
   - 録音開始 → タブ共有(音声あり) + マイク許可 → 録音停止 → 文字起こし → 議事録生成

## 技術メモ

- **ブラウザ対応**: Chrome 94+ / Edge 94+ 推奨。Firefox/Safari は getDisplayMedia audio に制限あり
- **Netlify Functions タイムアウト**: Free=10秒, Pro=26秒。チャンク単位(2分音声)なら通常5〜15秒
- **チャンクサイズ**: 2min × 16kHz × 2byte ≈ 3.84MB/chunk（Netlify 6MB制限、Whisper 25MB制限に収まる）
- **MediaRecorder timeslice=1000**: 1秒ごとにデータ保存、クラッシュ時のデータロス最小化
- **node_modules 未インストール**: Netlify ビルド時に `npm install` が走る
