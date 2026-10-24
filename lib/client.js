/**
 * dsh-mail-bot — 浏览器半侧（设置页「邮件助手」）
 * ----------------------------------------------------------------------------
 * 以 dsh.client bundle 格式加载（手写 ModuleLoader bundle，无需构建）：
 * 在 DSH 设置里注册一个 `settings.section`，用来填邮箱、授权码、白名单、
 * 主动来信参数。
 *
 * 数据走 Host 半侧自带的 HTTP API：
 *   GET  /mail-bot/config   读配置（授权码打码）
 *   POST /mail-bot/config   保存并热重载
 *   GET  /mail-bot/status   运行状态
 *
 * 注意：load 的 id 必须等于包名（dsh-mail-bot），否则 ModuleLoader 会报
 * "loaded without registering dsh-mail-bot"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mail-bot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect

    var API = '/mail-bot/config'
    var STATUS_API = '/mail-bot/status'

    /* ── CSS ─────────────────────────────────────────────────────────────── */
    var CSS = [
      '.__mb_root{max-width:640px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__mb_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:11px}',
      '.__mb_groupTitle{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.__mb_field{display:flex;flex-direction:column;gap:5px}',
      '.__mb_label{font-size:12px;font-weight:600}',
      '.__mb_hint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      '.__mb_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%;outline:none}',
      '.__mb_input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.__mb_two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.__mb_three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}',
      '.__mb_check{display:flex;align-items:flex-start;gap:8px;cursor:pointer}',
      '.__mb_check input{margin-top:2px;accent-color:var(--dsw-alias-state-business-primary)}',
      '.__mb_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.__mb_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}',
      '.__mb_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
      '.__mb_btn:disabled{opacity:.5;cursor:default}',
      '.__mb_btnPrimary{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff}',
      '.__mb_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__mb_ok{font-size:12px;color:var(--dsw-alias-state-business-primary)}',
      '.__mb_err{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.__mb_badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;border:1px solid var(--dsw-alias-border-l2)}'
    ].join('\n')

    var STYLE_ID = '__mb_style'
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var s = document.createElement('style')
      s.id = STYLE_ID
      s.textContent = CSS
      document.head.appendChild(s)
    }

    /* ── 小组件 ──────────────────────────────────────────────────────────── */
    function Field(props) {
      return h('div', { className: '__mb_field' },
        h('div', { className: '__mb_label' }, props.label),
        props.children,
        props.hint ? h('div', { className: '__mb_hint' }, props.hint) : null
      )
    }

    function Input(props) {
      return h('input', {
        className: '__mb_input',
        type: props.type || 'text',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder || '',
        disabled: !!props.disabled,
        onChange: function (e) { props.onChange(e.target.value) }
      })
    }

    /* ── 主面板 ──────────────────────────────────────────────────────────── */
    function Panel() {
      ensureStyle()

      var s0 = useState(null)          // 已加载配置
      var cfg = s0[0], setCfg = s0[1]
      var s1 = useState({              // 表单草稿
        email: '', authCode: '', allowFrom: '',
        imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465,
        pollSeconds: 15, dshProfile: 'headless',
        sandbox: 'workspace-write',
        proactive: {
          enabled: false, startHour: 7, endHour: 25, dailyLimit: 10,
          minGapMinutes: 30, maxGapMinutes: 90, subjectPrefix: '主动来信',
          context: ''
        }
      })
      var form = s1[0], setForm = s1[1]
      var s2 = useState('')            // 状态文字
      var msg = s2[0], setMsg = s2[1]
      var s3 = useState('idle')        // idle | loading | saving | ok | err
      var phase = s3[0], setPhase = s3[1]
      var s4 = useState(null)          // 运行状态
      var status = s4[0], setStatus = s4[1]

      function applyConfig(c) {
        setCfg(c)
        setForm({
          email: c.email || '',
          authCode: '',
          allowFrom: (c.allowFrom || []).join('\n'),
          imapHost: c.imapHost || '',
          imapPort: c.imapPort || 993,
          smtpHost: c.smtpHost || '',
          smtpPort: c.smtpPort || 465,
          pollSeconds: c.pollSeconds || 15,
          dshProfile: c.dshProfile || 'headless',
          sandbox: c.sandbox || 'workspace-write',
          proactive: Object.assign({
            enabled: false, startHour: 7, endHour: 25, dailyLimit: 10,
            minGapMinutes: 30, maxGapMinutes: 90, subjectPrefix: '主动来信',
            context: ''
          }, c.proactive || {})
        })
      }

      function load() {
        setPhase('loading')
        Promise.all([
          fetch(API, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json() }),
          fetch(STATUS_API, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json() }).catch(function () { return null })
        ]).then(function (arr) {
          var j = arr[0], st = arr[1]
          if (j && j.ok && j.config) {
            applyConfig(j.config)
            setPhase('idle')
            setMsg('')
          } else {
            setPhase('err')
            setMsg('读取配置失败：' + ((j && j.error) || '未知错误'))
          }
          if (st && st.ok) setStatus(st)
        }).catch(function (e) {
          setPhase('err')
          setMsg('读取配置失败：' + e.message)
        })
      }

      useEffect(function () { load() }, [])

      function patch(key, val) {
        var next = Object.assign({}, form)
        next[key] = val
        setForm(next)
      }

      function patchP(key, val) {
        var next = Object.assign({}, form)
        next.proactive = Object.assign({}, form.proactive)
        next.proactive[key] = val
        setForm(next)
      }

      function save() {
        setPhase('saving')
        setMsg('')
        var payload = {
          email: String(form.email || '').trim(),
          allowFrom: String(form.allowFrom || '')
            .split('\n').map(function (s) { return s.trim() }).filter(Boolean),
          imapHost: String(form.imapHost || '').trim(),
          imapPort: Number(form.imapPort) || 993,
          smtpHost: String(form.smtpHost || '').trim(),
          smtpPort: Number(form.smtpPort) || 465,
          pollSeconds: Number(form.pollSeconds) || 15,
          dshProfile: String(form.dshProfile || '').trim() || 'headless',
          sandbox: form.sandbox || 'workspace-write',
          proactive: {
            enabled: !!form.proactive.enabled,
            startHour: Number(form.proactive.startHour),
            endHour: Number(form.proactive.endHour),
            dailyLimit: Number(form.proactive.dailyLimit),
            minGapMinutes: Number(form.proactive.minGapMinutes),
            maxGapMinutes: Number(form.proactive.maxGapMinutes),
            subjectPrefix: String(form.proactive.subjectPrefix || '主动来信'),
            context: String(form.proactive.context || '')
          }
        }
        // 只有真的填了新授权码才提交
        if (form.authCode && form.authCode.indexOf('•') === -1) {
          payload.authCode = String(form.authCode).trim()
        }

        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json() }).then(function (j) {
          if (j && j.ok) {
            applyConfig(j.config)
            setPhase('ok')
            setMsg('已保存，正在按新配置运行')
            load()
          } else {
            setPhase('err')
            setMsg('保存失败：' + ((j && j.error) || '未知错误'))
          }
        }).catch(function (e) {
          setPhase('err')
          setMsg('保存失败：' + e.message)
        })
      }

      if (!cfg && phase === 'loading') {
        return h('div', { className: '__mb_root' }, h('div', { className: '__mb_status' }, '读取中…'))
      }

      var busy = phase === 'saving' || phase === 'loading'

      return h('div', { className: '__mb_root' },

        // ── 状态条 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '运行状态'),
          h('div', { className: '__mb_actions' },
            h('span', { className: '__mb_badge' },
              status ? (status.running ? '● 轮询中' : '○ 已停止') : '○ 未知'),
            status && status.today
              ? h('span', { className: '__mb_status' }, '今日已发 ' + status.today.count + ' 封')
              : null,
            status && status.nextEligibleAt
              ? h('span', { className: '__mb_status' },
                  '下一封 ' + new Date(status.nextEligibleAt).toLocaleTimeString('zh-CN', { hour12: false }))
              : null
          ),
          h('div', { className: '__mb_hint' }, '日志：' + (status ? status.logFile : '…'))
        ),

        // ── 邮箱 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '邮箱'),
          h(Field, { label: '邮箱地址', hint: '用来收发信的账号' },
            h(Input, { value: form.email, placeholder: 'your@qq.com', onChange: function (v) { patch('email', v) } })),
          h(Field, {
            label: '授权码',
            hint: cfg && cfg.hasAuthCode
              ? '已设置（' + cfg.authCode + '）。不填就是不改。'
              : '16 位授权码，不是登录密码。QQ 邮箱：设置 → 账户 → 开启 IMAP 后生成。'
          },
            h(Input, { value: form.authCode, placeholder: '留空 = 不改', onChange: function (v) { patch('authCode', v) } })),
          h(Field, { label: '允许指挥的邮箱（白名单）', hint: '一行一个。留空 = 只认上面的邮箱自己。' },
            h('textarea', {
              className: '__mb_input',
              rows: 3,
              value: form.allowFrom,
              onChange: function (e) { patch('allowFrom', e.target.value) }
            }))
        ),

        // ── 服务器 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '服务器'),
          h('div', { className: '__mb_two' },
            h(Field, { label: 'IMAP 主机' }, h(Input, { value: form.imapHost, onChange: function (v) { patch('imapHost', v) } })),
            h(Field, { label: 'IMAP 端口' }, h(Input, { type: 'number', value: form.imapPort, onChange: function (v) { patch('imapPort', v) } }))
          ),
          h('div', { className: '__mb_two' },
            h(Field, { label: 'SMTP 主机' }, h(Input, { value: form.smtpHost, onChange: function (v) { patch('smtpHost', v) } })),
            h(Field, { label: 'SMTP 端口' }, h(Input, { type: 'number', value: form.smtpPort, onChange: function (v) { patch('smtpPort', v) } }))
          ),
          h('div', { className: '__mb_two' },
            h(Field, { label: '轮询间隔（秒）' }, h(Input, { type: 'number', value: form.pollSeconds, onChange: function (v) { patch('pollSeconds', v) } })),
            h(Field, { label: '跑任务的 profile' }, h(Input, { value: form.dshProfile, onChange: function (v) { patch('dshProfile', v) } }))
          )
        ),

        // ── 权限 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '权限'),
          h(Field, {
            label: '邮件任务的文件权限',
            hint: '只影响这个插件 spawn 出去的进程，不改 DSH 本体配置'
          },
            h('select', {
              className: '__mb_input',
              value: form.sandbox,
              onChange: function (e) { patch('sandbox', e.target.value) }
            },
              h('option', { value: 'read-only' }, '只读 —— 只能看，不能改任何文件'),
              h('option', { value: 'workspace-write' }, '工作区 —— 能在工作目录里写，碰不了系统盘'),
              h('option', { value: 'danger-full-access' }, '完全 —— 能读写任何位置，能跑任意命令')
            )
          ),
          h('div', { className: '__mb_hint' },
            '审批一律设为 never：邮件是无人值守场景，选 ask 会卡在弹窗没人点。'),
          form.sandbox === 'danger-full-access'
            ? h('div', { className: '__mb_err' },
                '⚠ 完全权限意味着：任何能往白名单邮箱发信的人，都能在你电脑上执行任意操作。')
            : null
        ),

        // ── 主动来信 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '主动来信'),
          h('label', { className: '__mb_check' },
            h('input', {
              type: 'checkbox',
              checked: !!form.proactive.enabled,
              onChange: function (e) { patchP('enabled', e.target.checked) }
            }),
            h('span', null, '开启（到点自己写信给你）')
          ),
          h('div', { className: '__mb_three' },
            h(Field, { label: '开始（时）' }, h(Input, { type: 'number', value: form.proactive.startHour, onChange: function (v) { patchP('startHour', v) } })),
            h(Field, { label: '结束（时）', hint: '>24 表示次日' }, h(Input, { type: 'number', value: form.proactive.endHour, onChange: function (v) { patchP('endHour', v) } })),
            h(Field, { label: '每日上限' }, h(Input, { type: 'number', value: form.proactive.dailyLimit, onChange: function (v) { patchP('dailyLimit', v) } }))
          ),
          h('div', { className: '__mb_two' },
            h(Field, { label: '间隔下限（分）' }, h(Input, { type: 'number', value: form.proactive.minGapMinutes, onChange: function (v) { patchP('minGapMinutes', v) } })),
            h(Field, { label: '间隔上限（分）' }, h(Input, { type: 'number', value: form.proactive.maxGapMinutes, onChange: function (v) { patchP('maxGapMinutes', v) } }))
          ),
          h(Field, { label: '主题前缀' }, h(Input, { value: form.proactive.subjectPrefix, onChange: function (v) { patchP('subjectPrefix', v) } }))
        ),

        // ── 背景摘要 ──
        h('div', { className: '__mb_group' },
          h('div', { className: '__mb_groupTitle' }, '背景摘要'),
          h(Field, {
            label: '给邮件助手看的背景',
            hint: '每次生成都会带上这段。写短一点（几百字），太长会推高每封信的成本。留空就不带。'
          },
            h('textarea', {
              className: '__mb_input',
              rows: 5,
              placeholder: '例：主人最近在做 DSH 邮件插件；家里电脑是 TUF F16；周三有早八……',
              value: form.proactive.context,
              onChange: function (e) { patchP('context', e.target.value) }
            })
          )
        ),

        // ── 操作 ──
        h('div', { className: '__mb_actions' },
          h('button', {
            className: '__mb_btn __mb_btnPrimary',
            disabled: busy,
            onClick: save
          }, phase === 'saving' ? '保存中…' : '保存'),
          h('button', {
            className: '__mb_btn',
            disabled: busy,
            onClick: load
          }, '重新读取'),
          msg ? h('span', {
            className: phase === 'err' ? '__mb_err' : '__mb_ok'
          }, msg) : null
        )
      )
    }

    /* ── 插件 ────────────────────────────────────────────────────────────── */
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'mail-bot', order: 34, label: '邮件助手' },
          function () { return h(Panel, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
