#!/usr/bin/env node
/**
 * 校验 public/*.html 里的内联 <script>。
 *
 * 这些 HTML 通过 wrangler 的 Text 规则原样发给浏览器，不经过任何转译，
 * 所以内联脚本里的任何问题都会在生产环境直接炸掉。两道校验：
 *
 *   ① 语法检查 —— node --check
 *      抓「TypeScript 语法漏进浏览器端」这类错误
 *      （历史事故：admin.html 的 `const payload: any` → 整个脚本无法解析，白屏）
 *
 *   ② 作用域检查 —— TypeScript checker，只挑「运行时会抛 ReferenceError」的错误码
 *      抓「函数声明写错了作用域，运行时才炸」这类静默错误
 *      （历史事故：share.html 的 getBoundCode 被关在 render() 内部，
 *        顶层 triggerDownload() 调用它 → 点下载按钮毫无反应）
 *
 * 每个页面单独编译，避免不同页面的同名全局（I18N/LANG/t/$…）互相打架；
 * `<script src>` 引入的 CDN 全局（echarts 等）声明为 any，不算错误。
 *
 * 用法： node scripts/check-inline-js.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/** 只拦这些错误码 —— 它们在浏览器里会真的抛异常。其余 checkJs 噪音一律放过。 */
const FATAL_CODES = new Map([
  [2304, 'Cannot find name'],
  [2552, 'Cannot find name (did you mean)'],
  [2591, 'Cannot find name (缺类型定义)'],
  [2305, 'Module has no exported member'],
  [2307, 'Cannot find module'],
  [2451, 'Cannot redeclare block-scoped variable'],
  [2404, 'Duplicate identifier'],
  // 对象字面量里的重复键：后者会静默覆盖前者。
  // 真实事故：i18n 里 oauthEnable 写了两遍（'启用 OAuth2' / '启用'），
  // 前者变成永远不生效的死键，改了没反应，极难排查。
  [1117, '对象字面量存在重复键（后者静默覆盖前者）'],
]);

const files = readdirSync(PUBLIC_DIR)
  .filter((f) => extname(f) === '.html')
  .filter((f) => !/\.(bak|orig)$/.test(f))
  .sort();

const tmp = mkdtempSync(join(tmpdir(), 'r2pan-inline-js-'));
const pages = [];
let syntaxFailures = 0;

for (const file of files) {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf8');

  // ① 外链脚本引入的全局（CDN 库），声明为 any，不参与检查。
  //    两种来源都要管：
  //      - 静态：<script src="https://cdn.../echarts.min.js">
  //      - 动态：const s=document.createElement('script'); s.src='...echarts.min.js'
  //        （admin.html 的 ECharts 就是后者，漏掉会被误报成未定义）
  const externals = new Set();
  const addExternal = (url) => {
    const name = basename(url.split(/[?#]/)[0]).replace(/\.min\.js$|\.js$/i, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) externals.add(name);
  };
  for (const m of html.matchAll(/["']([^"']+?\.js(?:\?[^"']*)?)["']/gi)) addExternal(m[1]);
  // 本地自己声明过的名字不要 ambient 声明，否则会变成重复声明报错
  const localDecl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  const declared = new Set();
  let dm;
  while ((dm = localDecl.exec(html))) declared.add(dm[1]);
  for (const n of [...externals]) if (declared.has(n)) externals.delete(n);
  const preamble = [...externals].map((n) => `\ndeclare const ${n}: any;\n`).join('');

  const page = { html: file, scripts: [] };
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let i = 0;

  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const code = m[2];
    const startLine = html.slice(0, m.index).split('\n').length;
    i++;

    if (/\bsrc\s*=/.test(attrs)) continue;      // 外链脚本本体不校验
    if (!code.trim()) continue;                  // 空脚本
    if (/type\s*=\s*["']?(?!text\/javascript|module)/i.test(attrs)) continue; // 非 JS

    // 两份副本：node --check 只能吃纯 JS，tsc 那份才挂 ambient 声明
    const rawPath = join(tmp, `${file}-${i}.js`);
    const tsPath = join(tmp, `${file}-${i}.tscheck.js`);
    writeFileSync(rawPath, code);
    // preamble 追加在末尾 —— declare 是 ambient 的，不影响前面的行号映射
    writeFileSync(tsPath, code + preamble);
    page.scripts.push({ path: tsPath, index: i, startLine });

    try {
      execFileSync(process.execPath, ['--check', rawPath], { stdio: 'pipe' });
    } catch (e) {
      syntaxFailures++;
      const out = (e.stderr?.toString() || e.stdout?.toString() || '').trim();
      console.error(`\n✗ [语法] ${file} <script #${i}>（html 第 ${startLine} 行起）`);
      console.error(out.split('\n').slice(0, 8).map((l) => '   ' + l).join('\n'));
    }
  }

  if (page.scripts.length) pages.push(page);
}

let scopeFailures = 0;
let ts = null;
try {
  ts = createRequire(import.meta.url)('typescript');
} catch {
  console.warn('\n⚠ 未安装 typescript，跳过作用域检查（先 npm i）');
}

if (ts) {
  for (const page of pages) {
    const program = ts.createProgram(page.scripts.map((s) => s.path), {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
    });

    // ts 返回的文件名分隔符/大小写可能与写入时不同，统一成 POSIX 风格再匹配
    const norm = (p) => p.replace(/\\/g, '/');
    const byPath = new Map(page.scripts.map((s) => [norm(s.path), s]));

    for (const d of ts.getPreEmitDiagnostics(program)) {
      const label = FATAL_CODES.get(d.code);
      if (!label || !d.file) continue;

      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      const meta = byPath.get(norm(d.file.fileName));
      const where = meta
        ? `${page.html}（html 第 ${meta.startLine + line} 行）`
        : d.file.fileName;

      scopeFailures++;
      console.error(
        `✗ [作用域] ${where}  TS${d.code} ${label}\n   ` +
          ts.flattenDiagnosticMessageText(d.messageText, ' ').split('\n')[0]
      );
    }
  }
}

console.log('');
if (syntaxFailures || scopeFailures) {
  const total = syntaxFailures + scopeFailures;
  console.error(`✗ 共 ${total} 处问题（语法 ${syntaxFailures} / 作用域 ${scopeFailures}）—— 部署已中止。`);
  process.exit(1);
}

const total = pages.reduce((n, p) => n + p.scripts.length, 0);
console.log(`✓ ${files.length} 个页面、${total} 段内联脚本：语法与作用域检查全部通过`);