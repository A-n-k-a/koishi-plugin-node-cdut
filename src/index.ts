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


export interface RoomConfig {
  /** 园区, 如 银杏园 */
  park?: Park
  /** 用电类型 */
  type?: '照明' | '空调'
  /** 栋号, 如 "1" */
  building?: string
  /** 房间号, 如 "512" */
  roomNo?: string
}

export interface Config {
  baseUrl: string
  username?: string
  password?: string
  room: RoomConfig
  keyword: string
  replyTemplate: string
  errorTemplate: string
}

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
    type: Schema.union(['照明', '空调'] as const).description('用电类型。'),
    building: Schema.string().description('栋号, 如 `1`。'),
    roomNo: Schema.string().description('房间号, 如 `512` (新开普通道须为 ≥3 位纯数字)。'),
  }).description('默认查询的房间信息 (消息中未携带房间信息时使用)。'),
  keyword: Schema.string()
    .default('查电费')
    .description('触发电费查询的关键词 (指令名, 不含空格)。'),
  replyTemplate: Schema.string()
    .role('textarea')
    .default('{park}{building}栋 {room} 房间{type}用电剩余 {remain} 度。')
    .description('查询成功时的回复模板。可用变量: {park} {type} {building} {room} {remain} {total} {canbuy} {project}。'),
  errorTemplate: Schema.string()
    .role('textarea')
    .default('电费查询失败: {error}')
    .description('查询失败时的回复模板。可用变量: {error}。'),
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

/** 从消息文本中解析房间信息 (园区 / 用电类型 / 栋号 / 房间号) */
export function parseRoomText(text: string): Partial<RoomConfig> {
  const result: Partial<RoomConfig> = {}
  if (!text) return result
  let rest = ` ${text} `
  const park = rest.match(/(榕树|珙桐|松林|银杏|芙蓉|香樟)园?/)
  if (park) {
    // 正则保证取值于六个园区之一, 此处收窄为 Park
    result.park = (park[1] + '园') as Park
    rest = rest.replace(park[0], ' ')
  }
  const type = rest.match(/(照明|空调)/)
  if (type) {
    result.type = type[1] as RoomConfig['type']
    rest = rest.replace(type[0], ' ')
  }
  const building = rest.match(/(\d{1,2})\s*栋/)
  if (building) {
    result.building = building[1]
    rest = rest.replace(building[0], ' ')
  }
  const room = rest.match(/(?:\d{1,2}\s*(?:单元|-)\s*)?[A-Za-z]?\d{3,4}/)
  if (room) {
    result.roomNo = room[0].replace(/\s+/g, '')
  }
  return result
}

const REQUIRED_ROOM_FIELDS: [keyof RoomConfig, string][] = [
  ['park', '园区'],
  ['type', '用电类型'],
  ['building', '栋号'],
  ['roomNo', '房间号'],
]

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

  /** 一站式解析房间并查询剩余电量 */
  async queryBalance(room: Required<RoomConfig>): Promise<{ routed: Record<string, unknown>; balance: Record<string, unknown> }> {
    const routed = asRecord(await this.request('POST', '/paym/electricity/route', { ...room }))
    if (!str(routed.projectId) || !str(routed.areaId) || !str(routed.buildId) || !str(routed.roomId)) {
      throw new Error('房间解析结果缺少必要字段 (projectId/areaId/buildId/roomId)')
    }
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
}

/** 合并消息中的房间信息与默认配置, 返回缺失字段名列表 */
function resolveRoom(text: string, fallback: RoomConfig) {
  const room: RoomConfig = { ...fallback, ...parseRoomText(text) }
  const missing = REQUIRED_ROOM_FIELDS.filter(([key]) => !room[key]).map(([, label]) => label)
  return { room, missing }
}

export function apply(ctx: Context, config: Config) {
  const client = new NodeCdutClient(ctx, config)
  const logger = ctx.logger('node-cdut')

  async function query(text: string): Promise<string> {
    const { room, missing } = resolveRoom(text, config.room)
    if (missing.length) {
      return renderTemplate(config.errorTemplate, {
        error: `缺少${missing.join('、')}信息, 请在消息中补充或在插件设置中配置默认房间`,
      })
    }
    // missing 已校验四项必填字段齐全, 此处收窄为 Required
    const full = room as Required<RoomConfig>
    const { routed, balance } = await client.queryBalance(full)
    return renderTemplate(config.replyTemplate, {
      park: full.park,
      type: full.type,
      building: full.building,
      room: str(routed.roomName) ?? full.roomNo,
      roomNo: full.roomNo,
      project: str(routed.projectName),
      remain: str(balance.remain),
      total: str(balance.total),
      canbuy: str(balance.canbuy),
    })
  }

  ctx.command(`${config.keyword} [room:text]`, '查询寝室电费余额')
    .usage(`可携带房间信息, 如: ${config.keyword} 银杏园 1栋 512 空调; 缺省使用插件设置中的默认房间。`)
    .action(async (_, room) => {
      try {
        return await query(room ?? '')
      } catch (err) {
        logger.warn(err)
        return renderTemplate(config.errorTemplate, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

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
        const override = Object.fromEntries(
          Object.entries(asRecord(room)).filter(([, v]) => typeof v === 'string' && v !== ''),
        )
        const merged: RoomConfig = { ...config.room, ...override }
        const missing = REQUIRED_ROOM_FIELDS.filter(([key]) => !merged[key]).map(([, label]) => label)
        if (missing.length) {
          return { success: false, message: `缺少${missing.join('、')}, 请在页面中填写或在插件设置中配置默认房间。` }
        }
        // missing 已校验四项必填字段齐全, 此处收窄为 Required
        const full = merged as Required<RoomConfig>
        const { routed, balance } = await client.queryBalance(full)
        const parts = [
          `${full.park}${full.building}栋 ${str(routed.roomName) ?? full.roomNo} (${full.type})`,
          `剩余电量 ${str(balance.remain)} 度`,
        ]
        const total = str(balance.total)
        if (total != null) parts.push(`累计用电 ${total} 度`)
        parts.push(`通道: ${str(routed.projectName) ?? str(routed.projectId)}`)
        return { success: true, message: parts.join('; ') }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
      }
    })
  })
}
