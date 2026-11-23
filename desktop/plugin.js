/**
 * Usage HUD — a live token/cost readout for the Hermes Desktop status bar.
 *   装到：<hermes home>/desktop-plugins/token-meter/plugin.js
 *
 * 显示什么：
 *   11 轮 153 步 · 53 token/s · 总计 2.4M · 输入 238K 输出 4K · 缓存 90% · 上下文 24%（圆环）
 *   鼠标悬停还能看到：模型名、平均请求耗时、思考 token、子代理数、上下文压缩次数。
 *
 * 数据来源全部真实，不估不编：
 *   · token / 速度 / 缓存 / 上下文  ← host.state.focusedUsage（后台每轮实时推）
 *   · 轮数与步数                  ← host.request('session.history')，数落库的对话行
 *
 * 纯 ESM，未编译 —— 界面用 jsx() 调用书写，不写 JSX 语法。
 * 只允许 import @hermes/plugin-sdk / react / react/jsx-runtime。
 */

import { atom, host, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-meter'

// ── 文案（英文优先；桌面端会按界面语言挑，没装的语言回落英文）────────────
const STRINGS = {
  en: {
    turns: (r, s) => `${r} turns ${s} steps`,
    cache: p => `cache ${p}%`,
    cacheNone: 'cache —',
    total: 'Total',
    input: 'Input',
    output: 'Output',
    context: 'Context',
    tip: {
      model: m => `Model: ${m}`,
      turns: (r, s) => `Turns / steps: ${r} turns, ${s} steps`,
      speed: tps => `Output speed: ${tps} token/s (average of the last ~10 requests)`,
      speedNone: 'Output speed: no request finished yet',
      latency: s => `Average per request: ${s} s (includes time to first token)`,
      latencyNone: 'Average per request: not measured yet',
      out: n => `This session, generated: ${n} token`,
      inp: n => `This session, input (cache misses): ${n} token`,
      cacheRead: n => `This session, cache reads (reused history, billed at cache rate): ${n} token`,
      total: n => `This session, total (in + out + cache reads): ${n} token — large because every request resends the whole context`,
      cacheHit: p => `Cache hit: ${p}% (higher is cheaper and faster)`,
      cacheNone: 'Cache hit: not reported yet',
      ctx: (p, used, max) => `Context used: ${p}% (${used} / ${max})`,
      ctxNone: 'Context used: not measured yet',
      reasoning: n => `Reasoning token: ${n}`,
      subagents: n => `Subagents running: ${n}`,
      compressions: n => `Context compressions: ${n}`,
    },
  },
  zh: {
    turns: (r, s) => `${r} 轮 ${s} 步`,
    cache: p => `缓存 ${p}%`,
    cacheNone: '缓存 —',
    total: '总计',
    input: '输入',
    output: '输出',
    context: '上下文',
    tip: {
      model: m => `模型：${m}`,
      turns: (r, s) => `轮数/步数：${r} 轮 ${s} 步`,
      speed: tps => `输出速度：${tps} token/s（最近十来次请求的平均）`,
      speedNone: '输出速度：还没跑完一次请求',
      latency: s => `平均一次请求：${s} 秒（含等首字的时间）`,
      latencyNone: '平均一次请求：还没测出来',
      out: n => `本会话输出（生成）：${n} token`,
      inp: n => `本会话输入（未命中缓存的部分）：${n} token`,
      cacheRead: n => `本会话缓存读（复用的历史，按缓存价计费）：${n} token`,
      total: n => `本会话合计（入 + 出 + 缓存读）：${n} token —— 数字大是因为每次请求都要重发整段上下文`,
      cacheHit: p => `缓存命中：${p}%（越高越省钱、越快）`,
      cacheNone: '缓存命中：这次还没报上来',
      ctx: (p, used, max) => `上下文占用：${p}%（${used} / ${max}）`,
      ctxNone: '上下文占用：还没测出来',
      reasoning: n => `其中思考 token：${n}`,
      subagents: n => `正在跑的子代理：${n} 个`,
      compressions: n => `上下文压缩过：${n} 次`,
    },
  },
}

// 当前语言的文案；拿不到就用英文
let L = STRINGS.en
function pickStrings() {
  try {
    const loc = String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
    L = loc.startsWith('zh') ? STRINGS.zh : STRINGS.en
  } catch (_) {
    L = STRINGS.en
  }
}
pickStrings()

// ── 模块级状态 ──────────────────────────────────────────────────────────────
let ctxRef = null
let hostRef = null
let lastSessionId = null
let lastLoadAt = 0
let inflight = false
let lastUsageDump = 0

// rounds/steps: 当前会话数出来的轮数与步数（null = 还没数到）
const $counts = atom({ rounds: null, steps: null, forSession: null })

// ── 小工具 ──────────────────────────────────────────────────────────────────
function fmtTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return Math.round(v / 1e3) + 'K'
  return String(Math.round(v))
}

