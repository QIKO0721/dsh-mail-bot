// ============================================================================
// dsh-mail-bot 冒烟测试
//   node test/smoke.mjs
// 只测纯函数，不连邮箱、不跑 DSH。
// ============================================================================

import assert from 'node:assert';
import {
  cleanBody, buildHtml, dayKey, inWindow, minutesToEnd,
  nextGapMs, proactiveRecipient, proactivePrompt
} from '../lib/index.js';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}

const at = (h, m = 0, d = 15) => new Date(2026, 9, d, h, m, 0);   // 2026-10
const pc = (over = {}) => Object.assign({
  enabled: true, startHour: 7, endHour: 25,
  dailyLimit: 10, minGapMinutes: 30, maxGapMinutes: 90
}, over);

// ---------------------------------------------------------------------------
console.log('\n【cleanBody】引用历史要剥掉');
ok('去掉「在 xxx 写道」', () => {
  const r = cleanBody('你好\n\n在 2026年10月23日，张三 <a@b.com> 写道：\n> 旧内容');
  assert.strictEqual(r, '你好');
});
ok('去掉原始邮件分隔线', () => {
  const r = cleanBody('正文\n\n-----原始邮件-----\n旧内容');
  assert.strictEqual(r, '正文');
});
ok('去掉 > 引用行', () => {
  const r = cleanBody('正文\n> 引用1\n> 引用2');
  assert.strictEqual(r, '正文');
});
ok('空正文返回空串', () => {
  assert.strictEqual(cleanBody('   \n\n '), '');
});

// ---------------------------------------------------------------------------
console.log('\n【buildHtml】');
ok('转义 HTML 特殊字符', () => {
  const h = buildHtml('<script>alert(1)</script>');
  assert.ok(!h.includes('<script>'), '不该保留裸 script 标签');
  assert.ok(h.includes('&lt;script&gt;'), '应该转义成实体');
});
ok('代码块变成 pre', () => {
  const h = buildHtml('```\nconst a = 1;\n```');
  assert.ok(h.includes('<pre'), '应该有 pre');
});
ok('粗体变成 strong', () => {
  assert.ok(buildHtml('**粗**').includes('<strong>粗</strong>'));
});

// ---------------------------------------------------------------------------
console.log('\n【dayKey】换天边界是 startHour，不是 0 点');
ok('凌晨 2 点算前一天', () => {
  assert.strictEqual(dayKey(at(2), 7), '2026-10-14');
});
ok('早上 8 点算当天', () => {
  assert.strictEqual(dayKey(at(8), 7), '2026-10-15');
});
ok('半夜 23 点算当天', () => {
  assert.strictEqual(dayKey(at(23), 7), '2026-10-15');
});
ok('跨月正确', () => {
  const d = new Date(2026, 10, 1, 3, 0, 0);   // 11-01 03:00
  assert.strictEqual(dayKey(d, 7), '2026-10-31');
});

// ---------------------------------------------------------------------------
console.log('\n【inWindow】');
ok('7:00 在窗口内（闭区间起点）', () => assert.ok(inWindow(pc(), at(7))));
ok('6:59 不在窗口内', () => assert.ok(!inWindow(pc(), at(6, 59))));
ok('23:00 在窗口内', () => assert.ok(inWindow(pc(), at(23))));
ok('次日 0:30 在窗口内（endHour=25）', () => assert.ok(inWindow(pc(), at(0, 30))));
ok('次日 1:00 已出窗口', () => assert.ok(!inWindow(pc(), at(1, 0))));
ok('endHour 非法返回 false', () => assert.ok(!inWindow(pc({ endHour: 7 }), at(12))));

// ---------------------------------------------------------------------------
console.log('\n【minutesToEnd】');
ok('8 点在窗口内，剩 17 小时 = 1020 分', () => {
  assert.strictEqual(minutesToEnd(pc(), at(8)), 1020);
});
ok('0 点在窗口内，剩 60 分', () => {
  assert.strictEqual(minutesToEnd(pc(), at(0, 0)), 60);
});

// ---------------------------------------------------------------------------
console.log('\n【nextGapMs】');
ok('间隔落在 30~90 分钟', () => {
  for (let i = 0; i < 300; i++) {
    const m = nextGapMs(pc(), { count: 0 }, at(8)) / 60000;
    assert.ok(m >= 30 - 0.01, '下限破了：' + m);
    assert.ok(m <= 90 + 0.01, '上限破了：' + m);
  }
});
ok('是随机的（300 次不该只有一个值）', () => {
  const set = new Set();
  for (let i = 0; i < 300; i++) set.add(Math.round(nextGapMs(pc(), { count: 0 }, at(8)) / 60000));
  assert.ok(set.size > 10, '只出现了 ' + set.size + ' 种值，像固定值');
});
ok('剩余时间不够时会被压到下限', () => {
  // 窗口只剩 10 分钟，还剩 5 封 —— 平均 2 分钟，但下限是 30
  const m = nextGapMs(pc(), { count: 5 }, at(0, 50)) / 60000;
  assert.ok(m >= 30 - 0.01, '不该低于下限：' + m);
});
ok('最后一封不再压缩', () => {
  const m = nextGapMs(pc(), { count: 9 }, at(0, 50)) / 60000;
  assert.ok(m >= 30 - 0.01);
});

// ---------------------------------------------------------------------------
console.log('\n【proactiveRecipient】');
ok('优先用显式 to', () => {
  const c = { email: 'me@x.com', allowFrom: ['a@x.com'], proactive: { to: 'b@x.com' } };
  assert.strictEqual(proactiveRecipient(c), 'b@x.com');
});
ok('没写 to 就挑第一个非自己的白名单', () => {
  const c = { email: 'me@x.com', allowFrom: ['me@x.com', 'a@x.com'], proactive: {} };
  assert.strictEqual(proactiveRecipient(c), 'a@x.com');
});
ok('白名单只有自己时退回自己', () => {
  const c = { email: 'me@x.com', allowFrom: ['me@x.com'], proactive: {} };
  assert.strictEqual(proactiveRecipient(c), 'me@x.com');
});

// ---------------------------------------------------------------------------
console.log('\n【proactivePrompt】');
ok('自定义 prompt 优先', () => {
  const c = { proactive: { prompt: '自定义内容' } };
  assert.strictEqual(proactivePrompt(c, at(8)), '自定义内容');
});
ok('默认 prompt 带时间与星期', () => {
  const s = proactivePrompt({ proactive: {} }, at(8, 30));
  assert.ok(s.includes('10-15 08:30'), '缺时间：' + s.slice(0, 80));
  assert.ok(s.includes('星期四'), '缺星期');
});
ok('默认 prompt 说明「无」的含义', () => {
  const s = proactivePrompt({ proactive: {} }, at(8));
  assert.ok(s.includes('「无」'), '应说明回「无」就不发');
});
ok('默认 prompt 要求不写前缀', () => {
  const s = proactivePrompt({ proactive: {} }, at(8));
  assert.ok(s.includes('主题'), '应提醒别写「主题：」');
});

// ---------------------------------------------------------------------------
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
process.exit(fail === 0 ? 0 : 1);
