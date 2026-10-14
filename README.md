# screenshot-diff

prod と stg の同じページを Playwright で撮影し、見た目の差分を画像と差分率で一覧できるツールです。
複数ページをまとめて比較し、結果を HTML レポートで確認できます。

## 必要なもの

- Node.js 22.4 以上

## セットアップ

```bash
npm install
npx playwright install chromium
cp .env.example .env
cp urls.txt.example urls.txt
```

### .env

| 変数 | 内容 | 例 |
|---|---|---|
| `PROD_URL` | prod のベースURL | `https://www.example.com` |
| `STG_URL` | stg のベースURL | `https://stg.example.com` |
| `STG_USER` | stg の Basic 認証ユーザー（不要なら空） | |
| `STG_PASS` | stg の Basic 認証パスワード（不要なら空） | |
| `WIDTH` | ブラウザ幅（px）。カンマ区切りで複数指定可。省略時 1280 | `1280,375` |

`.env` と `urls.txt` は git 管理外です。認証情報をコミットしないよう注意してください。

### urls.txt

比較したいページを1行に1つ書きます。書き方は `urls.txt.example` を参考にしてください。

```
# # で始まる行は無視されます
/
/about/
/about/message/
# フルURLでもOK（パス部分だけ使われます）
https://www.example.com/news/?id=1
```

各行のパスを `PROD_URL` と `STG_URL` につなげて、同じパス同士を比較します。

## 使い方

```bash
npm run diff
```

終了すると `out/index.html` にレポートが作られます。ブラウザで開いて確認してください。

コマンドラインのオプションは `.env` より優先されます。

```bash
npm run diff -- --width 1280,375 --list urls-top.txt --out out-top
```

### オプション

| オプション | 内容 | 初期値 |
|---|---|---|
| `--prod <url>` | prod のベースURL | `PROD_URL` |
| `--stg <url>` | stg のベースURL | `STG_URL` |
| `--stg-user <user>` | stg の Basic 認証ユーザー | `STG_USER` |
| `--stg-pass <pass>` | stg の Basic 認証パスワード | `STG_PASS` |
| `--list <file>` | URL リストのファイル | `urls.txt` |
| `--width <px,...>` | ブラウザ幅。カンマ区切りで複数指定可 | `WIDTH` または 1280 |
| `--height <px>` | ブラウザ高さ。fixed 要素や 100vh の表示に影響 | 800 |
| `--threshold <0-1>` | 色の違いをどこまで同じとみなすか。大きいほど甘い | 0.1 |
| `--concurrency <n>` | 同時に撮影する数 | 4 |
| `--idle-timeout <sec>` | 通信が落ち着くのを待つ最大秒数 | 10 |
| `--no-block` | 広告・計測タグの通信をブロックしない | （ブロックする） |
| `--out <dir>` | 出力先。実行のたびに中身を削除して作り直す | `out` |
| `--format <avif\|png>` | 画像の保存形式 | `avif` |
| `-h`, `--help` | ヘルプを表示 | |

## レポートの見方

- 1ページ1行で、幅ごとに差分率と prod / stg / diff のサムネイルを表示します。
- ページは `urls.txt` に書いた順に並びます。
- 「差分なしを隠す」で、差分のない幅・ページを非表示にできます。
- サムネイルの下の「ページ」で実際のページ、「画像」でスクリーンショットを開きます。
- diff 画像では、違うピクセルが赤や黄色で表示されます。

### 出力ファイル

```
out/
├── index.html              レポート
├── 001_about/
│   ├── 1280/
│   │   ├── prod.avif
│   │   ├── stg.avif
│   │   └── diff.avif
│   └── 375/
│       └── ...
└── 002_about_message/
    └── ...
```

### 終了コード

| コード | 意味 |
|---|---|
| 0 | すべてのページで差分なし |
| 1 | 差分またはエラーがあった |
| 2 | 設定の誤り（URL 未設定、幅や形式の値が不正など） |

CI で使う場合は、この終了コードで成否を判定できます。

## 撮影の仕組み

1. ページを開き、`load` を待つ
2. 通信が落ち着くまで最大 `--idle-timeout` 秒待つ（待ちきれなくても撮影に進む）
3. 遅延読み込みの画像を読み込ませるため、一番下までスクロールしてから上に戻す
4. ページ全体（フルページ）を撮影する
5. prod と stg の画像を [pixelmatch](https://github.com/mapbox/pixelmatch) で比較する
6. 保存時に AVIF（画質60）に変換する

補足:

- 差分は撮影直後の劣化のない画像で計算し、AVIF にするのは保存のときだけです。圧縮による劣化は差分率に影響しません。
- prod と stg でページの高さが違う場合は、短い方の下に余白を足してから比較します。
- HTTP 400 以上が返ったページはエラーとして扱い、残りのページは続けて処理します。エラーには `[prod]` / `[stg]` のどちらで起きたかが表示されます。
- 広告・計測タグ（Google Ads、Google Analytics、Meta、Clarity など）は、通信が終わらず待ち時間が延びる原因になるため、初期設定でブロックしています。

## 注意点

- 上の方の内容の高さが違うと、その下がすべてずれるため差分率が大きく出ます。
- カルーセルなど読み込み中に動く要素があるページは、同じ内容でも実行ごとに差分率が少し変わることがあります。
- AVIF は macOS のプレビューで開けない場合があります。レポート（ブラウザ）での確認を想定しています。画像を他で使う場合は `--format png` を指定してください。
