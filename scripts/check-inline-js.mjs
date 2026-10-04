#!/usr/bin/env node
/**
 * 把 public/*.html 里的内联 <script> 抠出来，用 node --check 校验。
 * 目的：抓出「TypeScript 语法漏进浏览器端 HTML」这类只在部署后才炸的错误。
 *
 * 用法： node scripts/check-inline-js.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const files = readdirSync(PUBLIC_DIR)
  .filter((f) => extname(f) === '.html')
  .filter((f) => !/\.(bak|orig)$/.test(f));

const tmp = mkdtempSync(join(tmpdir(), 'inline-js-'));
let failed = 0;

for (const file of files) {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const code = m[2];
    const line = html.slice(0, m.index).split('\n').length;
    i++;

    if (/\bsrc\s*=/.test(attrs)) continue; // 外链脚本不校验
    if (!code.trim()) continue;
    // 非 JS 的 <script type="application/json"> 之类跳过
    if (/type\s*=\s*["']?(?!text\/javascript|module)/i.test(attrs)) continue;

    const file2 = join(tmp, `${file}-${i}.js`);
    writeFileSync(file2, code);
    try {
      execFileSync(process.execPath, ['--check', file2], { stdio: 'pipe' });
    } catch (e) {
      failed++;
      const out = (e.stderr?.toString() || e.stdout?.toString() || '').trim();
      console.error(`\n✗ ${file} <script #${i}> (html 第 ${line} 行起)`);
      console.error(out.split('\n').slice(0, 8).map((l) => '   ' + l).join('\n'));
    }
  }
}

if (failed) {
  console.error(`\n共 ${failed} 个内联脚本存在语法错误 —— 这些在浏览器里会直接白屏/卡转圈。`);
  process.exit(1);
}
console.log(`✓ ${files.length} 个 HTML 的内联脚本全部通过语法检查`);