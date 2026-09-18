import { Context, Schema } from 'koishi'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import {} from '@koishijs/plugin-console'
import type {} from '@koishijs/plugin-http'

export const name = 'node-cdut'

export const inject = ['http']

declare module '@koishijs/console' {
  interface Events {
    'node-cdut/test-login'(): Promise<TestResult>
    'node-cdut/test-balance'(room?: Partial<RoomConfig>): Promise<TestResult>
  }
}

export interface TestResult {
  success: boolean
  message: string
}

/** 园区列表 (与 NodeCDUT /paym/electricity/route 的 park 取值一致) */
export const PARKS = ['榕树园', '珙桐园', '松林园', '银杏园', '芙蓉园', '香樟园'] as const

export type Park = (typeof PARKS)[number]

export type ElecType = '照明' | '空调'

/** 'both' 表示照明和空调都查询 */
export type RoomType = ElecType | 'both'

export interface RoomConfig {
  /** 园区, 如 银杏园 */
  park?: Park
  /** 用电类型; both = 照明和空调都查询 */
  type?: RoomType
  /** 栋号, 如 "1" */
  building?: string
  /** 房间号, 如 "512" */
  roomNo?: string
}

export interface TimeConfig {
  /** 时长数值, 0 表示不启用 */
  time: number
  /** 时间单位 (换算为秒的乘数: 1 / 60 / 3600) */
  unit: 1 | 60 | 3600
}

export interface Config {
  baseUrl: string
  username?: string
  password?: string
  room: RoomConfig
  prefix: string
  keyword: string
  replyTemplate: string
  chargeKeyword: string
  chargeTemplate: string
  errorTemplate: string
  cache: TimeConfig
  rateLimit: TimeConfig
}

const timeUnit = Schema.union([
  Schema.const(1).description('秒'),
  Schema.const(60).description('分钟'),
  Schema.const(3600).description('小时'),
] as const).default(60).description('时间单位。')

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default('http://localhost:3000')
    .description('NodeCDUT 接口服务的 Base URL。'),
  username: Schema.string()
    .description('统一身份认证账号 (学号), 用于自动登录获取会话凭据。'),
  password: Schema.string()
    .role('secret')
    .description('统一身份认证密码。'),
  room: Schema.object({
    park: Schema.union([...PARKS]).description('园区。'),
    type: Schema.union([
      Schema.const('照明' as const),
      Schema.const('空调' as const),
      Schema.const('both' as const).description('照明和空调'),
    ]).description('用电类型。'),
    building: Schema.string().description('栋号, 如 `1`。'),
    roomNo: Schema.string().description('房间号, 如 `512` (新开普通道须为 ≥3 位纯数字)。'),
  }).description('默认查询的房间信息 (消息中未携带房间信息时使用)。'),
  prefix: Schema.string()
    .default('')
    .description('指令前缀, 可以是任意字符串 (如 `！`、`/`); 留空表示不使用。设置后仅 `前缀+关键词` 可触发。'),
  keyword: Schema.string()
    .default('查电费')
    .pattern(/^\S+$/)
    .description('查询电费的关键词 (不含空格)。'),
  replyTemplate: Schema.string()
    .role('textarea')
    .default('{park}{building}栋 {room} 房间{type}用电剩余 {remain} 度。')
    .description('查询成功时的回复模板 (照明+空调同时查询时逐行各渲染一次)。可用变量: {park} {type} {building} {room} {remain} {total} {canbuy} {project}。'),
  chargeKeyword: Schema.string()
    .default('充电费')
    .pattern(/^\S+$/)
    .description('充值电费的关键词 (不含空格)。'),
  chargeTemplate: Schema.string()
    .role('textarea')
    .default('已为 {park}{building}栋 {room} 房间创建{type}电费充值订单 ({amount} 元, 订单号 {orderNo})。\n请扫码或打开链接支付: {payLink}')
    .description('充值下单成功时的回复模板。可用变量: {amount} {park} {type} {building} {room} {orderNo} {orderId} {payLink} {closeTime}。'),
  errorTemplate: Schema.string()
    .role('textarea')
    .default('电费操作失败: {error}')
    .description('操作失败时的回复模板。可用变量: {error}。'),
  cache: Schema.object({
    time: Schema.natural().default(15).description('缓存时长数值, 0 表示不启用缓存。'),
    unit: timeUnit,
  }).description('指令缓存: 一定时间内相同的指令仅触发一次接口请求, 直接回复缓存结果。'),
  rateLimit: Schema.object({
    time: Schema.natural().default(0).description('限流窗口数值, 0 表示不启用限流。'),
    unit: timeUnit,
  }).description('消息限流: 一个时间窗口内插件只响应一条指令, 其余指令不响应。'),
})

