# dsh-mail-bot

用**邮件**遥控 [DeepSeek Harness](https://github.com/deepseek-ai) 干活的插件。

手机发一封邮件过去，DSH 跑完把结果回信给你。还能让它在设定的时间窗里**主动给你写信**。

---

## 它做什么

```
你（手机） ──发邮件──▶ QQ/其他邮箱
                          │
                   IMAP 长连接常驻
                   （每 pollSeconds 秒查一次新信）
                          │
                  白名单校验 + 去引用
                          │
                dsh --profile <你的> --json
                   --patch 权限文件（每次任务单独设）
                          │
                    SMTP 回信 ◀── 结果
```

**特点：**

- **长连接**：一条 IMAP 连接常驻，一天只登录一两次，绕开邮箱风控；新信靠定间隔主动查（实测纯 IDLE 推送在 QQ 邮箱上不触发，所以留了主动查兜底）
- **任务排队**：DSH 跑任务的时候照样能收新信，跑完一封接着下一封
- **断线自动重连**：指数退避 1s → 60s，断网恢复后自己接上
- **权限可调**：设置页里三档，每次任务走 `--patch`，不改宿主 profile
- **背景摘要**：可以让它知道你在忙什么，几百字，不炸上下文
- 会话保持：同一个对话接着聊，上下文不丢
- 防自环：自己发的回信带 `X-Mail-Bot: 1`，不会被当成新任务
- 白名单：只认你允许的邮箱
- 主动来信：到点自己写，有每日上限和随机间隔

---

## 安装

### 从 tgz 包（最省事）

```bash
dsh plugin --profile web add ./dsh-mail-bot-0.1.0.tgz
```

### 从本地目录（开发用）

```bash
dsh plugin --profile web add link:/path/to/dsh-mail-bot
```

Windows 上路径写成 `link:D:\path\to\dsh-mail-bot`。

### 从 npm（发布之后）

```bash
dsh plugin --profile web add dsh-mail-bot
```

**装完必须重启 DSH**，插件才会加载。

### 卸载

```bash
dsh plugin --profile web remove dsh-mail-bot
```

### 装完怎么确认

启动 DSH 后看日志（`$DSH_HOME/mail-bot/mail-bot.log`），应该出现：

```
[mail-bot] 启动：你的邮箱（IMAP IDLE 长连接，profile=headless）
[mail-bot] 设置页接口已就绪：/mail-bot/config 、/mail-bot/status
[mail-bot] 已连接并进入 IDLE 监听：你的邮箱
```

**三条都出现 = 装好了。**

---

## 兼容性

**零 DSH 内部依赖。**

插件用 Cordis 支持的 `{ name, apply }` 对象形式，只用 Node 内置模块（`fs`/`path`/`os`/`child_process`）加上三个邮件库（`imapflow` / `mailparser` / `nodemailer`）。

所以：

- 不需要 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 之类的 peer 依赖
- DSH 升级到新版本，插件不用跟着改
- `pnpm` 严格模式下也能正常解析

配置校验是手写的（`normalizeConfig` / `validateConfig`），不依赖 schemastery。缺字段、类型不对、间隔上下限颠倒，都会在启动日志里报出来，不会静默失败。


---

## 配置

有两种方式，**任选其一**：

| 方式 | 适合 | 改完何时生效 |
|---|---|---|
| **设置页里填表**（推荐） | 大多数人 | 点保存立刻热重载 |
| **改 profile 的 yaml** | 批量部署 / 没有 Web UI | 重启 DSH |

**设置页优先。** 两边都写了，设置页的 `~/.dsh/mail-bot.json` 覆盖 yaml。

---

## 方式一：设置页（推荐）

装好插件、重启 DSH 后：

```
DSH → 设置 → 邮件助手
```

会看到一块表单，直接填：

- **邮箱地址**
- **授权码**（已设置的显示成 `tr••••••••ai`，不填就是不改）
- **白名单**（一行一个）
- **服务器**（IMAP/SMTP 主机端口，默认 QQ 邮箱）
- **轮询间隔**
- **跑任务的 profile**
- **主动来信**（开关、时间窗、每日上限、随机间隔、主题前缀）

**点「保存」立刻生效**，不用重启。

面板还会显示运行状态：是否在轮询、今天已发几封、下一封什么时候、日志文件在哪。

### 背后干的活

```
GET  /mail-bot/config    读配置（授权码打码返回，不落明文到前端）
POST /mail-bot/config    保存 + 校验 + 热重载
GET  /mail-bot/status    运行状态
```

配置存在 `~/.dsh/mail-bot.json`，刻意不走 DSH 的 settings 命名空间 —— 这样 DSH 升级不会把配置弄丢（跟 `dsh-startup-screen` 同款做法）。

---

## 方式二：改 yaml

配置写在 **profile 的用户层**：

```
~/.dsh/profiles/<profile>/cordis.patch.yml
```

Windows 上是 `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`。

### 最小配置（只填三项）

```yaml
- id: dsh-mail-bot
  config:
    email: your@qq.com
    authCode: '你的16位授权码'
    allowFrom:
      - your@qq.com
```

**其他字段全都会用默认值补齐**，不用写全。

> ⚠️ 有个坑：用户层配置是**整体替换**，不是深度合并。
>
> 也就是说，你在用户层只写了 `email`，那插件自带的默认配置树会被你这份**完全顶掉**。
>
> 不过插件内部有 `normalizeConfig()` 兜底 —— 每个字段都会回落到默认值，所以**只填必填项也能正常跑**。这一点是专门验证过的。

### 完整配置（要改什么就写什么）

```yaml
- id: dsh-mail-bot
  config:
    email: your@qq.com
    authCode: '你的16位授权码'
    allowFrom:
      - your@qq.com
      - 另一个允许的@qq.com

    imapHost: imap.qq.com
    imapPort: 993
    smtpHost: smtp.qq.com
    smtpPort: 465

    pollSeconds: 15
    taskTimeoutMs: 600000
    maxReplyChars: 40000

    dshBin: ''            # 留空自动找（会挑版本最高的那个）
    dshProfile: headless  # 用哪个 profile 跑任务

    proactive:
      enabled: false
      startHour: 7
      endHour: 25
      dailyLimit: 10
      minGapMinutes: 30
      maxGapMinutes: 90
      subjectPrefix: 主动来信
```



### 授权码怎么拿（QQ 邮箱）

```
QQ 邮箱网页版 → 设置 → 账户
  → POP3/IMAP/SMTP 服务 → 开启 IMAP/SMTP
  → 生成授权码（16 位，不是 QQ 密码）
```

### 其他邮箱

改这几个字段：

| 字段 | 说明 |
|---|---|
| `imapHost` / `imapPort` | 收信服务器（一般 993 + SSL） |
| `smtpHost` / `smtpPort` | 发信服务器（一般 465 + SSL） |

Gmail：`imap.gmail.com` / `smtp.gmail.com`（要用应用专用密码）
Outlook：`outlook.office365.com` / `smtp.office365.com`（587 STARTTLS，需改代码）

### 全部配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `email` | **必填** | 你自己的邮箱 |
| `authCode` | **必填** | 授权码 |
| `allowFrom` | `[]` | 白名单；空 = 只认 `email` 自己 |
| `imapHost` | `imap.qq.com` | |
| `imapPort` | `993` | |
| `smtpHost` | `smtp.qq.com` | |
| `smtpPort` | `465` | |
| `pollSeconds` | `15` | 每轮检查的间隔：查收件箱 + 查主动来信闸门。改大省资源，改小更快发现新信 |
| `taskTimeoutMs` | `600000` | 单任务超时（10 分钟） |
| `maxReplyChars` | `40000` | 回信正文上限 |
| `dshBin` | `''` | 留空自动找 |
| `dshProfile` | `headless` | 用哪个 profile 跑任务 |
| `sandbox` | `workspace-write` | 邮件任务的权限级别，见下 |

---

## 权限

邮件是**无人值守**场景，所以权限要单独说清楚。

插件 spawn 出去的每个任务都会带一份临时 patch：

```
dsh --profile <你的> --patch ~/.dsh/mail-bot/permission.yml
```

**只影响这次任务，不改你的 profile 配置。**

### 三档可选

| 档位 | 能做什么 | 适合 |
|---|---|---|
| `read-only` | 只能读，不能改任何文件 | 只想让它查资料 |
| **`workspace-write`**（默认） | 能读，能在工作目录里写，碰不了系统盘 | 大多数情况 |
| `danger-full-access` | 能读写任何位置，能跑任意命令 | 清楚风险再选 |

### ⚠ 关于 danger-full-access

选了这一档，意味着：

**任何能往你白名单邮箱发信的人，都能在你电脑上执行任意操作。**

所以：

- 白名单只填自己的地址，一个都别多加
- 那个邮箱的密码/授权码要当密码一样保管
- 不放心就一直用默认的 `workspace-write`

### 审批一律 never

邮件场景没人坐在电脑前点确认，所以 `approval` 固定为 `never`。

如果设成 `ask`，遇到需要审批的操作会卡在那里等人点，等于任务停摆。

---
## 主动来信

让它在指定时间窗里，自己给你写信。

```yaml
proactive:
  enabled: true
  startHour: 7          # 早上 7 点开始
  endHour: 25           # 次日凌晨 1 点结束（>24 表示跨天）
  dailyLimit: 10        # 每天最多 10 封
  minGapMinutes: 30     # 间隔下限
  maxGapMinutes: 90     # 间隔上限
  to: ''                # 收件人，留空 = 白名单里第一个不是自己的
  subjectPrefix: 主动来信
  prompt: ''            # 自定义提示词，留空用内置的
  context: ''           # 背景摘要，每次生成都带上（几百字以内，留空不带）
```

### 几个设计细节

- **换天边界是 `startHour`**，不是 0 点。所以 `startHour: 7` 时，凌晨 2 点算「昨天」。
- **间隔是随机的**，落在 `[minGap, maxGap]` 之间。
- **会自动收窄**：如果剩下时间不够发完剩余额度，间隔会被压向下限（但不会低于下限）。
- **返回「无」就跳过**：模型觉得没什么想说的，就不发这封，但会重新排下次时间。
- **状态存在 `$DSH_HOME/mail-bot/state.json`**，重启不丢。

---

## 状态与日志

```
$DSH_HOME/mail-bot/
├── state.json     # 会话 ID + 主动来信计数
└── mail-bot.log   # 运行日志
```

Windows 下 `$DSH_HOME` 一般是 `C:\Users\<你>\.dsh`。

---

## 常见问题

### 发信没反应

1. 看日志：`$DSH_HOME/mail-bot/mail-bot.log`
2. 检查 `allowFrom` 里有没有你的发件地址
3. 检查授权码对不对（不是登录密码）
4. QQ 邮箱要确认已开启 IMAP 服务

### 回信说「找不到 DSH 的 bin.js」

在配置里手动指定：

```yaml
dshBin: C:\Users\你\AppData\Local\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js
```

### 一直说「没配 email / authCode」

配置没生效。检查 profile 的 `cordis.patch.yml` 是不是真的插进去了：

```bash
dsh --profile web --dump-config
```

在输出里搜 `mail-bot`。

### ⚠ 别和独立版同时跑

如果你之前装过独立的邮箱助手脚本（比如用一个 `七戈邮箱助手.js`），**它和本插件会抢同一个邮箱**，导致同一封信回两遍。

要么停掉独立版，要么停掉插件。二选一。

---

## 开发

```bash
# 跑测试（不连邮箱）
node test/smoke.mjs
```

测试覆盖：引用剥离、HTML 转义、跨天边界、时间窗、随机间隔、收件人选择、提示词内容。

---

## 许可

MIT
