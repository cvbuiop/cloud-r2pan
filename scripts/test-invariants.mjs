#!/usr/bin/env node
/**
 * 不变量测试 —— 锁住几个「靠人读代码发现不了、改错了又没任何报错」的不变量。
 *
 * 覆盖的每一项都对应过一次真实事故：
 *   ① 下载配额必须在所有门禁之后才扣（否则失败请求会烧光配额 = 配额 DOS）
 *   ② 下载令牌的 HMAC 语义：:ts 变体不能冒充、ts 令牌仍能过密码校验
 *   ③ 国家表完整性：无重复键、文莱用BN 而不是 BD、所有国家都有坐标
 *
 * 用法： node scripts/test-invariants.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 取函数体的源码区间（按大括号配平） */
function bodyOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// ① 配额扣减必须在所有门禁之后
// ══════════════════════════════════════════════════════════
console.log('\n① 下载配额扣减顺序');

const pub = readFileSync(join(ROOT, 'src', 'public.ts'), 'utf8');

const share = bodyOf(pub, 'export async function handleDownload');
const direct = bodyOf(pub, 'export async function handleDirectDownload');

check('能定位 handleDownload', !!share);
check('能定位 handleDirectDownload', !!direct);

if (share) {
  const bump = share.indexOf('UPDATE shares SET download_count');
  const gates = {
    '密码校验': share.indexOf('verifyShareToken'),
    'OAuth 校验': share.indexOf('verifyOAuthSession'),
    'Turnstile 校验': share.indexOf('hasTurnstileTicket'),
    '流量限额': share.indexOf('trafficLimitBytes > 0'),
    '重复下载拦截': share.indexOf('重复下载被拦截'),
  };
  check('handleDownload 里有配额扣减', bump > 0);
  for (const [name, pos] of Object.entries(gates)) {
    check(
      `分享链接：配额扣减在「${name}」之后`,
      pos > 0 && bump > pos,
      `扣减位置 ${bump}，${name} 位置 ${pos}`
    );
  }
  check(
    '分享链接：配额扣减紧邻 streamFile 之前（数据真正流出前）',
    share.indexOf('streamFile') > bump
  );
}

if (direct) {
  const bump = direct.indexOf('UPDATE direct_links SET download_count');
  check('handleDirectDownload 里有配额扣减', bump > 0);
  for (const [name, needle] of Object.entries({
    '流量限额': 'trafficLimitBytes > 0',
    '重复下载拦截': '重复下载被拦截',
  })) {
    const pos = direct.indexOf(needle);
    check(`直链：配额扣减在「${name}」之后`, pos > 0 && bump > pos, `扣减 ${bump}，${name} ${pos}`);
  }
  check('直链：配额扣减在 streamFile 之前', direct.indexOf('streamFile') > bump);
}

// ══════════════════════════════════════════════════════════
// ② 下载令牌 HMAC 语义
// ══════════════════════════════════════════════════════════
console.log('\n② 下载令牌 HMAC 语义');