interface StoredSession {
  session: string
  /** 凭据所属账号; 与配置不一致时凭据作废 */
  username?: string
  studentId?: string
  updatedAt: string
}

/** 将上游 JSON 收窄为可按键读取的记录; 非对象一律视为空记录 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** 类型守卫: 仅接受字符串字段 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 提取上游错误消息 (NodeCDUT 错误体为 { error, message? }) */
function errorMessage(data: unknown, fallback: string): string {
  const body = asRecord(data)
  return str(body.message) ?? str(body.error) ?? fallback
}

/** 模板变量替换: 已知键缺失时置空, 未知占位符原样保留 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => {
    if (key in vars) return vars[key] == null ? '' : String(vars[key])
    return raw
  })
}

interface SplitRoom {
  room: Partial<RoomConfig>
  /** 移除已识别片段后的剩余文本 */
  rest: string
}

/** 从消息文本中解析房间信息 (园区 / 用电类型 / 栋号 / 房间号), 并返回剩余文本 */
function splitRoomText(text: string): SplitRoom {
  const room: Partial<RoomConfig> = {}
  if (!text) return { room, rest: '' }
  let rest = ` ${text} `
  const park = rest.match(/(榕树|珙桐|松林|银杏|芙蓉|香樟)园?/)
  if (park) {
    // 正则保证取值于六个园区之一, 此处收窄为 Park
    room.park = (park[1] + '园') as Park
    rest = rest.replace(park[0], ' ')
  }
  const type = rest.match(/(照明|空调)/)
  if (type) {
    room.type = type[1] as ElecType
    rest = rest.replace(type[0], ' ')
  }
  const building = rest.match(/(\d{1,2})\s*栋/)
  if (building) {
    room.building = building[1]
    rest = rest.replace(building[0], ' ')
  }
  const no = rest.match(/(?:\d{1,2}\s*(?:单元|-)\s*)?[A-Za-z]?\d{3,4}/)
  if (no) {
    room.roomNo = no[0].replace(/\s+/g, '')
    rest = rest.replace(no[0], ' ')
  }
  return { room, rest: rest.trim() }
}

/** 从消息文本中解析房间信息 */
export function parseRoomText(text: string): Partial<RoomConfig> {
  return splitRoomText(text).room
}

/**
 * 解析充值指令文本: 金额必须显式指定 (带 元/块 后缀或为小数,
 * 或在房间信息之外的剩余数字); 用电类型必须出现。
 */
export function parseChargeText(text: string): { amount?: number; room: Partial<RoomConfig> } {
  const { room, rest } = splitRoomText(text)
  const match = rest.match(/(-?\d+(?:\.\d{1,2})?)\s*(?:块钱|元|块)/)
    ?? rest.match(/(-?\d+\.\d{1,2})/)
    ?? rest.match(/(?<![-\d.])(\d+)/)
  return { amount: match ? Number(match[1]) : undefined, room }
}

/** 除用电类型外的必填房间字段 */
const REQUIRED_ROOM_FIELDS: [keyof RoomConfig, string][] = [
  ['park', '园区'],
  ['building', '栋号'],
  ['roomNo', '房间号'],
]

interface ResolvedRoom {
  park: Park
  building: string
  roomNo: string
}

export class NodeCdutClient {
  private blob?: string
  private studentId?: string
  private loaded = false
  private file: string
  private logger

  constructor(private ctx: Context, private config: Config) {
    this.file = resolve(__dirname, '../session.json')
    this.logger = ctx.logger('node-cdut')
  }

