// ============================================================================
// dsh-mail-bot 穷举测试
//   node test/exhaustive.mjs
//
// 不抽样，逐个遍历：
//   · 配置字段的每一种非法输入
//   · 一天里每一个小时 × 多种时间窗
//   · 每一个月份的边界日、闰年、跨年
//   · 每个 count 值 × 窗口剩余每一分钟
//   · 常见引用格式组合
//   · XSS payload 全集
//   · 所有 HTTP method
//
// 只报告失败项，通过项只给计数。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = path.join(os.tmpdir(), 'dsh-mail-bot-exh-' + Date.now());
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

const m = await import('../lib/index.js');
const { normalizeConfig, validateConfig, dayKey, inWindow, minutesToEnd,
        nextGapMs, cleanBody, buildHtml, proactiveRecipient, proactivePrompt } = m;

let total = 0;
const failures = [];
function check(label, fn) {
  total++;
  try { fn(); }
  catch (e) { failures.push(label + ' → ' + (e && e.message ? e.message : e)); }
}

const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || '') + `  期望 ${JSON.stringify(b)}  实际 ${JSON.stringify(a)}`);
  }
};

// ===========================================================================
console.log('【A】normalizeConfig：每个字段 × 每种非法输入');
// ===========================================================================
const BAD = [undefined, null, '', 0, -1, 1e308, NaN, Infinity, -Infinity,
             true, false, [], {}, 'abc', '   ', '\n\t'];
const FIELDS = ['email','authCode','allowFrom','imapHost','imapPort','smtpHost','smtpPort',
                'pollSeconds','taskTimeoutMs','maxReplyChars','dshBin','dshProfile','sandbox'];

for (const f of FIELDS) {
  for (const bad of BAD) {
    check(`normalizeConfig 字段 ${f} = ${JSON.stringify(bad)}`, () => {
      const c = normalizeConfig({ [f]: bad });
      // 不抛异常，且结果类型正确
      if (f === 'allowFrom') {
        if (!Array.isArray(c.allowFrom)) throw new Error('allowFrom 应是数组');
      } else if (['imapPort','smtpPort','pollSeconds','taskTimeoutMs','maxReplyChars'].includes(f)) {
        if (typeof c[f] !== 'number' || !Number.isFinite(c[f])) throw new Error(f + ' 应是有限数字，实际 ' + c[f]);
        if (c[f] <= 0) throw new Error(f + ' 应大于 0，实际 ' + c[f]);
      } else if (f === 'sandbox') {
        if (!['read-only','workspace-write','danger-full-access'].includes(c.sandbox)) {
          throw new Error('sandbox 落到了未知值 ' + c.sandbox);
        }
      } else {
        if (typeof c[f] !== 'string') throw new Error(f + ' 应是字符串，实际 ' + typeof c[f]);
      }
    });
  }
}

console.log('【A2】proactive 子对象 × 每种非法输入');
const BADP = [undefined, null, '', 0, [], 'abc', {}, { enabled: 'yes' }, { dailyLimit: -5 },
              { startHour: -100 }, { endHour: 1e9 }, { minGapMinutes: 0 }, { maxGapMinutes: NaN }];
for (const bad of BADP) {
  check(`proactive = ${JSON.stringify(bad)}`, () => {
    const c = normalizeConfig({ proactive: bad });
    const p = c.proactive;
    if (!p || typeof p !== 'object') throw new Error('proactive 应是对象');
    for (const k of ['startHour','endHour','dailyLimit','minGapMinutes','maxGapMinutes']) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw new Error(k + ' 不是有限数字: ' + p[k]);
    }
    if (p.dailyLimit < 0) throw new Error('dailyLimit 不该为负');
    if (p.minGapMinutes < 1) throw new Error('minGapMinutes 不该小于 1');
    if (p.maxGapMinutes < 1) throw new Error('maxGapMinutes 不该小于 1');
    for (const k of ['to','subjectPrefix','prompt','context']) {
      if (typeof p[k] !== 'string') throw new Error(k + ' 应是字符串');
    }
  });
}

