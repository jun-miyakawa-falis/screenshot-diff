#!/usr/bin/env node
// prod と stg の同じパスのスクリーンショットを撮って差分を出すツール
//
// 設定は .env（PROD_URL, STG_URL, STG_USER, STG_PASS, WIDTH）と urls.txt（1行1パス）。
// スクリーンショットは常にページ全体を撮影する。
// コマンドライン引数で上書きもできる。詳しくは --help。

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { values: opts } = parseArgs({
  allowNegative: true,
  options: {
    prod: { type: 'string', default: process.env.PROD_URL },
    stg: { type: 'string', default: process.env.STG_URL },
    'stg-user': { type: 'string', default: process.env.STG_USER },
    'stg-pass': { type: 'string', default: process.env.STG_PASS },
    list: { type: 'string', default: 'urls.txt' },
    width: { type: 'string', default: process.env.WIDTH ?? '1280' },
    height: { type: 'string', default: '800' },
    threshold: { type: 'string', default: '0.1' },
    concurrency: { type: 'string', default: '4' },
    'idle-timeout': { type: 'string', default: '10' },
    block: { type: 'boolean', default: true },
    out: { type: 'string', default: 'out' },
    format: { type: 'string', default: 'avif' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const usage = `使い方:
  node diff.mjs [オプション]

  .env に PROD_URL, STG_URL, STG_USER, STG_PASS を書き、
  urls.txt に比較したいパスを1行ずつ書いて実行します。

オプション（.env の値より優先）:
  --prod <url>          prod のベースURL
  --stg <url>           stg のベースURL
  --stg-user <user>     stg のBasic認証ユーザー
  --stg-pass <pass>     stg のBasic認証パスワード
  --list <file>         URLリストのファイル (default: urls.txt)
  --width <px,...>      ブラウザ幅。カンマ区切りで複数指定可 例: 1280,375 (default: 1280)
  --height <px>         ブラウザ高さ。fixed 要素や100vh の表示に影響 (default: 800)
  --threshold <0-1>     ピクセル一致の許容度 (default: 0.1)
  --concurrency <n>     同時に処理するページ数 (default: 4)
  --idle-timeout <sec>  通信が落ち着くのを待つ最大秒数 (default: 10)
  --no-block            広告・計測タグの通信をブロックしない
  --out <dir>           出力先 (default: out)
  --format <avif|png>   画像の保存形式。avif は png の約1/5の容量 (default: avif)`;

if (opts.help) {
  console.log(usage);
  process.exit(0);
}
if (!opts.prod || !opts.stg) {
  console.error('prod/stg のURLが必要です。.env か --prod / --stg で指定してください。\n');
  console.error(usage);
  process.exit(2);
}
if (!fs.existsSync(opts.list)) {
  console.error(`URLリストファイルがありません: ${opts.list}`);
  if (opts.list === 'urls.txt') console.error('cp urls.txt.example urls.txt で作成してください。');
  process.exit(2);
}

// urls.txt は「/about」のようなパスでも「https://prod.example.com/about」のようなフルURLでもよい
function loadPaths(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      if (!/^https?:\/\//.test(l)) return l.startsWith('/') ? l : `/${l}`;
      const u = new URL(l);
      return u.pathname + u.search;
    });
}

const join = (base, p) => base.replace(/\/+$/, '') + p;
const slug = (p) => p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'index';

// 広告・計測タグは見た目に影響せず、通信が終わらないことがあるのでブロックする
const BLOCK_HOSTS = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'facebook.net',
  'facebook.com',
  'connect.facebook.net',
  'clarity.ms',
  'hotjar.com',
  'yahoo.co.jp/conversion',
  'yimg.jp/images/listing/tool/cv',
  'ads-twitter.com',
  'analytics.tiktok.com',
  'bat.bing.com',
  'criteo.com',
  'adnxs.com',
];

const isBlocked = (url) => BLOCK_HOSTS.some((h) => (url.host + url.pathname).includes(h));

const paths = loadPaths(opts.list);
if (!['avif', 'png'].includes(opts.format)) {
  console.error(`--format は avif か png: ${opts.format}`);
  process.exit(2);
}
const widths = [...new Set(String(opts.width).split(',').map((w) => Number(w.trim())))];
if (widths.some((w) => !Number.isInteger(w) || w <= 0)) {
  console.error(`--width / WIDTH の値が正しくありません: ${opts.width}`);
  process.exit(2);
}

// サイズが違う場合は大きい方に合わせて透明で埋める
function pad(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

function compare(bufA, bufB) {
  let a = PNG.sync.read(bufA);
  let b = PNG.sync.read(bufB);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  a = pad(a, width, height);
  b = pad(b, width, height);
  const diff = new PNG({ width, height });
  const count = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: Number(opts.threshold),
  });
  return { diff: PNG.sync.write(diff), count, total: width * height };
}

// 遅延読み込みの画像を読み込ませるため、一番下までスクロールしてから上に戻す
async function scrollThrough(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 100; i++) {
      y += window.innerHeight;
      window.scrollTo(0, y);
      await sleep(100);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

async function capture(context, url) {
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} ${url}`);
    // 通信が止まらないページもあるので、待ちきれなければそのまま撮る
    await page
      .waitForLoadState('networkidle', { timeout: Number(opts['idle-timeout']) * 1000 })
      .catch(() => {});
    await scrollThrough(page);
    return await page.screenshot({ fullPage: true, animations: 'disabled' });
  } finally {
    await page.close();
  }
}

const outDir = opts.out;
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const stgCredentials =
  opts['stg-user'] ? { username: opts['stg-user'], password: opts['stg-pass'] ?? '' } : undefined;

// 幅ごとに prod / stg のブラウザコンテキストを用意する
const contexts = new Map();
for (const width of widths) {
  const viewport = { width, height: Number(opts.height) };
  const prod = await browser.newContext({ viewport });
  const stg = await browser.newContext({ viewport, httpCredentials: stgCredentials });
  if (opts.block) {
    for (const ctx of [prod, stg]) await ctx.route(isBlocked, (route) => route.abort());
  }
  contexts.set(width, { prod, stg });
}

const results = paths.map((p, i) => ({
  path: p,
  name: `${String(i + 1).padStart(3, '0')}_${slug(p)}`,
  prodUrl: join(opts.prod, p),
  stgUrl: join(opts.stg, p),
  shots: [],
}));
const total = paths.length * widths.length;
let done = 0;

// 差分は劣化のない PNG のまま計算し、保存するときだけ AVIF に変換する
async function save(pngBuf, base) {
  if (opts.format === 'png') return fs.promises.writeFile(`${base}.png`, pngBuf);
  await sharp(pngBuf).avif({ quality: 60, effort: 2 }).toFile(`${base}.avif`);
}

async function processShot(result, width) {
  const dir = path.join(outDir, result.name, String(width));
  const shot = { width, dir: `${result.name}/${width}` };
  const { prod, stg } = contexts.get(width);
  try {
    const tag = (label) => (e) => {
      throw new Error(`[${label}] ${e.message}`);
    };
    const [bufA, bufB] = await Promise.all([
      capture(prod, result.prodUrl).catch(tag('prod')),
      capture(stg, result.stgUrl).catch(tag('stg')),
    ]);
    const { diff, count, total } = compare(bufA, bufB);
    fs.mkdirSync(dir, { recursive: true });
    await Promise.all([
      save(bufA, path.join(dir, 'prod')),
      save(bufB, path.join(dir, 'stg')),
      save(diff, path.join(dir, 'diff')),
    ]);
    shot.count = count;
    shot.rate = (count / total) * 100;
  } catch (e) {
    shot.error = e.message.split('\n')[0];
  }
  result.shots.push(shot);
  result.shots.sort((a, b) => widths.indexOf(a.width) - widths.indexOf(b.width));
  done++;
  const status = shot.error ? `ERROR ${shot.error}` : `${shot.rate.toFixed(2)}%`;
  console.log(`[${done}/${total}] ${result.path} @${width}px  ${status}`);
}

// 同時実行数を制限しながら「ページ × 幅」を処理する
const queue = results.flatMap((r) => widths.map((w) => [r, w]));
await Promise.all(
  Array.from({ length: Math.max(1, Number(opts.concurrency)) }, async () => {
    while (queue.length) await processShot(...queue.shift());
  }),
);
await browser.close();

for (const r of results) {
  r.error = r.shots.some((s) => s.error);
  r.changed = r.shots.some((s) => s.count > 0);
}
writeReport(results);

const changed = results.filter((r) => r.changed);
const errors = results.filter((r) => r.error);
console.log(
  `\n完了: ${results.length}ページ × ${widths.length}幅 / 差分あり ${changed.length}ページ / エラー ${errors.length}ページ`,
);
console.log(`レポート: ${path.join(outDir, 'index.html')}`);
process.exit(changed.length || errors.length ? 1 : 0);

function writeReport(results) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const shotHtml = (r, s) => {
    const status = s.error
      ? `<span class="err">ERROR</span><div class="msg">${esc(s.error)}</div>`
      : `<span class="${s.count ? 'ng' : 'ok'}">${s.rate.toFixed(2)}%</span>`;
    const imgs = s.error
      ? ''
      : ['prod', 'stg', 'diff']
          .map((k) => {
            // サムネイル自体はリンクにせず、下にページと画像へのリンクを並べる（diff は実ページがない）
            const img = `${s.dir}/${k}.${opts.format}`;
            const page = { prod: r.prodUrl, stg: r.stgUrl }[k];
            const links = [
              page && `<a href="${esc(page)}" target="_blank">ページ</a>`,
              `<a href="${img}" target="_blank">画像</a>`,
            ].filter(Boolean);
            return `<figure><img loading="lazy" src="${img}">
      <figcaption>${k} · ${links.join(' · ')}</figcaption></figure>`;
          })
          .join('');
    return `<div class="shot ${s.error ? 'is-err' : s.count ? 'is-ng' : 'is-ok'}">
    <div class="w"><b>${s.width}px</b>${status}</div><div class="imgs">${imgs}</div></div>`;
  };
  // urls.txt の順に並べる
  const rows = results
    .map(
      (r) => `<tr class="${r.error ? 'is-err' : r.changed ? 'is-ng' : 'is-ok'}">
  <td><div class="path">${esc(r.path)}</div>
    <a href="${esc(r.prodUrl)}" target="_blank">prod</a> · <a href="${esc(r.stgUrl)}" target="_blank">stg</a></td>
  <td>${r.shots.map((s) => shotHtml(r, s)).join('')}</td></tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshot Diff</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; color: #222; background: #fafafa; }
  h1 { font-size: 20px; }
  .summary { margin-bottom: 12px; }
  label { margin-right: 12px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  td { border-bottom: 1px solid #ddd; padding: 8px; vertical-align: top; }
  .path { font-family: ui-monospace, monospace; font-weight: 600; word-break: break-all; }
  .ok { color: #1a7f37; font-weight: 600; } .ng { color: #cf222e; font-weight: 600; }
  .err { color: #fff; background: #cf222e; padding: 2px 6px; border-radius: 4px; }
  .msg { font-size: 12px; color: #666; max-width: 220px; word-break: break-all; }
  .shot { display: flex; gap: 12px; padding: 6px 0; }
  .shot + .shot { border-top: 1px dashed #e5e5e5; }
  .w { width: 110px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
  .imgs { display: flex; gap: 8px; }
  .imgs figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
  .imgs figcaption { font-size: 12px; color: #555; margin-top: 2px; }
  .imgs img { display: block; width: 240px; max-height: 180px; object-fit: cover; object-position: top; border: 1px solid #ccc; }
  body.hide-ok tr.is-ok, body.hide-ok .shot.is-ok { display: none; }
</style></head>
<body>
<h1>Screenshot Diff</h1>
<div class="summary">
  prod: ${esc(opts.prod)} / stg: ${esc(opts.stg)} / 幅 ${widths.join(', ')}px<br>
  ${results.length}ページ ・ 差分あり <b>${results.filter((r) => r.changed).length}</b> ・
  エラー <b>${results.filter((r) => r.error).length}</b> ・ ${new Date().toLocaleString('ja-JP')}
</div>
<label><input type="checkbox" onchange="document.body.classList.toggle('hide-ok', this.checked)"> 差分なしを隠す</label>
<table>${rows}</table>
</body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
}