  private get base() {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const data = asRecord(JSON.parse(await readFile(this.file, 'utf8')))
      // 凭据与当前账号绑定; 账号变更后旧凭据作废
      if (str(data.username) === this.config.username) {
        this.blob = str(data.session)
        this.studentId = str(data.studentId)
      }
      if (this.blob) {
        this.logger.info('已从 %s 恢复登录凭据 (studentId: %s)', this.file, this.studentId ?? '未知')
      }
    } catch {
      // 文件不存在或损坏: 视为无凭据, 首次请求时重新登录
    }
  }

  private async save() {
    if (!this.blob) return
    const data: StoredSession = {
      session: this.blob,
      username: this.config.username,
      studentId: this.studentId,
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      this.logger.warn('凭据写入 %s 失败: %s', this.file, err)
    }
  }

  /** 调用 /auth/login 并覆盖本地凭据 */
  async login(): Promise<{ studentId?: string }> {
    const { username, password } = this.config
    if (!username || !password) {
      throw new Error('未配置统一身份认证账号密码, 请先在插件设置中填写。')
    }
    const res = await this.ctx.http('POST', `${this.base}/auth/login`, {
      data: { username, password },
      validateStatus: () => true,
    }).catch((err: unknown) => {
      throw new Error(`无法连接 NodeCDUT 服务 (${this.base}): ${err instanceof Error ? err.message : String(err)}`)
    })
    const data = asRecord(res.data)
    const blob = res.headers.get('x-auth-cookies') ?? str(data.session)
    if (res.status !== 200 || data.success !== true || !blob) {
      throw new Error(errorMessage(data, `登录失败 (HTTP ${res.status})`))
    }
    this.blob = blob
    this.studentId = str(data.studentId)
    await this.save()
    this.logger.info('登录成功 (studentId: %s), 凭据已保存至 %s', this.studentId ?? '未知', this.file)
    return { studentId: this.studentId }
  }

  /**
   * 携带凭据调用接口; 遇到 session_expired 时自动重新登录并重试一次。
   * 响应若带回新的 X-Auth-Cookies 则替换本地凭据。
   */
  private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    await this.load()
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.blob) await this.login()
      const res = await this.ctx.http(method, `${this.base}${path}`, {
        data: body,
        headers: { 'x-auth-cookies': this.blob! },
        validateStatus: () => true,
      }).catch((err: unknown) => {
        throw new Error(`无法连接 NodeCDUT 服务 (${this.base}): ${err instanceof Error ? err.message : String(err)}`)
      })
      const rotated = res.headers.get('x-auth-cookies')
      if (rotated && rotated !== this.blob) {
        this.blob = rotated
        await this.save()
      }
      if (res.status === 401 && attempt === 0) {
        this.logger.info('会话凭据已过期, 正在重新登录…')
        this.blob = undefined
        await this.login()
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(errorMessage(res.data, `请求失败 (HTTP ${res.status})`))
      }
      return res.data
    }
    throw new Error('重新登录后会话仍失效')
  }

  /** 一站式解析房间 */
  private async resolveRoom(room: ResolvedRoom & { type: ElecType }): Promise<Record<string, unknown>> {
    const routed = asRecord(await this.request('POST', '/paym/electricity/route', { ...room }))
    if (!str(routed.projectId) || !str(routed.areaId) || !str(routed.buildId) || !str(routed.roomId)) {
      throw new Error('房间解析结果缺少必要字段 (projectId/areaId/buildId/roomId)')
    }
    return routed
  }

  /** 查询剩余电量 */
  async queryBalance(room: ResolvedRoom & { type: ElecType }): Promise<{ routed: Record<string, unknown>; balance: Record<string, unknown> }> {
    const routed = await this.resolveRoom(room)
    const balance = asRecord(await this.request('POST', '/paym/electricity/balance', {
      projectId: routed.projectId,
      areaId: routed.areaId,
      buildId: routed.buildId,
      roomId: routed.roomId,
      levelId: routed.levelId,
    }))
    if (str(balance.remain) === undefined) {
      throw new Error('余额查询响应缺少 remain 字段')
    }
    return { routed, balance }
  }

  /** 创建电费充值订单 (真实下单, 未支付约 15 分钟自动关闭) */
  async createOrder(room: ResolvedRoom & { type: ElecType }, amount: number): Promise<{ routed: Record<string, unknown>; order: Record<string, unknown> }> {
    const routed = await this.resolveRoom(room)
    const order = asRecord(await this.request('POST', '/paym/electricity/order', {
      projectId: routed.projectId,
      areaId: routed.areaId,
      buildId: routed.buildId,
      roomId: routed.roomId,
      levelId: routed.levelId,
      areaName: routed.areaName,
      buildName: routed.buildName,
      levelName: routed.levelName,
      roomName: routed.roomName,
      amount,
      closePrevious: true,
    }))
    if (!str(order.orderId)) {
      throw new Error('创建订单失败: 响应缺少 orderId')
    }
    return { routed, order }
  }
}