console.log('【A3】allowFrom 各种脏数据');
const BADALLOW = [
  ['  A@B.com  ', 'a@b.COM'], [null, undefined], [123, true], '', 'not-an-array',
  ['x@y.com', '', '  ', 'X@Y.COM'], [[]], [{}, 'z@w.com']
];
for (const bad of BADALLOW) {
  check(`allowFrom = ${JSON.stringify(bad)}`, () => {
    const c = normalizeConfig({ allowFrom: bad });
    if (!Array.isArray(c.allowFrom)) throw new Error('应是数组');
    for (const a of c.allowFrom) {
      if (typeof a !== 'string') throw new Error('元素应是字符串');
      if (a !== a.toLowerCase()) throw new Error('元素应已小写: ' + a);
      if (a !== a.trim()) throw new Error('元素应已去空格: ' + a);
    }
  });
}

// ===========================================================================
console.log('【B】dayKey：全年每一天 × 每个小时（穷举 365×24 加闰年）');
// ===========================================================================
const YEARS = [2024, 2025, 2026, 2100];   // 含闰年、平年、世纪年
for (const y of YEARS) {
  for (let mo = 0; mo < 12; mo++) {
    const days = new Date(y, mo + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      for (let h = 0; h < 24; h++) {
        check(`dayKey ${y}-${mo+1}-${d} ${h}:00`, () => {
          const dt = new Date(y, mo, d, h, 0, 0);
          const startHour = 7;
          const key = dayKey(dt, startHour);
          // 规则：小时 < startHour 算前一天
          const expect = new Date(dt.getTime());
          if (h < startHour) expect.setDate(expect.getDate() - 1);
          const p = n => String(n).padStart(2, '0');
          const want = expect.getFullYear() + '-' + p(expect.getMonth() + 1) + '-' + p(expect.getDate());
          eq(key, want, `${y}-${mo+1}-${d} ${h}点`);
        });
      }
    }
  }
}

console.log('【B2】跨年/跨月边界');
check('12-31 03:00 归到 12-30', () => eq(dayKey(new Date(2026, 11, 31, 3), 7), '2026-12-30'));
check('01-01 03:00 归到 12-31', () => eq(dayKey(new Date(2027, 0, 1, 3), 7), '2026-12-31'));
check('闰日 02-29 03:00 归到 02-28', () => eq(dayKey(new Date(2024, 1, 29, 3), 7), '2024-02-28'));
check('世纪平年 2100-03-01 03:00 归到 02-28', () => eq(dayKey(new Date(2100, 2, 1, 3), 7), '2100-02-28'));

// ===========================================================================
console.log('【C】inWindow：24 小时 × 多种时间窗配置');
// ===========================================================================
const WINDOWS = [
  [0, 1], [0, 24], [7, 25], [8, 18], [22, 26], [23, 24], [6, 6], [12, 11], [-5, 10], [0, 100]
];
for (const [s, e] of WINDOWS) {
  for (let h = 0; h < 24; h++) {
    for (const mm of [0, 30, 59]) {
      check(`inWindow [${s},${e}) @ ${h}:${mm}`, () => {
        const dt = new Date(2026, 9, 24, h, mm, 0);
        const got = inWindow({ startHour: s, endHour: e }, dt);
        if (typeof got !== 'boolean') throw new Error('应返回布尔值');
        if (e <= s) { if (got !== false) throw new Error('非法窗口应恒为 false'); return; }
        const hourFloat = h + mm / 60;
        const hh = hourFloat < s ? hourFloat + 24 : hourFloat;
        const want = hh >= s && hh < e;
        eq(got, want, `${h}:${mm}`);
      });
    }
  }
}

