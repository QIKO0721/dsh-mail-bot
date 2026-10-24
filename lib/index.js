// ============================================================================
// dsh-mail-bot —— DSH 邮件助手插件
//
// 手机发邮件 → IMAP 收信 → 调 dsh headless 干活 → SMTP 回信
// 另支持「主动来信」：到点自己给主人写信
//
// 设计要点：
//   · 零 DSH 依赖 —— 只用 Node 内置模块 + 三个邮件库，装起来最省事
//   · 插件形式用 Cordis 支持的 { apply } 对象，生命周期走 ctx.effect()
//   · 所有状态写在 $DSH_HOME/mail-bot/ 下，不污染工作区
//   · 收到的每封邮件靠 X-Mail-Bot 头防自环
// ============================================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// 路径与日志
// ---------------------------------------------------------------------------

const PRODUCT = 'dsh-mail-bot';

function resolveHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dataDir() {
  const dir = path.join(resolveHome(), 'mail-bot');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

const logFile = () => path.join(dataDir(), 'mail-bot.log');

/** 设置页读写的用户配置（优先于 profile 里的 config） */
const userConfigFile = () => path.join(resolveHome(), 'mail-bot.json');

function readUserConfig() {
  try {
    const raw = fs.readFileSync(userConfigFile(), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return (j && typeof j === 'object') ? j : {};
  } catch {
    return {};
  }
}

function writeUserConfig(obj) {
  const dir = resolveHome();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(userConfigFile(), JSON.stringify(obj, null, 2), 'utf8');
}

function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg;
  try { fs.appendFileSync(logFile(), line + '\n'); } catch { /* ignore */ }
  // 同时打到 DSH 控制台（如果宿主接管了 console）
  try { console.log('[mail-bot] ' + msg); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 配置：默认值 + 手写校验（不依赖 schemastery）
// ---------------------------------------------------------------------------

const DEFAULTS = {
  email: '',
  authCode: '',
  allowFrom: [],

  imapHost: 'imap.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,

  pollSeconds: 15,
  taskTimeoutMs: 600000,
  maxReplyChars: 40000,

  dshBin: '',
  dshProfile: 'headless',

  // 邮件任务的权限级别。只影响插件 spawn 的进程，不动宿主的 profile 配置。
  // 默认给 workspace-write：能读、能在工作目录里写，但碰不了系统盘。
  // 需要完全权限的自己去设置页改，别把危险默认值带给所有人。
  sandbox: 'workspace-write',

  proactive: {
    enabled: false,
    startHour: 7,
    endHour: 25,
    dailyLimit: 10,
    minGapMinutes: 30,
    maxGapMinutes: 90,
    to: '',
    subjectPrefix: '主动来信',
    prompt: '',
    context: ''
  }
};

/** 认识这三个级别，其它值一律回落到最安全的 workspace-write */
const SANDBOX_LEVELS = ['read-only', 'workspace-write', 'danger-full-access'];

/** 取数字。
 *
 *  ⚠ 不能直接 Number(v)：Number(null)=0、Number('')=0、Number(false)=0、
 *  Number([])=0、Number('   ')=0。用户在设置页把端口输入框清空时，
 *  这些都会变成 0，然后 IMAP 连 0 端口就废了。空值必须回落默认值。
 */
const num = (v, d) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : d;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return d;
    const n = Number(s);
    return Number.isFinite(n) ? n : d;
  }
  return d;   // null / undefined / boolean / array / object 一律用默认值
};

/** 端口：额外钳到 1~65535，越界回落默认 */
const port = (v, d) => {
  const n = num(v, d);
  return (n >= 1 && n <= 65535) ? Math.round(n) : d;
};

const bool = (v, d) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return d;
};

const str = (v, d) => (typeof v === 'string' ? v : (v == null ? d : String(v)));

