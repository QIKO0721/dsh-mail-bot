// ============================================================================
// dsh-mail-bot 并发测试
//   node test/race.mjs
//
// 复现「回信任务」和「主动来信」同时读写 state 的场景，
// 验证 patchState 的原子合并不会互相覆盖。
//
// 全程把 DSH_HOME 指到临时目录，不碰真实状态。
// ============================================================================

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = path.join(os.tmpdir(), 'dsh-mail-bot-race-' + Date.now());
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

const mod = await import('../lib/index.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}

// patchState 没导出，用 runDsh 走不通。
// 这里直接测「两个异步流程交错写 state 文件」的行为：
// 用插件暴露的 dataDir 找状态文件名，手工模拟读写。
const stateFile = path.join(TMP_HOME, 'mail-bot', 'state.json');

function writeState(obj) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2), 'utf8');
}
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
}

// ---------------------------------------------------------------------------
console.log('\n【基线：状态文件能读能写】');
writeState({ day: '2026-10-24', count: 5, lastSentAt: 111, nextEligibleAt: 222, sessionId: 'session-A' });
ok('写进去能读出来', () => {
  const s = readState();
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.sessionId, 'session-A');
});

// ---------------------------------------------------------------------------
console.log('\n【复现场景：整份写回会覆盖（旧行为）】');
await okAsync('两个流程各自 load → 改 → save，后写的覆盖先写的', async () => {
  writeState({ day: '2026-10-24', count: 5, lastSentAt: 0, nextEligibleAt: 0, sessionId: 'session-A' });

  // A：任务流程，只想改 sessionId
  const a = readState();
  // B：主动来信流程，只想把 count +1
  const b = readState();

  await new Promise(r => setTimeout(r, 10));   // 模拟跑 dsh 的耗时

  // B 先写
  b.count += 1;
  writeState(b);

  // A 后写（整份覆盖）→ count 被打回去
  a.sessionId = 'session-B';
  writeState(a);

  const s = readState();
  assert.strictEqual(s.sessionId, 'session-B', 'sessionId 应该是新的');
  assert.strictEqual(s.count, 5, '这正是旧行为的问题：count 从 6 被打回 5');
});

// ---------------------------------------------------------------------------
console.log('\n【修复后：只改自己的字段，互不覆盖】');
await okAsync('A 只写 sessionId、B 只写 count，两边都在', async () => {
  writeState({ day: '2026-10-24', count: 5, lastSentAt: 0, nextEligibleAt: 0, sessionId: 'session-A' });

  // 模拟 patchState：读最新 → 只合并指定字段 → 写回（同步，无 await）
  function patchState(patch) {
    const cur = readState();
    writeState(Object.assign({}, cur, patch));
  }

  // B 先写 count
  patchState({ day: '2026-10-24', count: 6 });

  // A 后写 sessionId —— 因为只合并这一个字段，count 保住
  patchState({ sessionId: 'session-B' });

  const s = readState();
  assert.strictEqual(s.sessionId, 'session-B', 'sessionId 更新成功');
  assert.strictEqual(s.count, 6, 'count 没被打回去');
  assert.strictEqual(s.day, '2026-10-24', 'day 还在');
});

await okAsync('反向顺序也一样：A 先写，B 后写', async () => {
  writeState({ day: '2026-10-24', count: 5, lastSentAt: 0, nextEligibleAt: 0, sessionId: 'session-A' });

  function patchState(patch) {
    const cur = readState();
    writeState(Object.assign({}, cur, patch));
  }

  patchState({ sessionId: 'session-C' });
  patchState({ day: '2026-10-24', count: 7 });

  const s = readState();
  assert.strictEqual(s.sessionId, 'session-C', 'sessionId 没被 B 覆盖');
  assert.strictEqual(s.count, 7, 'count 更新成功');
});

// ---------------------------------------------------------------------------
console.log('\n【真实插件：patchState 必须是同步的】');
ok('源码里 patchState 不含 await', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const m = src.match(/function patchState\(patch\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '找得到 patchState');
  assert.ok(!/await/.test(m[0]), 'patchState 里不该有 await，否则就不是原子的');
});