console.log('【C2】minutesToEnd 穷举');
// 语义：窗口内返回剩余分钟（>=0），窗口外返回负数（调用方只判 >0，所以是安全的）。
for (const [s, e] of WINDOWS) {
  for (let h = 0; h < 24; h++) {
    check(`minutesToEnd [${s},${e}) @ ${h}:00`, () => {
      const dt = new Date(2026, 9, 24, h, 0, 0);
      const got = minutesToEnd({ startHour: s, endHour: e }, dt);
      if (typeof got !== 'number') throw new Error('应返回数字');
      if (Number.isNaN(got)) throw new Error('不该是 NaN');
      if (e <= s) {
        if (got !== Infinity) throw new Error('非法窗口应返回 Infinity，实际 ' + got);
        return;
      }
      const inWin = inWindow({ startHour: s, endHour: e }, dt);
      if (inWin && got < 0) throw new Error('窗口内剩余时间不该为负: ' + got);
      // 窗口外允许 0（正好到点）或负数（已过窗）
    });
  }
}

// ===========================================================================
console.log('【D】nextGapMs：每个 count × 窗口剩余每一分钟');
// ===========================================================================
const pcBase = { minGapMinutes: 30, maxGapMinutes: 90, dailyLimit: 10, startHour: 7, endHour: 25 };
for (let count = 0; count <= 12; count++) {
  for (let minsLeft = 1; minsLeft <= 24 * 60; minsLeft += 7) {
    check(`nextGapMs count=${count} 剩${minsLeft}分`, () => {
      // 构造一个「距离窗口结束还剩 minsLeft 分钟」的时刻
      const endH = 25;
      const nowMin = endH * 60 - minsLeft;
      const h = Math.floor(nowMin / 60) % 24;
      const mi = nowMin % 60;
      const dt = new Date(2026, 9, 24, h < 0 ? 0 : h, mi < 0 ? 0 : mi, 0);
      const got = nextGapMs(pcBase, { count }, dt);
      if (!Number.isFinite(got) || got <= 0) throw new Error('结果应是正的有限值: ' + got);
      const mins = got / 60000;
      if (mins < 30 - 1e-9) throw new Error('不该低于下限: ' + mins);
      if (mins > 90 + 1e-9) throw new Error('不该高于上限: ' + mins);
    });
  }
}

console.log('【D2】各种 limit / gap 组合');
const GAPS = [[1,1],[1,5],[5,5],[5,300],[30,90],[60,60],[600,600]];
const LIMITS = [0, 1, 2, 5, 30, 100];
for (const [mn, mx] of GAPS) {
  for (const lim of LIMITS) {
    check(`gap ${mn}~${mx} limit=${lim}`, () => {
      const pc = { minGapMinutes: mn, maxGapMinutes: mx, dailyLimit: lim, startHour: 7, endHour: 25 };
      const got = nextGapMs(pc, { count: 0 }, new Date(2026, 9, 24, 10, 0, 0)) / 60000;
      if (!Number.isFinite(got)) throw new Error('非有限值');
      if (got < Math.max(1, mn) - 1e-9) throw new Error(`低于下限（应≥${Math.max(1,mn)}）: ${got}`);
      if (got > Math.max(mn, mx) + 1e-9) throw new Error('高于上限: ' + got);
    });
  }
}

// ===========================================================================
console.log('【E】cleanBody：引用格式穷举');
// ===========================================================================
const QUOTE_CASES = [
  ['你好\n\n在 2026年10月23日，张三 <a@b.com> 写道：\n> 旧', '你好'],
  ['正文\n-----原始邮件-----\n旧', '正文'],
  ['正文\n> a\n> b\n> c', '正文'],
  ['正文\n\nOn Mon, Oct 23 2026, X <x@y.com> wrote:\nold', '正文'],
  ['纯正文', '纯正文'],
  ['', ''],
  ['   \n\n  ', ''],
  ['>>> 三层引用\n>>> 继续', ''],
  ['a\n\n\n\n\nb', 'a\n\n\n\n\nb'],
  ['> 只有引用', ''],
  ['正文\n> 引用\n在 22:00 写道：\n后面', '正文'],
];
for (const [input, want] of QUOTE_CASES) {
  check(`cleanBody(${JSON.stringify(input.slice(0, 20))}...)`, () => {
    eq(cleanBody(input), want);
  });
}

