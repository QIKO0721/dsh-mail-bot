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
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