function writeDiag(name, payload) {
  const ctx = ctxRef
  if (!ctx) return
  try {
    const p = ctx.files.writeText('data', name, JSON.stringify(payload, null, 2))
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* 诊断文件写不进去不影响仪表 */
  }
}

// ── 数轮数与步数 ────────────────────────────────────────────────────────────
// 一轮 = 你发一句话；一步 = 一次工具调用（模型↔工具往返一次）。
// session.history 返回落库的对话行；role 字段可能叫 role，也可能裹在 message 里，两种都认。
function countRows(rows) {
  let rounds = 0
  let toolRows = 0
  let toolCallsOnAssistant = 0

  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue
    const role = String(row.role ?? row.message?.role ?? row.roleName ?? '')
    if (role === 'user') {
      rounds += 1
    } else if (role === 'tool') {
      toolRows += 1
    } else if (role === 'assistant') {
      const calls = row.tool_calls ?? row.toolCalls ?? row.message?.tool_calls
      if (Array.isArray(calls)) toolCallsOnAssistant += calls.length
    }
  }

  return { rounds, steps: toolRows > 0 ? toolRows : toolCallsOnAssistant, toolRows }
}

async function loadCounts(sessionId, { force = false } = {}) {
  if (!ctxRef || !sessionId) return
  const now = Date.now()
  if (!force && now - lastLoadAt < 1500) return
  if (inflight) return
  lastLoadAt = now
  inflight = true
  const startedAt = performance.now()

  try {
    const res = await hostRef.request('session.history', { session_id: sessionId })
    const rows = Array.isArray(res) ? res : (res?.messages ?? [])
    const counted = countRows(rows)
    $counts.set({ rounds: counted.rounds, steps: counted.steps, forSession: sessionId })
    writeDiag('last-readout.json', {
      at: new Date().toISOString(),
      session_id: sessionId,
      rounds: counted.rounds,
      steps: counted.steps,
      tool_rows: counted.toolRows,
      rows: rows.length,
      raw_count: Array.isArray(res) ? null : (res?.count ?? null),
      took_ms: Math.round(performance.now() - startedAt),
      sample_keys: rows.length ? Object.keys(rows[0] || {}) : []
    })
  } catch (err) {
    writeDiag('last-readout.json', {
      at: new Date().toISOString(),
      session_id: sessionId,
      error: String((err && err.message) || err)
    })
  } finally {
    inflight = false
  }
}

// 轮内不反复拉整段历史：工具一开步数先本地 +1，轮末（message.complete）再对齐一次。
function bumpStep() {
  const c = $counts.get()
  if (c.steps === null || c.forSession !== lastSessionId) return
  $counts.set({ ...c, steps: c.steps + 1 })
}

// ── 圆环（上下文占用百分比）────────────────────────────────────────────────
function Ring({ pct }) {
  const r = 5
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, Number(pct) || 0))

  return jsxs('svg', {
    'aria-hidden': 'true',
    className: 'shrink-0',
    height: 12,
    viewBox: '0 0 14 14',
    width: 12,
    children: [
      jsx('circle', {
        cx: 7,
        cy: 7,
        fill: 'none',
        r,
        stroke: 'var(--ui-stroke-secondary)',
        strokeWidth: 2
      }),
      jsx('circle', {
        cx: 7,
        cy: 7,
        fill: 'none',
        r,
        stroke: 'var(--ui-accent)',
        strokeDasharray: c,
        strokeDashoffset: c * (1 - p / 100),
        strokeLinecap: 'round',
        strokeWidth: 2,
        transform: 'rotate(-90 7 7)'
      })
    ]
  })
}

// 一格读数：数值 + 单位小字
function Cell({ label, value }) {
  return jsxs('span', {
    className: 'inline-flex items-baseline gap-1 whitespace-nowrap',
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', { className: 'tabular-nums text-foreground/90', children: value })
    ]
  })
}