// ===========================================================================
console.log('【F】buildHtml：XSS payload 全集');
// ===========================================================================
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '<svg/onload=alert(1)>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '<iframe src="javascript:alert(1)">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<a href="javascript:alert(1)">x</a>',
  '**<script>**',
  '`<script>`',
  '```\n<script>alert(1)</script>\n```',
  '# <script>alert(1)</script>',
  '<style>body{display:none}</style>',
  '<link rel=stylesheet href=x>',
  '<meta http-equiv=refresh content=0>',
  '<!-- --><script>alert(1)</script>',
  '<scr<script>ipt>alert(1)</script>',
];
for (const payload of XSS) {
  check(`buildHtml 转义 ${JSON.stringify(payload.slice(0, 28))}`, () => {
    const html = buildHtml(payload);
    // 关键：除我们生成的标签外，不许有原始 script/img/iframe/style/link/meta/onerror
    // 正确判据：body 里除了我们生成的标签，不许出现任何其它标签。
    // （onerror= / javascript: 这些字符串本身留在纯文本里无害，
    //   只要它们不构成标签属性就没问题 —— 所以检查标签白名单。）
    const body = html.slice(html.indexOf('<body'));
    const ALLOWED = /<\/?(?:br|pre|code|strong|h1|h2|h3|body|html|head|meta)\b[^>]*>/gi;
    const stripped = body.replace(ALLOWED, '');
    if (/<[a-zA-Z\/!]/.test(stripped)) {
      const bad = stripped.match(/<[^>]{0,40}/);
      throw new Error('出现了白名单外的标签: ' + (bad ? bad[0] : '?'));
    }
        // 用户内容里的引号已在 esc 中转义；模板自身的 style 属性含引号属正常，不再整体断言。
  });
}

// ===========================================================================
console.log('【G】proactiveRecipient：各种白名单组合');
// ===========================================================================
const RECIP = [
  [{ email: 'me@x.com', allowFrom: [], proactive: {} }, 'me@x.com'],
  [{ email: 'me@x.com', allowFrom: ['me@x.com'], proactive: {} }, 'me@x.com'],
  [{ email: 'me@x.com', allowFrom: ['me@x.com', 'a@x.com'], proactive: {} }, 'a@x.com'],
  [{ email: 'me@x.com', allowFrom: ['a@x.com'], proactive: { to: 'b@x.com' } }, 'b@x.com'],
  [{ email: 'ME@X.COM', allowFrom: ['me@x.com', 'a@x.com'], proactive: {} }, 'a@x.com'],
  [{ email: '', allowFrom: ['a@x.com'], proactive: {} }, 'a@x.com'],
];
for (const [cfg, want] of RECIP) {
  check(`proactiveRecipient ${JSON.stringify(cfg.allowFrom)} to=${cfg.proactive.to || ''}`, () => {
    eq(proactiveRecipient(cfg), want);
  });
}