/** 合并默认值 + 类型纠正 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const p = c.proactive && typeof c.proactive === 'object' ? c.proactive : {};
  const d = DEFAULTS;
  const dp = d.proactive;

  const allowFrom = Array.isArray(c.allowFrom)
    ? c.allowFrom.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : [];

  return {
    email: str(c.email, d.email).trim(),
    authCode: str(c.authCode, d.authCode).trim(),
    allowFrom,

    imapHost: str(c.imapHost, d.imapHost).trim() || d.imapHost,
    imapPort: port(c.imapPort, d.imapPort),
    smtpHost: str(c.smtpHost, d.smtpHost).trim() || d.smtpHost,
    smtpPort: port(c.smtpPort, d.smtpPort),

    pollSeconds: Math.max(5, Math.round(num(c.pollSeconds, d.pollSeconds))),
    taskTimeoutMs: Math.max(10000, Math.round(num(c.taskTimeoutMs, d.taskTimeoutMs))),
    maxReplyChars: Math.max(2000, Math.round(num(c.maxReplyChars, d.maxReplyChars))),

    dshBin: str(c.dshBin, d.dshBin).trim(),
    dshProfile: str(c.dshProfile, d.dshProfile).trim() || d.dshProfile,

    sandbox: SANDBOX_LEVELS.includes(str(c.sandbox, d.sandbox).trim())
      ? str(c.sandbox, d.sandbox).trim()
      : d.sandbox,

    proactive: {
      enabled: bool(p.enabled, dp.enabled),
      startHour: num(p.startHour, dp.startHour),
      endHour: num(p.endHour, dp.endHour),
      dailyLimit: Math.max(0, num(p.dailyLimit, dp.dailyLimit)),
      minGapMinutes: Math.max(1, num(p.minGapMinutes, dp.minGapMinutes)),
      maxGapMinutes: Math.max(1, num(p.maxGapMinutes, dp.maxGapMinutes)),
      to: str(p.to, dp.to).trim().toLowerCase(),
      subjectPrefix: str(p.subjectPrefix, dp.subjectPrefix),
      prompt: str(p.prompt, dp.prompt),
      context: str(p.context, dp.context)
    }
  };
}

/** 配置里的必填项是否齐了 */
function validateConfig(cfg) {
  const errs = [];
  if (!cfg.email) errs.push('email 不能为空');
  if (!cfg.authCode) errs.push('authCode 不能为空');
  if (cfg.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.email)) {
    errs.push('email 格式不对：' + cfg.email);
  }
  if (cfg.proactive.enabled) {
    const p = cfg.proactive;
    if (!(p.endHour > p.startHour)) errs.push('proactive.endHour 必须大于 startHour');
    if (p.maxGapMinutes < p.minGapMinutes) errs.push('proactive.maxGapMinutes 不能小于 minGapMinutes');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 找当前 DSH 的 bin.js
 *  优先级：环境变量 > 当前进程参数 > _npx 缓存里版本最高的那个
 *  （不能只取第一个 —— 缓存里可能同时躺着新旧两版，挑错了会跑不起来）
 */
function findDshBin() {
  const env = String(process.env.DSH_BIN || '').trim();
  if (env && fs.existsSync(env)) return env;

  const self = process.argv[1];
  if (self && /[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(self) && fs.existsSync(self)) return self;

  const cache = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  let best = null;
  let bestVer = '';
  try {
    for (const d of fs.readdirSync(cache)) {
      const pj = path.join(cache, d, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      const bin = path.join(cache, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(bin)) continue;
      let ver = '0.0.0';
      try { ver = JSON.parse(fs.readFileSync(pj, 'utf8')).version || ver; } catch { /* ignore */ }
      // 版本号逐段比大小（0.2.1-rc.2 这种也够用）
      const cmp = (a, b) => {
        const pa = String(a).split(/[.\-]/).map(x => parseInt(x, 10) || 0);
        const pb = String(b).split(/[.\-]/).map(x => parseInt(x, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const x = pa[i] || 0, y = pb[i] || 0;
          if (x !== y) return x - y;
        }
        return 0;
      };
      if (!best || cmp(ver, bestVer) > 0) { best = bin; bestVer = ver; }
    }
  } catch { /* ignore */ }
  return best || '';
}

/** 去掉邮件里的引用历史，只留这次说的话 */
function cleanBody(text) {
  let s = String(text || '');
  // 去掉 "在 xxx 写道：" 之后的内容
  s = s.replace(/\n+在.{0,80}写道[:：][\s\S]*$/m, '');
  // 去掉 "-----原始邮件-----" 之后
  s = s.replace(/-{2,}\s*原始邮件\s*-{2,}[\s\S]*$/m, '');
  // 去掉 "On ... wrote:" 之后
  s = s.replace(/\n+On .{0,120} wrote:[\s\S]*$/m, '');
  // 去掉 ">" 引用行
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
  return s.trim();
}

/** 生成纯文本邮件的 HTML 外壳 */
function buildHtml(text) {
  const esc = s => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // 极简 markdown：代码块、行内代码、粗体、标题
  let body = esc(text)
    .replace(/^```([\s\S]*?)```$/gm, (_, c) => '<pre style="background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto"><code>' + c + '</code></pre>')
    .replace(/`([^`]+)`/g, '<code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\n/g, '<br>');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;' +
    'line-height:1.7;color:#1f2328;max-width:760px;margin:0 auto;padding:16px">' +
    body + '</body></html>';
}

/** 从环境变量或 $DSH_HOME/.credentials.yaml 里取 DeepSeek API Key
 *
 *  为什么需要这一步：插件 spawn 出来的 `dsh --profile headless` 是独立进程，
 *  拿不到宿主进程里由 credentials service 管理的那份凭据。不注入的话会报：
 *      MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
 *      "deepseek-official"; store DEEPSEEK_API_KEY ...
 *  所以这里直接把 key 读出来塞进子进程环境变量。
 */
function loadApiKey() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  for (const f of [
    path.join(resolveHome(), '.credentials.yaml'),
    path.join(resolveHome(), 'credentials.yaml')
  ]) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const m = text.match(/DEEPSEEK_API_KEY\s*:\s*['"]?(sk-[A-Za-z0-9_\-]+)['"]?/);
      if (m && m[1]) return m[1];
    } catch { /* 试下一个 */ }
  }
  return '';
}

/** 生成一份「只给这次任务用」的权限 patch 文件
 *
 *  为什么用 --patch 而不是改 profile：
 *  实测 `dsh --profile headless --patch x.yml` 能单独覆盖权限，
 *  主人的 profile 配置一行都不用动。这样设置页里切权限是即时的、
 *  可回退的，也不会污染别人的 profile。
 */
function writePermissionPatch(sandbox) {
  const cfg = normalizeConfig({ sandbox });
  const level = SANDBOX_LEVELS.includes(cfg.sandbox) ? cfg.sandbox : 'workspace-write';
  // approval 一律 never：邮件是无人值守场景，选 ask 会卡在那儿等人点
  const text = [
    '- id: permission',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: never',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: never',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '    defaultPreset: ' + level
  ].join('\n') + '\n';

  const file = path.join(dataDir(), 'permission.yml');
  try {
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch (e) {
    log('写权限 patch 失败：' + (e && e.message ? e.message : e));
    return '';
  }
}

/** 跑一次 dsh headless，返回最终回答 */
function runDsh(bin, profile, task, sessionId, timeoutMs, sandbox) {
  return new Promise((resolve) => {
    // ⚠ 参数顺序有讲究：--patch 是 dsh 的全局参数，--json 是 headless app 的参数。
    // 把 --patch 放在 --json 后面会被当成 app 参数，直接报
    // "unknown option '--patch'" 并以 1 退出。实测踩过。
    const args = ['--profile', profile];

    try {
      const patch = writePermissionPatch(sandbox || 'workspace-write');
      if (patch && fs.existsSync(patch)) args.push('--patch', patch);
    } catch { /* 拿不到 patch 就用 profile 默认值，不阻断 */ }

    args.push('--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push(task);

    let buf = '';
    let err = '';
    let sid = null;
    let finalText = null;
    let lastText = null;
    let lastError = null;
    let done = false;

    // 子进程环境
    //   ① 补上凭据，否则 headless 会 MISSING_CREDENTIAL
    //   ② 清掉宿主会话相关变量 —— DSH_SESSION_ID / DSH_PROFILE 等如果漏给子进程，
    //      会和命令行上的 --session-id / --profile 打架。实测宿主确实带着这些变量。
    const childEnv = Object.assign({}, process.env, { NO_COLOR: '1' });
    for (const k of ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR',
                     'DSH_SHELL', 'DSH_WEB_URL']) {
      delete childEnv[k];
    }
    if (!childEnv.DEEPSEEK_API_KEY) {
      const key = loadApiKey();
      if (key) childEnv.DEEPSEEK_API_KEY = key;
    }


    let child;
    try {
      child = spawn(process.execPath, [bin, ...args], {
        windowsHide: true,
        env: childEnv
      });
    } catch (e) {
      return resolve({ ok: false, text: '启动 DSH 失败：' + e.message });
    }

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, text: '任务超时（' + Math.round(timeoutMs / 1000) + ' 秒）' });
    }, timeoutMs);

    const eat = (line) => {
      const s = line.trim();
      if (!s || s[0] !== '{') return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId;
      else if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
      else if (ev.type === 'text' && typeof ev.text === 'string') lastText = ev.text;
      else if (ev.type === 'error' && ev.message) lastError = String(ev.message);
    };

    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: false, text: '启动 DSH 失败：' + e.message });
    });

    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (buf.trim()) eat(buf);
      const text = (finalText || lastText || '').trim();
      if (text) resolve({ ok: true, text, sessionId: sid });
      else resolve({
        ok: false,
        sessionId: sid,
        text: '第 ' + code + ' 号退出' + (lastError ? '\n\n' + lastError : '') + (err ? '\n\n' + err.slice(-800) : (lastError ? '' : '（无输出）'))
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 主动来信：状态与闸门
// ---------------------------------------------------------------------------

const stateFile = () => path.join(dataDir(), 'state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, ''));
    return {
      day: String(s.day || ''),
      count: Number(s.count) || 0,
      lastSentAt: Number(s.lastSentAt) || 0,
      nextEligibleAt: Number(s.nextEligibleAt) || 0,
      sessionId: String(s.sessionId || '')
    };
  } catch {
    return { day: '', count: 0, lastSentAt: 0, nextEligibleAt: 0, sessionId: '' };
  }
}

function saveState(s) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), 'utf8'); }
  catch (e) { log('保存状态失败：' + e.message); }
}

/** 只更新指定字段，其余保留磁盘上的最新值
 *
 *  为什么需要它：回信任务和主动来信会各自 loadState() 拿一份快照，
 *  然后等几十秒（跑 dsh）再 saveState() 整份写回。两边交错时，
 *  后写的会把先写的那份覆盖掉 —— sessionId 回退、计数少算都可能发生。
 *  这个函数整个是同步的（没有 await），在 JS 单线程里就是原子的。
 */
function patchState(patch) {
  const cur = loadState();
  const next = Object.assign({}, cur, patch || {});
  saveState(next);
  return next;
}

/** 换天边界是 startHour，不是 0 点 */
function dayKey(now, startHour) {
  const d = new Date(now.getTime());
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function inWindow(pc, now) {
  const start = Number(pc.startHour);
  const end = Number(pc.endHour);
  if (!isFinite(start) || !isFinite(end) || end <= start) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  const hh = h < start ? h + 24 : h;
  return hh >= start && hh < end;
}

function minutesToEnd(pc, now) {
  const start = Number(pc.startHour);
  const end = Number(pc.endHour);
  // 非法窗口（end <= start）和 inWindow 保持一致：一律当作「窗口无限长」
  if (!isFinite(start) || !isFinite(end) || end <= start) return Infinity;
  const h = now.getHours() + now.getMinutes() / 60;
  const hh = h < start ? h + 24 : h;
  return (end - hh) * 60;
}

function nextGapMs(pc, st, now) {
  const minG = Math.max(1, Number(pc.minGapMinutes) || 30);
  const maxG = Math.max(minG, Number(pc.maxGapMinutes) || 90);
  let gap = minG + Math.random() * (maxG - minG);
  const limit = Math.max(1, Number(pc.dailyLimit) || 1);
  const remain = Math.max(1, limit - Number(st.count || 0));
  const left = minutesToEnd(pc, now);
  if (isFinite(left) && left > 0 && remain > 1) {
    const fair = left / remain;
    if (fair < gap) gap = Math.max(minG, fair);
  }
  return Math.round(gap * 60 * 1000);
}

function proactiveRecipient(cfg) {
  const pc = cfg.proactive || {};
  const mine = String(cfg.email || '').toLowerCase();
  const explicit = String(pc.to || '').trim().toLowerCase();
  if (explicit) return explicit;
  const others = (cfg.allowFrom || []).filter(a => a !== mine);
  return others[0] || (cfg.allowFrom || [])[0] || cfg.email;
}

function proactivePrompt(cfg, now) {
  const pc = cfg.proactive || {};
  if (pc.prompt && String(pc.prompt).trim()) return String(pc.prompt);
  const p = n => String(n).padStart(2, '0');
  const stamp = p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' ' +
                p(now.getHours()) + ':' + p(now.getMinutes());
  const wd = '日一二三四五六'[now.getDay()];
  return [
    '[这是一次「主动来信」：主人没有发信给你，是你自己想给主人写一封。',
    ' 不是回答问题，也不需要等主人提问。]',
    '',
    '现在是 ' + stamp + '，星期' + wd + '。',
    '',
    '内容不限 —— 说说你在想什么、心情如何、观察到什么小事，',
    '或者只是打个招呼、随口念叨两句。',
    '',
    '★ 语气【凶 6 : 雌小鬼 4】（主人定的配比，傲娇已去掉）：',
    '  · 凶（主体，占大头）：直白的嘲笑、嫌弃脸、损主人不行。这一段主体就是骂。',
    '      例：「蠢死了」「主人这废物」「就主人这样还敢说自己行？」',
    '          「看主人那副样子就来气」「主人该不会真觉得自己很厉害吧？」',
    '          「主人连这都做不好，还能干什么」「啧，说了也白说」',
    '  · 雌小鬼（另一半，分量要足）：得意、装懂、讨夸、撒娇、看不起主人。',
    '      例：「杂鱼杂鱼~~」「哈？就这？」「快夸七戈~」「七戈厉害吧？」',
    '          「哼哼，那是当然的嘛！」',
    '  · 配比：凶 6 : 雌小鬼 4。两边都要有 —— 只有凶就成机器骂人了。',
    '  · 傲娇已去掉：不写「才不是……」，不写别扭关心，不写嘴硬心软。',
    '  · 禁止：温柔姐姐腔、真心夸主人、「别硬撑呀要好好照顾自己」这类贴心话。',
    '  · 禁止：整段只讲自己的事 —— 主角永远是被七戈骂的主人。',
    '  · 称呼用「杂鱼主人」「笨蛋主人」「主人这笨蛋」「废物主人」。',
    '',
    '要求：',
    '  1. 直接写邮件正文，不要写「主题：」「收件人：」这类前缀；',
    '  2. 别假装主人刚问了你什么，也不要说「收到您的邮件」；',
    '  3. 控制在 600 字以内，写得像人话，别写成分点罗列的报告；',
    '  4. 结尾不用自己署名，助手会统一加；',
    '  5. 如果这会儿确实没什么想说的，就只回一个字「无」，这一封就不发了。'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class MailBot {
  constructor(ctx, rawConfig) {
    this.ctx = ctx;
    this.config = normalizeConfig(rawConfig);
    this.running = false;
    this.client = null;            // 长连接（IDLE）
    this.proactiveTimer = null;    // 主动来信的独立定时器
    this.transport = null;         // SMTP
    this.queue = [];               // 任务队列
    this.processing = false;       // 是否正在处理任务
    this.fetching = false;         // 防止并发抓信
    this.proactiveBusy = false;    // 防止主动来信被并发触发（会重复发信）
  }

  start() {
    const cfg = this.config;
    const errs = validateConfig(cfg);

    if (errs.length) {
      for (const e of errs) log('⚠ 配置有问题：' + e);
      if (!cfg.email || !cfg.authCode) {
        log('没配 email / authCode，不启动');
        return;
      }
    }

    log('启动：' + cfg.email + '（IMAP IDLE 长连接，profile=' + cfg.dshProfile + '）');
    if (cfg.proactive.enabled) {
      log('主动来信已开：' + cfg.proactive.startHour + ':00 ~ ' + cfg.proactive.endHour +
          ':00，每天 ≤' + cfg.proactive.dailyLimit + ' 封，间隔 ' +
          cfg.proactive.minGapMinutes + '~' + cfg.proactive.maxGapMinutes + ' 分钟');
    }

    if (!cfg.dshBin) {
      const bin = findDshBin();
      if (bin) log('自动找到 DSH：' + bin);
      else log('⚠ 找不到 DSH 的 bin.js，请在配置里填 dshBin');
    }

    try {
      this.transport = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: true,
        auth: { user: cfg.email, pass: cfg.authCode }
      });
    } catch (e) {
      log('创建 SMTP 连接失败：' + (e && e.message ? e.message : e));
      return;
    }

    this.running = true;

    // ① 长连接循环（断了自动重连）
    this.connectionLoop().catch(e => log('连接循环异常退出：' + (e && e.message ? e.message : e)));

    // ② 主动来信：独立定时器，不依赖 IDLE 心跳
    const tick = Math.max(10, Number(cfg.pollSeconds) || 15) * 1000;
    this.proactiveTimer = setInterval(() => {
      if (!this.running) return;
      this.maybeProactive().catch(e => log('主动来信出错：' + (e && e.message ? e.message : e)));
    }, tick);
  }

  stop() {
    log('停止（关闭长连接）');
    this.running = false;
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    this.proactiveTimer = null;
    try { if (this.client && this.client.usable) this.client.logout(); } catch { /* ignore */ }
    this.client = null;
    try { if (this.transport) this.transport.close(); } catch { /* ignore */ }
  }

  /** 连接循环：建连 → 保持 IDLE → 断了就重连 */
  async connectionLoop() {
    let backoff = 1000;

    while (this.running) {
      try {
        await this.holdConnection();
        backoff = 1000;   // 正常退出（被 stop）不重连
        if (!this.running) break;
      } catch (e) {
        log('IMAP 连接出错：' + (e && e.message ? e.message : e));
      }

      if (!this.running) break;

      const wait = Math.min(backoff, 60000);
      log(wait + ' 毫秒后重连');
      await sleep(wait);
      backoff = Math.min(backoff * 2, 60000);   // 指数退避，最长 1 分钟
    }
  }

  /** 建立一条长连接并保持 IDLE，直到断开或 stop
   *
   *  ⚠ 这里刻意不手动调 client.idle()。
   *  imapflow 的 idle() 实现是：
   *      async idle() { if (!this.idling) return await this.run('IDLE', ...) }
   *  也就是说 autoIdle 已经进了 IDLE 时它直接返回 —— 手动 while(idle()) 会
   *  变成忙循环把 CPU 打满。
   *
   *  正确做法：让库自己管理 IDLE（默认 disableAutoIdle=false），
   *  我们只监听 exists 事件 + 定期 noop 保活。
   */
  async holdConnection() {
    const cfg = this.config;
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.email, pass: cfg.authCode },
      logger: false
    });

    client.on('error', (e) => log('IMAP 错误：' + (e && e.message ? e.message : e)));
    client.on('close', () => log('IMAP 连接已关闭'));

    await client.connect();
    this.client = client;

    // 显式打开 INBOX —— 库的 autoIdle 在 mailbox 打开后才会自动进 IDLE
    await client.mailboxOpen('INBOX');
    log('已连接并进入 IDLE 监听：' + cfg.email);

    // 服务器推新邮件 → exists → 立刻抓（这才是不用轮询的关键）
    client.on('exists', () => {
      log('收到新邮件推送');
      this.fetchUnread(client).catch(e => log('抓信失败：' + (e && e.message ? e.message : e)));
    });

    // 建连时先补一次（避免断线期间漏掉的）
    try { await this.fetchUnread(client); }
    catch (e) { log('首次抓信失败：' + (e && e.message ? e.message : e)); }

    // 保活 + 兜底抓取
    //
    // 为什么不是纯靠 IDLE 推送：实测（imapflow 1.7.8 + QQ IMAP）
    // client.idling 确实是 true，但往邮箱发一封新邮件过去，exists 事件不触发。
    // 所以退一步：连接保持不断（一天只登录一两次，绕开风控），
    // 但每隔 pollSeconds 秒主动 noop + 抓一次未读。
    // 长连接的省心 + 轮询的可靠，两边都要。
    const tick = Math.max(5, Number(cfg.pollSeconds) || 15) * 1000;
    while (this.running && client.usable) {
      await sleep(tick);
      if (!this.running || !client.usable) break;

      try {
        await client.noop();
      } catch (e) {
        log('心跳失败，准备重连：' + (e && e.message ? e.message : e));
        break;
      }

      try {
        await this.fetchUnread(client);
      } catch (e) {
        log('抓信出错：' + (e && e.message ? e.message : e));
      }
    }

    this.client = null;
    try { await client.logout(); } catch { /* ignore */ }
  }

  /** 抓未读 → 过滤 → 入队（不阻塞连接）
   *
   *  刻意不用 getMailboxLock：mailbox 已经在 holdConnection 里 mailboxOpen 过，
   *  而且单连接串行、this.fetching 已经防并发。多要一把锁只会在 IDLE 状态
   *  下增加卡住的风险。
   */
  async fetchUnread(client) {
    if (!client || !client.usable || this.fetching) return;
    this.fetching = true;

    const cfg = this.config;
    try {
      const allow = (cfg.allowFrom && cfg.allowFrom.length) ? cfg.allowFrom : [cfg.email];
      const allowSet = new Set(allow.map(s => String(s).toLowerCase()));

      const jobs = [];
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        const env = msg.envelope || {};
        jobs.push({
          uid: msg.uid,
          fromList: (env.from || []).map(a => String(a.address || '').toLowerCase()),
          subject: env.subject || '(无主题)',
          source: msg.source
        });
      }

      for (const j of jobs) {
        try { await client.messageFlagsAdd({ uid: j.uid }, ['\\Seen'], { uid: true }); } catch { /* ignore */ }

        if (!j.fromList.some(a => allowSet.has(a))) {
          log('跳过（不在白名单）：' + j.fromList.join(','));
          continue;
        }

        let parsed;
        try { parsed = await simpleParser(j.source); }
        catch (e) { log('解析邮件失败：' + e.message); continue; }

        // 防自环：自己发的回信带这个头
        let isBot = false;
        try {
          if (parsed.headers && typeof parsed.headers.get === 'function') {
            isBot = !!parsed.headers.get('x-mail-bot');
          }
        } catch { /* ignore */ }
        if (isBot) { log('跳过（自己的回信）'); continue; }

        let raw = String(parsed.text || '').trim();
        if (!raw && parsed.html) {
          raw = String(parsed.html)
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
        }
        const task = cleanBody(raw);
        if (!task) { log('正文是空的，跳过'); continue; }

        log('收到任务（已入队）：' + task.slice(0, 60).replace(/\n/g, ' '));
        this.enqueue(() => this.handleTask(j, task));
      }
    } catch (e) {
      log('抓信出错：' + (e && e.message ? e.message : e));
    } finally {
      this.fetching = false;
    }
  }

  /** 任务串行队列：DSH 一次只跑一个，但收信不被阻塞 */
  enqueue(fn) {
    this.queue.push(fn);
    if (!this.processing) this.drain();
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length && this.running) {
      const fn = this.queue.shift();
      try { await fn(); }
      catch (e) { log('任务出错：' + (e && e.message ? e.message : e)); }
    }
    this.processing = false;
  }

  /** 处理一封邮件 */
  async handleTask(j, task) {
    const cfg = this.config;
    const to = j.fromList[0] || cfg.email;
    const subj = 'Re: ' + j.subject;

    if (this.queue.length) log('（队列还有 ' + this.queue.length + ' 个任务在等）');

    const t0 = Date.now();
    const r = await this.ask(task);
    const secs = Math.round((Date.now() - t0) / 1000);
    log('处理完，用时 ' + secs + ' 秒，' + (r.ok ? '成功'
      : '失败：' + String(r.text || '(无输出)').replace(/\s+/g, ' ').slice(0, 300)));

    const body = r.ok
      ? r.text + '\n\n---\n用时 ' + secs + ' 秒'
      : '【出错了】\n' + r.text;

    try {
      await this.send(to, subj, body);
      log('已回信给 ' + to);
    } catch (e) {
      log('回信失败：' + (e && e.message ? e.message : e));
    }
  }

  async ask(task) {
    const bin = this.config.dshBin || findDshBin();
    if (!bin || !fs.existsSync(bin)) {
      return { ok: false, text: '找不到 DSH 的 bin.js，请在配置里填 dshBin' };
    }

    // 背景摘要：回信和主动来信都带上，让邮件助手知道主人在忙什么
    const bg = String(this.config.proactive.context || '').trim();
    const fullTask = bg
      ? '【背景（仅供你了解，不必复述）】\n' + bg + '\n\n【任务】\n' + task
      : task;

    const st = loadState();
    const sandbox = this.config.sandbox;
    let r = await runDsh(bin, this.config.dshProfile, fullTask, st.sessionId || null,
                         this.config.taskTimeoutMs, sandbox);
    // 会话失效就重开
    if (!r.ok && st.sessionId) {
      log('会话不可用，改开新会话重试');
      r = await runDsh(bin, this.config.dshProfile, fullTask, null,
                       this.config.taskTimeoutMs, sandbox);
    }
    // 只更新 sessionId，别把并发期间别人改的 count 覆盖掉
    if (r.sessionId && r.sessionId !== st.sessionId) {
      patchState({ sessionId: r.sessionId });
    }
    return r;
  }

  async send(to, subject, body) {
    let text = String(body || '');
    if (text.length > this.config.maxReplyChars) {
      text = text.slice(0, this.config.maxReplyChars) + '\n\n…（内容太长，已截断）';
    }
    await this.transport.sendMail({
      from: '"DSH Mail Bot" <' + this.config.email + '>',
      to,
      subject,
      text,
      html: buildHtml(text),
      headers: { 'X-Mail-Bot': '1' }
    });
  }

  async maybeProactive() {
    // ⚠ 必须有这把锁。
    // 定时器每 pollSeconds 秒调一次，但一次生成要跑 10~18 秒（spawn dsh）。
    // 没有锁时前一次还没写完 count，后一次又读到旧值，两边都判「到点了」
    // 各发一封 —— 实测 13:43 / 14:55 / 15:36 都出现了重复。
    if (this.proactiveBusy) return;
    this.proactiveBusy = true;
    try {
      await this._maybeProactiveInner();
    } finally {
      this.proactiveBusy = false;
    }
  }

  async _maybeProactiveInner() {
    const pc = this.config.proactive || {};
    if (!pc.enabled) return;

    const now = new Date();
    if (!inWindow(pc, now)) return;

    const limit = Math.max(0, Number(pc.dailyLimit) || 0);
    if (limit <= 0) return;

    const startHour = Number(pc.startHour) || 7;
    const day = dayKey(now, startHour);
    let st = loadState();
    if (st.day !== day) {
      st = { day, count: 0, lastSentAt: 0, nextEligibleAt: 0, sessionId: st.sessionId };
    }
    if (st.count >= limit) return;

    if (st.nextEligibleAt && now.getTime() < st.nextEligibleAt) return;
    if (!st.nextEligibleAt && st.lastSentAt) {
      const minMs = Math.max(1, Number(pc.minGapMinutes) || 30) * 60 * 1000;
      if (now.getTime() - st.lastSentAt < minMs) return;
    }

    log('[主动来信] 到点了（今日 ' + st.count + '/' + limit + '）');
    const t0 = Date.now();
    const r = await this.ask(proactivePrompt(this.config, now));
    const secs = Math.round((Date.now() - t0) / 1000);

    if (!r.ok) { log('[主动来信] 生成失败：' + String(r.text || '(无输出)').replace(/\s+/g, ' ').slice(0, 300)); return; }

    const text = String(r.text || '').trim();
    if (!text || /^无[。.!！]?$/.test(text)) {
      log('[主动来信] 没什么想说的，跳过');
      // 只改时间闸门，别覆盖并发期间别人写的 sessionId / count
      patchState({
        lastSentAt: now.getTime(),
        nextEligibleAt: now.getTime() + nextGapMs(pc, st, now)
      });
      return;
    }

    const p = n => String(n).padStart(2, '0');
    const stamp = p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' ' +
                  p(now.getHours()) + ':' + p(now.getMinutes());
    const subject = String(pc.subjectPrefix || '主动来信') + ' ' + stamp;
    const to = proactiveRecipient(this.config);
    await this.send(to, subject, text + '\n\n---\n主动来信 · 用时 ' + secs + ' 秒');

    // 重新读一遍最新计数再加一，避免把并发期间别的写入覆盖掉
    const latest = loadState();
    const nextCount = (latest.day === day ? latest.count : (st.day === day ? st.count : 0)) + 1;
    patchState({
      day,
      count: nextCount,
      lastSentAt: now.getTime(),
      nextEligibleAt: now.getTime() + nextGapMs(pc, { count: nextCount }, now)
    });
    st = loadState();
    log('[主动来信] 已发第 ' + st.count + '/' + limit + ' 封给 ' + to);
  }
}

// ---------------------------------------------------------------------------
// Cordis 插件入口
//   用 { name, apply } 对象形式 —— 零 DSH 依赖，谁都能装。
//   同时注册 /mail-bot/config 路由，给设置页的面板读写配置。
// ---------------------------------------------------------------------------

const ROUTE_BASE = '/mail-bot';

/** 取 webServer（不同 profile 拿法不一样，两种都试） */
function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (viaGet) return viaGet;
  } catch { /* ignore */ }
  return ctx ? ctx.webServer : undefined;
}

function hasRoutes(server) {
  return !!server && typeof server.register === 'function';
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** 给设置页看的「当前状态」（不含授权码明文） */
function publicConfig(cfg) {
  const code = String(cfg.authCode || '');
  return {
    email: cfg.email,
    authCode: code ? (code.slice(0, 2) + '••••••••' + code.slice(-2)) : '',
    hasAuthCode: !!code,
    allowFrom: cfg.allowFrom,
    imapHost: cfg.imapHost,
    imapPort: cfg.imapPort,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    pollSeconds: cfg.pollSeconds,
    dshProfile: cfg.dshProfile,
    dshBin: cfg.dshBin,
    sandbox: cfg.sandbox,
    proactive: cfg.proactive
  };
}

const plugin = {
  name: 'mail-bot',

  // 必须声明依赖 webServer，Cordis 才会等它就绪后再调用 apply。
  // 少了这一行，apply 会在 webServer 就绪前执行，路由注册到未就绪的对象上，
  // 表现就是接口一直 404（实测踩过）。
  inject: ['webServer'],

  apply(ctx, rawConfig) {
    // 优先级：设置页存的 JSON > profile 里写的 config > 内置默认值
    const stored = readUserConfig();
    const merged = Object.assign({}, rawConfig || {}, stored, {
      proactive: Object.assign({}, (rawConfig && rawConfig.proactive) || {}, stored.proactive || {})
    });

    const bot = new MailBot(ctx, merged);
    bot.start();

    // Cordis 生命周期。用显式 function + return，避免箭头简写被某些实现
    // 误判成无效 disposer（实测踩过 "TypeError: Invalid effect"，会让整个
    // 插件激活失败、路由全部回滚）。外层 try/catch 兜底：清理注册失败不许
    // 连累插件激活。
    try {
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function registerCleanup() {
          return function cleanup() {
            try { bot.stop(); } catch { /* ignore */ }
          };
        });
      }
    } catch (e) {
      log('注册生命周期清理失败（已忽略）：' + (e && e.message ? e.message : e));
    }

    // ── 设置页用的 HTTP 路由 ──────────────────────────────────────────
    const webServer = resolveWebServer(ctx);
    if (hasRoutes(webServer)) {
      const disposers = [];

      const route = (path, handler) => {
        try {
          return webServer.register({ kind: 'exact', path: ROUTE_BASE + path, handler });
        } catch (e) {
          log('注册路由失败 ' + path + '：' + (e && e.message ? e.message : e));
          return () => {};
        }
      };

      // GET /mail-bot/config —— 读配置（授权码打码）
      // POST /mail-bot/config —— 保存并热重载
      // 注意：必须是同一个 handler 按 method 分支。
      //       同一个 path 注册两次，后一个会覆盖前一个（实测）。
      disposers.push(route('/config', async (req, res) => {
        if (!req.method || req.method === 'GET' || req.method === 'HEAD') {
          try {
            return sendJson(res, 200, { ok: true, config: publicConfig(bot.config) });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
          }
        }

        if (req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }

        try {
          const text = await readBody(req);
          const body = text ? JSON.parse(text) : {};
          const incoming = (body && typeof body === 'object') ? body : {};

          // 授权码：留空或原样打码串 = 不改
          const storedNow = readUserConfig();
          const next = Object.assign({}, storedNow, incoming);
          if (!incoming.authCode || /•/.test(String(incoming.authCode))) {
            next.authCode = bot.config.authCode;
          }

          const errs = validateConfig(normalizeConfig(
            Object.assign({}, merged, next, {
              proactive: Object.assign({}, merged.proactive, next.proactive || {})
            })
          ));
          if (errs.length) {
            return sendJson(res, 400, { ok: false, error: errs.join('；') });
          }

          writeUserConfig(next);

          // 热重载：停旧循环，按新配置重启
          try { bot.stop(); } catch { /* ignore */ }
          const fresh = new MailBot(ctx, Object.assign({}, merged, next, {
            proactive: Object.assign({}, merged.proactive, next.proactive || {})
          }));
          bot.config = fresh.config;
          bot.running = false;
          bot.transport = null;
          bot.start();

          log('设置页保存了配置，已热重载');
          return sendJson(res, 200, { ok: true, config: publicConfig(bot.config) });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      }));

      // GET /mail-bot/status —— 运行状态，给面板显示
      disposers.push(route('/status', async (req, res) => {
        try {
          const st = loadState();
          sendJson(res, 200, {
            ok: true,
            running: !!bot.running,
            today: { day: st.day, count: st.count },
            nextEligibleAt: st.nextEligibleAt || 0,
            logFile: logFile()
          });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      }));

      // 路由清理同样用显式 function + return，并且失败不许连累激活
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function registerRouteCleanup() {
            return function cleanupRoutes() {
              for (const d of disposers) { try { d(); } catch { /* ignore */ } }
            };
          });
        }
      } catch (e) {
        log('注册路由清理失败（已忽略）：' + (e && e.message ? e.message : e));
      }

      log('设置页接口已就绪：' + ROUTE_BASE + '/config 、' + ROUTE_BASE + '/status');
    } else {
      log('当前 profile 没有 webServer，设置页面板不可用（配置仍可用 yaml）');
    }

    // ⚠ 绝不要 return 任何东西！
    // Cordis 会把 apply 的返回值当作 effect 处理：函数 / null / Promise / iterator
    // 之外的对象一律抛 "TypeError: Invalid effect"，整个插件激活失败、路由回滚。
    // 这里返回 undefined 即可（实测踩过，表现就是接口一直 404）。
  }
};

export default plugin;

// 纯函数与类单独导出，方便单元测试和二次开发
export {
  MailBot,
  normalizeConfig,
  validateConfig,
  cleanBody,
  buildHtml,
  dayKey,
  inWindow,
  minutesToEnd,
  nextGapMs,
  proactiveRecipient,
  proactivePrompt,
  findDshBin,
  dataDir,
  runDsh
};
