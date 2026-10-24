// ============================================================================
// dsh-mail-bot 路由测试
//   node test/routes.mjs
// 用一个假的 webServer 模拟 DSH，验证设置页要用的三个接口。
// 全程把 DSH_HOME 指到临时目录，不碰真实配置。
// ============================================================================

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 插件之前设好，插件模块加载时会读它
const TMP_HOME = path.join(os.tmpdir(), 'dsh-mail-bot-test-' + Date.now());
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

const { default: plugin } = await import('../lib/index.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}

// ---------------------------------------------------------------------------
// 假 webServer
// ---------------------------------------------------------------------------
const routes = new Map();
const fakeWebServer = {
  register(route) {
    routes.set(route.path + ':' + (route.method || 'ALL'), route.handler);
    return () => routes.delete(route.path);
  },
  tapIndex() { return () => {}; }
};

const fakeCtx = {
  webServer: fakeWebServer,
  get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
  effect(fn) { const d = fn(); return d; }
};

/** 造一个假的 req/res，跑一次 handler */
function call(path, method, body) {
  return new Promise((resolve, reject) => {
    const key = path + ':ALL';
    const handler = routes.get(key);
    if (!handler) return reject(new Error('路由没注册：' + path));

    const chunks = [];
    if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'));

    const req = {
      method,
      on(ev, cb) {
        if (ev === 'data' && chunks.length) cb(chunks[0]);
        if (ev === 'end') cb();
        return req;
      },
      destroy() {}
    };

    let code = 200;
    let payload = '';
    const res = {
      writeHead(c) { code = c; },
      end(buf) {
        payload = buf ? buf.toString('utf8') : '';
        let json = null;
        try { json = JSON.parse(payload); } catch { /* 不是 JSON */ }
        resolve({ code, json, raw: payload });
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// ---------------------------------------------------------------------------
console.log('\n【路由注册】');
plugin.apply(fakeCtx, { email: '', authCode: '' });

ok('注册了 /mail-bot/config', () => assert.ok(routes.has('/mail-bot/config:ALL')));
ok('注册了 /mail-bot/status', () => assert.ok(routes.has('/mail-bot/status:ALL')));

// ---------------------------------------------------------------------------
console.log('\n【GET /mail-bot/config】');
await okAsync('返回 ok:true 与 config', async () => {
  const r = await call('/mail-bot/config', 'GET');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.ok, true);
  assert.ok(r.json.config && typeof r.json.config === 'object');
});
await okAsync('授权码不外露（没设置时 hasAuthCode=false）', async () => {
  const r = await call('/mail-bot/config', 'GET');
  assert.strictEqual(r.json.config.hasAuthCode, false);
  assert.strictEqual(r.json.config.authCode, '');
});
await okAsync('带上默认值', async () => {
  const r = await call('/mail-bot/config', 'GET');
  const c = r.json.config;
  assert.strictEqual(c.imapHost, 'imap.qq.com');
  assert.strictEqual(c.imapPort, 993);
  assert.strictEqual(c.smtpHost, 'smtp.qq.com');
  assert.strictEqual(c.proactive.endHour, 25);
  assert.strictEqual(c.proactive.dailyLimit, 10);
});

// ---------------------------------------------------------------------------
console.log('\n【POST /mail-bot/config 校验】');
await okAsync('缺 email 会被拒', async () => {
  const r = await call('/mail-bot/config', 'POST', { authCode: 'ABCDEFGH12345678' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.json.ok, false);
  assert.ok(/email/.test(r.json.error), '错误信息里该提到 email：' + r.json.error);
});
await okAsync('缺 authCode 会被拒', async () => {
  const r = await call('/mail-bot/config', 'POST', { email: 'a@b.com' });
  assert.strictEqual(r.code, 400);
  assert.ok(/authCode/.test(r.json.error), '该提到 authCode：' + r.json.error);
});
await okAsync('主动来信 endHour <= startHour 会被拒', async () => {
  const r = await call('/mail-bot/config', 'POST', {
    email: 'a@b.com',
    authCode: 'ABCDEFGH12345678',
    proactive: { enabled: true, startHour: 20, endHour: 8, dailyLimit: 5, minGapMinutes: 10, maxGapMinutes: 60 }
  });
  assert.strictEqual(r.code, 400);
  assert.ok(/endHour/.test(r.json.error), '该提到 endHour：' + r.json.error);
});

// ---------------------------------------------------------------------------
console.log('\n【POST 合法配置】');
await okAsync('保存成功并落盘', async () => {
  const r = await call('/mail-bot/config', 'POST', {
    email: 'me@example.com',
    authCode: 'ABCDEFGH12345678',
    allowFrom: ['me@example.com'],
    pollSeconds: 20
  });
  assert.strictEqual(r.code, 200, '返回：' + JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  const f = path.join(TMP_HOME, 'mail-bot.json');
  assert.ok(fs.existsSync(f), '配置文件该被写出来：' + f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(saved.email, 'me@example.com');
  assert.strictEqual(saved.authCode, 'ABCDEFGH12345678');
  assert.strictEqual(saved.pollSeconds, 20);
});

await okAsync('返回的授权码是打码的', async () => {
  const r = await call('/mail-bot/config', 'GET');
  assert.strictEqual(r.json.config.hasAuthCode, true);
  assert.ok(r.json.config.authCode.indexOf('•') >= 0, '该含打码符：' + r.json.config.authCode);
  assert.ok(r.json.config.authCode.indexOf('ABCDEFGH') === -1, '不该含明文');
});

await okAsync('提交打码串不会覆盖真授权码', async () => {
  await call('/mail-bot/config', 'POST', {
    email: 'me@example.com',
    authCode: 'AB••••••••78',
    allowFrom: ['me@example.com']
  });
  const saved = JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'mail-bot.json'), 'utf8'));
  assert.strictEqual(saved.authCode, 'ABCDEFGH12345678');
});

// ---------------------------------------------------------------------------
console.log('\n【GET /mail-bot/status】');
await okAsync('返回运行状态与日志路径', async () => {
  const r = await call('/mail-bot/status', 'GET');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(typeof r.json.running, 'boolean');
  assert.ok(typeof r.json.logFile === 'string' && r.json.logFile.indexOf('mail-bot') >= 0);
  assert.ok(r.json.today && typeof r.json.today.count === 'number');
});

// ---------------------------------------------------------------------------
console.log('\n【没有 webServer 时不该崩】');
await okAsync('退化到只记日志', async () => {
  const bare = { effect(fn) { fn(); } };
  plugin.apply(bare, { email: '', authCode: '' });
  assert.ok(true);
});

// ---------------------------------------------------------------------------
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// 收尾：删临时 DSH_HOME
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1);