ok('saveState 只在 patchState 内部被调用', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const outside = [];
  let inPatch = false;
  lines.forEach((l, n) => {
    if (/^function patchState/.test(l)) inPatch = true;
    else if (inPatch && /^\}/.test(l)) inPatch = false;
    if (!inPatch && /^\s+saveState\(/.test(l) && !/^\s*\/\//.test(l)) {
      outside.push(n + 1);
    }
  });
  assert.deepStrictEqual(outside, [], '除了 patchState，别人不该直接调 saveState，行号：' + outside.join(','));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\n【主动来信并发锁】');
await okAsync('并发调三次，内部只跑一次', async () => {
  const bot = new mod.MailBot({}, { email: 'a@b.com', authCode: 'k' });
  let runs = 0;
  bot._maybeProactiveInner = async () => {
    runs++;
    await new Promise(r => setTimeout(r, 80));   // 模拟 spawn dsh 的耗时
  };
  await Promise.all([
    bot.maybeProactive(),
    bot.maybeProactive(),
    bot.maybeProactive()
  ]);
  assert.strictEqual(runs, 1, '应该只跑一次，实际跑了 ' + runs + ' 次');
  assert.strictEqual(bot.proactiveBusy, false, '跑完锁要释放');
});

await okAsync('前一次跑完后，下一次能正常进入', async () => {
  const bot = new mod.MailBot({}, { email: 'a@b.com', authCode: 'k' });
  let runs = 0;
  bot._maybeProactiveInner = async () => { runs++; };
  await bot.maybeProactive();
  await bot.maybeProactive();
  assert.strictEqual(runs, 2, '串行调用两次应该跑两次，实际 ' + runs);
});

await okAsync('内部抛异常，锁也会释放', async () => {
  const bot = new mod.MailBot({}, { email: 'a@b.com', authCode: 'k' });
  let runs = 0;
  bot._maybeProactiveInner = async () => { runs++; throw new Error('boom'); };
  try { await bot.maybeProactive(); } catch { /* 预期内 */ }
  assert.strictEqual(bot.proactiveBusy, false, '异常后锁必须释放，否则永久卡死');
  bot._maybeProactiveInner = async () => { runs++; };
  await bot.maybeProactive();
  assert.strictEqual(runs, 2, '锁释放后应该能再进');
});

ok('源码里 maybeProactive 带锁', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const m2 = src.match(/async maybeProactive\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m2, '找得到 maybeProactive');
  assert.ok(/proactiveBusy/.test(m2[0]), 'maybeProactive 里必须有 proactiveBusy 判断');
});

// ---------------------------------------------------------------------------
console.log('\n【单实例保护】');
ok('新实例 start 时会把旧实例按死', () => {
  const A = new mod.MailBot({}, { email: '', authCode: '' });
  A.running = true;
  A.start();                       // 没配邮箱，start 直接 return，但会占住 ACTIVE_BOT

  const B = new mod.MailBot({}, { email: '', authCode: '' });
  B.start();                       // 应该检测到 A 还在，强制停掉它

  assert.strictEqual(A.running, false, '旧实例的 running 必须被置为 false');
});

ok('forceStop 能同步清掉定时器和连接引用', () => {
  const C = new mod.MailBot({}, { email: '', authCode: '' });
  C.running = true;
  let timerAlive = true;
  C.proactiveTimer = setInterval(() => {}, 100000);
  C.client = { close() { timerAlive = false; }, logout() {} };
  C.forceStop();
  assert.strictEqual(C.running, false, 'running 应为 false');
  assert.strictEqual(C.proactiveTimer, null, '定时器应被清空');
  assert.strictEqual(C.client, null, '连接引用应被清空');
  assert.strictEqual(timerAlive, false, '应该调用了 close()');
});

ok('stop() 走的是 forceStop', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const m2 = src.match(/stop\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m2, '找得到 stop');
  assert.ok(/this\.forceStop\(\)/.test(m2[0]), 'stop 里应该调 forceStop');
  assert.ok(!/client\.logout/.test(m2[0]), 'stop 里不该再自己 logout');
});

ok('源码里有模块级 ACTIVE_BOT', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(/let ACTIVE_BOT = null/.test(src), '应该有模块级单例变量');
  assert.ok(/ACTIVE_BOT && ACTIVE_BOT !== this/.test(src), 'start 里应该判旧实例');
  assert.ok(/ACTIVE_BOT = this/.test(src), 'start 里应该登记自己');
});

// ---------------------------------------------------------------------------
console.log('\n【连接循环代数】');
ok('start 会递增 loopGen', () => {
  const D = new mod.MailBot({}, { email: '', authCode: '' });
  const before = D.loopGen;
  D.start();                        // 没配邮箱，但 loopGen 已经加了
  assert.strictEqual(D.loopGen, before + 1, 'loopGen 应该 +1');
});

ok('连续 start 会一直递增（旧循环逐代失效）', () => {
  const E = new mod.MailBot({}, { email: '', authCode: '' });
  const g0 = E.loopGen;
  E.start(); E.start(); E.start();
  assert.strictEqual(E.loopGen, g0 + 3, '三次 start 应该是 +3');
});

ok('源码里 connectionLoop 带代数检查', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const m2 = src.match(/async connectionLoop\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m2, '找得到 connectionLoop');
  assert.ok(/const gen = \+\+this\.loopGen/.test(m2[0]), '循环开头要取代数');
  assert.ok(/gen === this\.loopGen/.test(m2[0]), 'while 条件要检查代数');
});

ok('holdConnection 也接受代数', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(/async holdConnection\(gen\)/.test(src), 'holdConnection 应接受 gen');
  assert.ok(/await this\.holdConnection\(gen\)/.test(src), '调用时要传 gen');
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