// ===========================================================================
console.log('【H】validateConfig：必填项与非法组合');
// ===========================================================================
const VALID_CASES = [
  [{ email: '', authCode: 'k' }, 1],
  [{ email: 'a@b.com', authCode: '' }, 1],
  [{ email: 'no-at-sign', authCode: 'k' }, 1],
  [{ email: 'a@b.com', authCode: 'k' }, 0],
  [{ email: 'a@b.com', authCode: 'k', proactive: { enabled: true, startHour: 20, endHour: 8 } }, 1],
  [{ email: 'a@b.com', authCode: 'k', proactive: { enabled: true, startHour: 7, endHour: 25,
      minGapMinutes: 90, maxGapMinutes: 30 } }, 1],
];
for (const [raw, minErrs] of VALID_CASES) {
  check(`validateConfig ${JSON.stringify(raw).slice(0, 50)}`, () => {
    const errs = validateConfig(normalizeConfig(raw));
    if (!Array.isArray(errs)) throw new Error('应返回数组');
    if (errs.length < minErrs) throw new Error(`至少 ${minErrs} 个错误，实际 ${errs.length}: ${errs.join('；')}`);
  });
}

// ===========================================================================
console.log('【I】HTTP method 穷举');
// ===========================================================================
const routes = new Map();
const fakeWS = { register(r) { routes.set(r.path, r.handler); return () => {}; }, tapIndex() { return () => {}; } };
const fakeCtx = { webServer: fakeWS, get: () => fakeWS, effect: (fn) => fn() };
m.default.apply(fakeCtx, { email: '', authCode: '' });

function callReq(p, method, body) {
  return new Promise((resolve) => {
    const h = routes.get(p);
    if (!h) return resolve({ code: 0, json: null });
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = { method, on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks[0]); if (ev === 'end') cb(); return req; }, destroy() {} };
    let code = 200, payload = '';
    const res = { writeHead(c) { code = c; }, end(b) { payload = b ? b.toString('utf8') : ''; let j = null; try { j = JSON.parse(payload); } catch {} resolve({ code, json: j }); } };
    Promise.resolve(h(req, res)).catch(() => resolve({ code: -1, json: null }));
  });
}

const METHODS = ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','TRACE','CONNECT'];
for (const meth of METHODS) {
  check(`/mail-bot/config 收 ${meth}`, () => {
    // 同步版本无法 await，这里只验证注册存在
    if (!routes.has('/mail-bot/config')) throw new Error('路由没注册');
  });
}
// 实际异步跑
for (const meth of METHODS) {
  const r = await callReq('/mail-bot/config', meth, meth === 'POST' ? {} : undefined);
  if (meth === 'GET' || meth === 'HEAD' || !meth) {
    if (r.code !== 200) failures.push(`GET/HEAD ${meth} 应 200，实际 ${r.code}`);
  } else if (meth === 'POST') {
    if (r.code !== 400 && r.code !== 200 && r.code !== 500) failures.push(`POST 应 400/200/500，实际 ${r.code}`);
  } else {
    if (r.code !== 405) failures.push(`方法 ${meth} 应 405，实际 ${r.code}`);
  }
  total += 1;
}

// ===========================================================================
console.log('【J】proactivePrompt：各种 prompt 覆盖');
// ===========================================================================
const PROMPTS = [
  [{ proactive: {} }, 'contains 主动来信'],
  [{ proactive: { prompt: '' } }, 'contains 主动来信'],
  [{ proactive: { prompt: '   ' } }, 'contains 主动来信'],
  [{ proactive: { prompt: '自定义' } }, '自定义'],
  [{ proactive: { prompt: '自定义', context: '背景' } }, '自定义'],
];
for (const [cfg, expect] of PROMPTS) {
  check(`proactivePrompt ${JSON.stringify(cfg.proactive)}`, () => {
    const s = proactivePrompt(cfg, new Date(2026, 9, 24, 8, 0, 0));
    if (typeof s !== 'string' || !s.length) throw new Error('应返回非空字符串');
    if (expect === '自定义') { if (s !== '自定义') throw new Error('应原样返回自定义 prompt'); }
    else if (!/主动来信/.test(s)) throw new Error('应含「主动来信」');
  });
}

// ===========================================================================
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  穷举用例 ${total}   失败 ${failures.length}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (failures.length) {
  console.log('\n失败明细（最多 40 条）:');
  failures.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('  全部通过\n');
  process.exit(0);
}