export function apply(ctx: Context, config: Config) {
  const client = new NodeCdutClient(ctx, config)
  const logger = ctx.logger('node-cdut')

  // ---------- 缓存与限流 ----------
  const cacheStore = new Map<string, { reply: string; expires: number }>()
  const cacheMs = config.cache.time * config.cache.unit * 1000
  const rateLimitMs = config.rateLimit.time * config.rateLimit.unit * 1000
  let lastServedAt = 0

  /**
   * 限流与缓存包装: 窗口内已有响应则静默 (返回 undefined);
   * 缓存命中直接回复; 失败结果不写入缓存。
   */
  async function respond(key: string, produce: () => Promise<{ reply: string; cacheable: boolean }>): Promise<string | undefined> {
    const now = Date.now()
    if (rateLimitMs > 0 && now - lastServedAt < rateLimitMs) return undefined
    if (cacheMs > 0) {
      const hit = cacheStore.get(key)
      if (hit) {
        if (hit.expires > now) {
          lastServedAt = now
          return hit.reply
        }
        cacheStore.delete(key)
      }
    }
    const { reply, cacheable } = await produce()
    lastServedAt = Date.now()
    if (cacheMs > 0 && cacheable) {
      cacheStore.set(key, { reply, expires: lastServedAt + cacheMs })
    }
    return reply
  }

  // ---------- 房间解析与模板渲染 ----------

  function missingLabels(room: RoomConfig, needType: boolean): string[] {
    const labels = REQUIRED_ROOM_FIELDS.filter(([key]) => !room[key]).map(([, label]) => label)
    if (needType && !room.type) labels.splice(1, 0, '用电类型')
    return labels
  }

  function errorText(error: string): string {
    return renderTemplate(config.errorTemplate, { error })
  }

  /**
   * 查询用电解析规则:
   * - 消息携带房间信息 (园区/栋号/房间号任一) 但未指定用电类型时, 照明和空调都查询
   * - 消息不含任何房间信息时, 整体回退到默认房间配置
   */
  function resolveQueryRoom(text: string): { room?: ResolvedRoom & { type: RoomType }; missing: string[] } {
    const parsed = parseRoomText(text)
    const hasHint = parsed.park !== undefined || parsed.building !== undefined || parsed.roomNo !== undefined
    const room: RoomConfig = { ...config.room, ...parsed }
    if (parsed.type === undefined && hasHint) room.type = 'both'
    const missing = missingLabels(room, true)
    if (missing.length) return { missing }
    // missing 校验后四项齐全, 此处收窄
    return { room: room as ResolvedRoom & { type: RoomType }, missing }
  }

  function balanceVars(room: ResolvedRoom, type: ElecType, routed: Record<string, unknown>, balance: Record<string, unknown>) {
    return {
      park: room.park,
      type,
      building: room.building,
      room: str(routed.roomName) ?? room.roomNo,
      roomNo: room.roomNo,
      project: str(routed.projectName),
      remain: str(balance.remain),
      total: str(balance.total),
      canbuy: str(balance.canbuy),
    }
  }

  /** 按类型逐条查询并渲染; 单类型失败仅该行为错误信息, 不中断另一类型 */
  async function queryBalanceLines(room: ResolvedRoom & { type: RoomType }): Promise<{ reply: string; cacheable: boolean }> {
    const types: ElecType[] = room.type === 'both' ? ['照明', '空调'] : [room.type]
    const lines: string[] = []
    let failed = false
    for (const type of types) {
      try {
        const { routed, balance } = await client.queryBalance({ ...room, type })
        lines.push(renderTemplate(config.replyTemplate, balanceVars(room, type, routed, balance)))
      } catch (err) {
        failed = true
        logger.warn(err)
        lines.push(renderTemplate(config.errorTemplate, {
          error: `${type}查询失败: ${err instanceof Error ? err.message : String(err)}`,
        }))
      }
    }
    return { reply: lines.join('\n'), cacheable: !failed }
  }

  async function handleQuery(text: string): Promise<string | undefined> {
    const { room, missing } = resolveQueryRoom(text)
    if (missing.length || !room) {
      return errorText(`缺少${missing.join('、')}信息, 请在消息中补充或在插件设置中配置默认房间`)
    }
    return respond(`balance:${JSON.stringify(room)}`, () => queryBalanceLines(room))
  }

  /** 充值指令: 必须指定用电类型和金额, 房间可选 (缺省用默认房间) */
  async function handleCharge(text: string): Promise<string | undefined> {
    const { amount, room: parsed } = parseChargeText(text)
    if (!parsed.type) return errorText('请指定用电类型: 照明 或 空调')
    if (amount === undefined) return errorText('请指定充值金额, 如: 50元')
    if (!(amount > 0)) return errorText('充值金额必须为正数')
    const room: RoomConfig = { ...config.room, ...parsed, type: parsed.type }
    const missing = missingLabels(room, false)
    if (missing.length) {
      return errorText(`缺少${missing.join('、')}信息, 请在消息中补充或在插件设置中配置默认房间`)
    }
    const full = room as ResolvedRoom & { type: ElecType }
    const key = `charge:${JSON.stringify({ ...full, amount })}`
    return respond(key, async () => {
      try {
        const { routed, order } = await client.createOrder(full, amount)
        const payLink = asRecord(order.payLink)
        const reply = renderTemplate(config.chargeTemplate, {
          amount,
          park: full.park,
          type: full.type,
          building: full.building,
          room: str(routed.roomName) ?? full.roomNo,
          roomNo: full.roomNo,
          orderNo: str(order.orderNo),
          orderId: str(order.orderId),
          payLink: str(payLink.urlCode) ?? str(order.cashierUrl),
          closeTime: str(order.closeTime),
        })
        return { reply, cacheable: true }
      } catch (err) {
        logger.warn(err)
        return { reply: errorText(err instanceof Error ? err.message : String(err)), cacheable: false }
      }
    })
  }

  // ---------- 指令与关键词触发 ----------

  const queryUsage = `可携带房间信息, 如: ${config.keyword} 银杏园 1栋 512 空调; 不指定照明/空调时两者都查询; 缺省使用插件设置中的默认房间。`
  ctx.command(`${config.keyword} [room:text]`, '查询寝室电费余额')
    .usage(queryUsage)
    .action(async (_, room) => handleQuery(room ?? ''))

  const chargeUsage = `必须指定用电类型和金额, 如: ${config.chargeKeyword} 空调 50元; 房间信息可选, 缺省使用默认房间。`
  ctx.command(`${config.chargeKeyword} [room:text]`, '充值寝室电费 (创建待支付订单)')
    .usage(chargeUsage)
    .action(async (_, room) => handleCharge(room ?? ''))

  if (config.prefix) {
    // 前缀可以是任意字符串: 在指令解析前的中间件中做纯文本匹配,
    // 命中前缀指令时直接处理并拦截; 裸关键词消息静默忽略 (仅前缀形式可触发)。
    ctx.middleware(async (session, next) => {
      const text = session.stripped?.content
      if (!text) return next()
      const { prefix, keyword, chargeKeyword } = config
      const targets: [string, (rest: string) => Promise<string | undefined>][] = [
        [prefix + chargeKeyword, handleCharge],
        [prefix + keyword, handleQuery],
      ]
      for (const [trigger, handler] of targets) {
        if (!text.startsWith(trigger)) continue
        const reply = await handler(text.slice(trigger.length).trim())
        if (reply) await session.send(reply)
        return
      }
      if (text === keyword || text.startsWith(keyword + ' ')
        || text === chargeKeyword || text.startsWith(chargeKeyword + ' ')) {
        return
      }
      return next()
    }, true)
  }

  // ---------- 控制台测试页 ----------

  ctx.inject(['console'], (ctx) => {
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })

    ctx.console.addListener('node-cdut/test-login', async (): Promise<TestResult> => {
      try {
        const { studentId } = await client.login()
        return { success: true, message: `登录成功, 学号: ${studentId ?? '未知'}, 凭据已保存并可复用。` }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
      }
    })

    ctx.console.addListener('node-cdut/test-balance', async (room): Promise<TestResult> => {
      try {
        const override: Partial<RoomConfig> = {}
        for (const [key, value] of Object.entries(asRecord(room))) {
          if (typeof value === 'string' && value !== '') {
            // 控制台页字段与 RoomConfig 同构, 此处按键名收窄
            override[key as keyof RoomConfig] = value as never
          }
        }
        const merged: RoomConfig = { ...config.room, ...override }
        const missing = missingLabels(merged, true)
        if (missing.length) {
          return { success: false, message: `缺少${missing.join('、')}, 请在页面中填写或在插件设置中配置默认房间。` }
        }
        const full = merged as ResolvedRoom & { type: RoomType }
        const { reply } = await queryBalanceLines(full)
        return { success: true, message: reply }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
      }
    })
  })
}