// ── 状态栏那条 ──────────────────────────────────────────────────────────────
function Hud() {
  const usage = useValue(host.state.focusedUsage)
  const sessionId = useValue(host.state.focusedSessionId)
  const counts = useValue($counts)

  // 诊断：把后台真发过来的 usage 字段摊开存一份到插件数据目录，方便看还能加哪些读数
  useEffect(() => {
    if (!usage) return
    const now = Date.now()
    if (now - lastUsageDump < 10000) return
    lastUsageDump = now
    writeDiag('usage-keys.json', { at: new Date().toISOString(), keys: Object.keys(usage), usage })
  }, [usage])

  // 切会话就重数；同一会话里靠事件推着更新
  useEffect(() => {
    lastSessionId = sessionId || null
    if (sessionId) void loadCounts(sessionId, { force: true })
  }, [sessionId])

  const total = Number(usage?.total ?? 0)
  const inputTok = Number(usage?.input ?? 0)
  const outputTok = Number(usage?.output ?? 0)
  // total 含缓存读：入 = 未命中缓存的输入，出 = 生成，缓存读 = 合计 - 入 - 出
  const cacheTok = Math.max(0, total - inputTok - outputTok)
  const tps = Number(usage?.avg_tps ?? 0)
  const cache = usage?.cache_hit_pct
  const ctxPct = Number(usage?.context_percent ?? 0)
  const ctxMax = Number(usage?.context_max ?? 0)
  const latency = Number(usage?.avg_latency_s ?? 0)

  const rounds = counts.forSession === sessionId ? counts.rounds : null
  const steps = counts.forSession === sessionId ? counts.steps : null

  const stepText = rounds === null || steps === null ? '—' : L.turns(rounds, steps)
  const tpsText = tps > 0 ? `${Math.round(tps)} token/s` : '—'
  const cacheText = typeof cache === 'number' && Number.isFinite(cache) ? L.cache(Math.round(cache)) : L.cacheNone
  const ctxText = ctxMax > 0 ? `${Math.round(ctxPct)}%` : `${fmtTokens(total)} token`

  const model = usage?.model ? String(usage.model) : ''
  const subagents = Number(usage?.active_subagents ?? 0)
  const compressions = Number(usage?.compressions ?? 0)
  const reasoningTok = Number(usage?.reasoning ?? 0)

  const tipParts = [
    model ? L.tip.model(model) : null,
    rounds !== null ? L.tip.turns(rounds, steps) : null,
    tps > 0 ? L.tip.speed(Math.round(tps)) : L.tip.speedNone,
    latency > 0 ? L.tip.latency(latency.toFixed(1)) : L.tip.latencyNone,
    L.tip.out(outputTok.toLocaleString('en-US')),
    L.tip.inp(inputTok.toLocaleString('en-US')),
    L.tip.cacheRead(cacheTok.toLocaleString('en-US')),
    L.tip.total(total.toLocaleString('en-US')),
    typeof cache === 'number' && Number.isFinite(cache) ? L.tip.cacheHit(Math.round(cache)) : L.tip.cacheNone,
    ctxMax > 0
      ? L.tip.ctx(Math.round(ctxPct), fmtTokens(usage?.context_used ?? 0), fmtTokens(ctxMax))
      : L.tip.ctxNone,
    reasoningTok > 0 ? L.tip.reasoning(reasoningTok.toLocaleString('en-US')) : null,
    subagents > 0 ? L.tip.subagents(subagents) : null,
    compressions > 0 ? L.tip.compressions(compressions) : null
  ].filter(x => x !== null)

  return jsx(Tip, {
    label: tipParts.join(' · '),
    children: jsxs('div', {
      className:
        'inline-flex h-full items-center gap-2.5 px-1.5 text-[0.6875rem] leading-none tabular-nums select-none',
      children: [
        jsx(Cell, { label: '', value: stepText }),
        jsx('span', { className: 'text-(--ui-stroke-secondary)', children: '|' }),
        jsx('span', { className: 'whitespace-nowrap', children: tpsText }),
        jsx('span', { className: 'text-(--ui-stroke-secondary)', children: '|' }),
        jsxs('span', {
          className: 'inline-flex items-center gap-1 whitespace-nowrap',
          children: [
            jsx('span', { className: 'text-(--ui-text-quaternary)', children: L.total }),
            jsx('span', { className: 'text-foreground/90', children: fmtTokens(total) })
          ]
        }),
        jsx('span', { className: 'text-(--ui-stroke-secondary)', children: '|' }),
        jsxs('span', {
                  className: 'inline-flex items-center gap-1 whitespace-nowrap',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: L.input }),
                    jsx('span', { className: 'text-foreground/90', children: fmtTokens(inputTok) }),
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: L.output }),
                    jsx('span', { className: 'text-foreground/90', children: fmtTokens(outputTok) }),
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: cacheText })
                  ]
                }),
        jsx('span', { className: 'text-(--ui-stroke-secondary)', children: '|' }),
        jsxs('span', {
          className: 'inline-flex items-center gap-1 whitespace-nowrap',
          children: [
            ctxMax > 0 ? jsx(Ring, { pct: ctxPct }) : null,
            jsx('span', { className: 'text-(--ui-text-quaternary)', children: L.context }),
            jsx('span', { className: 'text-foreground/90', children: ctxText })
          ]
        })
      ]
    })
  })
}

// ── 注册 ────────────────────────────────────────────────────────────────────
export default {
  id: ID,
  name: '用量仪表条',
  register(ctx) {
    ctxRef = ctx
    hostRef = host

    writeDiag('last-load.json', { at: new Date().toISOString(), status: 'ready' })

    // 步：工具一开就本地 +1（不请求）；轮：一轮回完再和落库的历史对齐一次。
    let pending = null
    const realign = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        if (lastSessionId) void loadCounts(lastSessionId, { force: true })
      }, 1500)
    }

    host.onEvent('tool.start', bumpStep)
    host.onEvent('message.complete', realign)

    ctx.register({
      id: 'hud',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(Hud, {})
    })
  }
}