const SECRET = 'unit-test-secret';
const hmac = (m) => createHmac('sha256', SECRET).update(m).digest('hex');
const mk = (exp, ts) => `${exp}.${hmac(`TOKEN:${exp}${ts ? ':ts' : ''}`)}`;
const verify = (ticket, mode) => {
  const i = ticket.indexOf('.');
  if (i < 0) return false;
  const exp = Number(ticket.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const sig = ticket.slice(i + 1);
  if (mode === 'any' && sig === hmac(`TOKEN:${exp}`)) return true;
  return sig === hmac(`TOKEN:${exp}:ts`);
};

const future = Date.now() + 86_400_000;
const past = Date.now() - 1000;

check('普通令牌能过密码校验', verify(mk(future, false), 'any') === true);
check('普通令牌不能冒充已过验证码', verify(mk(future, false), 'ts') === false);
check('ts 令牌能过密码校验', verify(mk(future, true), 'any') === true);
check('ts 令牌能过已过验证码判定', verify(mk(future, true), 'ts') === true);
check('伪造签名被拒', verify(`${future}.${'f'.repeat(64)}`, 'any') === false);
check('过期令牌被拒（已过验证码判定）', verify(mk(past, true), 'ts') === false);
check('畸形令牌被拒', verify('not-a-ticket', 'any') === false);

// 源码里 must真的用了 ":ts" 后缀，否则测试和实现会脱节
check('issueToken 源码包含 :ts 后缀签名', /turnstileVerified \? ":ts" : ""/.test(pub));
check('verifyTicket 的 any 模式同时接受两种签名', /mode === "any"/.test(pub));

// ══════════════════════════════════════════════════════════
// ③ Turnstile token 一次性消费
// ══════════════════════════════════════════════════════════
console.log('\n③ Turnstile token 一次性消费');

const shareHtml = readFileSync(join(ROOT, 'public', 'share.html'), 'utf8');
const consumes = shareHtml.match(/window\.__tsToken = null;/g) || [];
check(
  'share.html 在消费 token 后清空 window.__tsToken',
  consumes.length >= 3,
  `找到 ${consumes.length} 处（triggerDownload + wireUnlock 两条路径共 3 个跳转点）`
);

// ══════════════════════════════════════════════════════════
// ④ 国家表数据完整性
// ══════════════════════════════════════════════════════════
console.log('\n④ 国家表数据完整性');

const adminHtml = readFileSync(join(ROOT, 'public', 'admin.html'), 'utf8');

// 从源码里粗提取两张表的键（够用，且不依赖 AST）
const namesBlock = adminHtml.slice(adminHtml.indexOf('const COUNTRY_NAMES'), adminHtml.indexOf('function countryName'));
const geoBlock = adminHtml.slice(adminHtml.indexOf('approxGeo'), adminHtml.indexOf('approxGeo') + 4000);

// 注意：matchEach 的返回值是 [完整匹配, 组1, 组2, ...]，必须取 m[1]/m[2]
const codes = [...namesBlock.matchAll(/'([A-Z]{2})':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
const geoCodes = new Set([...geoBlock.matchAll(/'([A-Z]{2})':\s*\[\s*-?\d+/g)].map((m) => m[1]));

// 重复键：同一个国家代码出现两次
const seen = new Map();
const dup = [];
for (const [code, name] of codes) {
  if (seen.has(code)) dup.push(`${code} ('${seen.get(code)}' 被 '${name}' 覆盖)`);
  else seen.set(code, name);
}
check('国家表无重复键', dup.length === 0, dup.join('; '));

check("文莱用 BN（不是 BD）", seen.get('BN') === '文莱', `BN = ${seen.get('BN')}`);
check('孟加拉国仍是 BD', seen.get('BD') === '孟加拉国', `BD = ${seen.get('BD')}`);

const missingGeo = [...seen.keys()].filter((c) => !geoCodes.has(c));
check(
  '所有国家都有近似坐标（否则会被画到 [0,0]）',
  missingGeo.length === 0,
  missingGeo.join(', ')
);

// ══════════════════════════════════════════════════════════
// ⑤ i18n key 完整性：t('x') 用到的 key 必须在 zh / en 两边都存在
//    （事故：表头写t('codesColActions')，但两边都没这个 key，
//      页面上直接把原始 key 字符串渲染出来了，不报任何错）
// ══════════════════════════════════════════════════════════
console.log('\n⑤ i18n key 完整性');

/** 从 "const I18N = {" 里切出 zh: {...} / en: {...} 两个字典块。
 *  必须按行首锚定：用 indexOf('en:') 会误命中 token: / when: 这类 key 里的子串。 */
function dictBlock(src, name) {
  const m = new RegExp(`\\n\\s{2}${name}:\\s*\\{`).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  // 字典值里的占位符（'{n}' / '{site}'）自身也是配平的，所以花括号计数仍然正确
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

/** 收集一个字典块里的 key。
 *  注意：不能只匹配“独占一行的 key:”—— 字典里大量条目是挤在同一行的
 *  （login: '…', logout: '…', cancel: '…'），那样会漏掉一大半。
 *  先抹掉字符串字面量和 // 注释，值里的内容就不会被误当成 key。 */
function keysOf(block) {
  const stripped = block
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return new Set([...stripped.matchAll(/(?:^|[\n,{])\s*([A-Za-z_$][A-Za-z0-9_$]*):/g)].map((m) => m[1]));
}

const zhDict = dictBlock(adminHtml, 'zh');
const enDict = dictBlock(adminHtml, 'en');

check('能切出 I18N.zh 字典', !!zhDict, 'zh: { 之后没找到配平的花括号');
check('能切出 I18N.en 字典', !!enDict, 'en: { 之后没找到配平的花括号');

if (zhDict && enDict) {
  const zhKeys = keysOf(zhDict);
  const enKeys = keysOf(enDict);

  // 合理性自检：切出来的字典必须有足够多的 key，否则「一个都没缺」是假通过
  check(
    '字典切取结果合理（zh/en 各 ≥150 个 key）',
    zhKeys.size >= 150 && enKeys.size >= 150,
    `zh=${zhKeys.size}, en=${enKeys.size}`
  );

  // 页面里所有 t('x') 的 key
  const used = new Set(
    [...adminHtml.matchAll(/(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((m) => m[1])
  );
  check('页面确实用到了 t()（避免规则本身失效）', used.size >= 100, `只找到 ${used.size} 个`);

  const missingZh = [...used].filter((k) => !zhKeys.has(k)).sort();
  const missingEn = [...used].filter((k) => !enKeys.has(k)).sort();
  check('所有 t() 的 key 在 zh 里都存在', missingZh.length === 0, `缺失 ${missingZh.length} 个: ${missingZh.join(', ')}`);
  check('所有 t() 的 key 在 en 里都存在', missingEn.length === 0, `缺失 ${missingEn.length} 个: ${missingEn.join(', ')}`);

  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k)).sort();
  check('zh / en 字典 key 对称', onlyZh.length === 0 && onlyEn.length === 0,
    `仅 zh 有: ${onlyZh.join(', ') || '无'}；仅 en 有: ${onlyEn.join(', ') || '无'}`);
}

// ══════════════════════════════════════════════════════════
console.log('');
if (failed) {
  console.error(`✗ ${failed} 项未通过（共 ${passed + failed} 项）`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项不变量通过`);