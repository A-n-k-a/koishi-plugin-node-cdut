import { Context, Schema, Session } from 'koishi'
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
    'node-cdut/cron-times'(): Promise<CronJobPreview[]>
  }
}

export interface TestResult {
  success: boolean
  message: string
}

/** 控制台页面展示的单个定时任务预览 */
export interface CronJobPreview {
  /** 指令关键词 */
  command: string
  /** 指令参数 */
  arguments: string
  expression: string
  /** 发送目标列表 */
  targets: string[]
  /** 目标非空时任务生效 */
  enabled: boolean
  /** 未来触发时间 (ISO 字符串) */
  times: string[]
  error?: string
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

export interface PrefixConfig {
  /** 指令前缀列表; 空列表表示不使用字符串前缀 */
  list: string[]
  /** 被 @机器人 也视为指令前缀 */
  at: boolean
}

export interface LogConfig {
  /** 匹配指令时输出收到消息的日志 */
  received: boolean
  /** 回复指令时输出发出消息的日志 (含定时任务推送) */
  sent: boolean
}

export interface CronJobConfig {
  /** 指令关键词; 留空默认为查电费指令 */
  command: string
  /** 指令参数文本, 与消息中指令后携带的内容一致 (如 `银杏园 1栋 512 空调`) */
  arguments: string
  /** cron 表达式, 5 个字段: 分 时 日 月 周 */
  expression: string
  /** 发送目标列表: `平台:群号` 或 `平台:private:用户ID`; 为空时该任务不生效 */
  targets: string[]
  /** 多个目标之间的发送延时 */
  delay: TimeConfig
  /** 发送条件表达式; 留空表示总是发送 */
  conditions: string
  /** 消息模板; 留空使用该指令的默认模板 */
  template: string
}

export interface CronConfig {
  jobs: CronJobConfig[]
  /** 控制台页面中每个任务显示的未来触发次数 */
  preview: number
}

export type ListMode = 'black' | 'white'

export interface FilterConfig {
  /** 群名单模式 */
  groupMode: ListMode
  /** 群号列表 */
  groups: string[]
  /** 用户名单模式 */
  userMode: ListMode
  /** 用户 ID 列表 */
  users: string[]
}

export interface Config {
  baseUrl: string
  username?: string
  password?: string
  room: RoomConfig
  prefix: PrefixConfig
  menuKeyword: string
  keyword: string
  chargeKeyword: string
  replyTemplate: string
  chargeTemplate: string
  errorTemplate: string
  cache: TimeConfig
  rateLimit: TimeConfig
  logging: LogConfig
  cron: CronConfig
  filter: FilterConfig
}


const timeUnit = Schema.union([
  Schema.const(1).description('秒'),
  Schema.const(60).description('分钟'),
  Schema.const(3600).description('小时'),
] as const).default(60).description('时间单位。')

const listMode = Schema.union([
  Schema.const('black' as const).description('黑名单: 名单内不响应'),
  Schema.const('white' as const).description('白名单: 仅名单内响应'),
] as const).default('black')
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
  prefix: Schema.object({
    list: Schema.array(Schema.string())
      .default([])
      .description('指令前缀列表, 每项可以是任意字符串 (如 `！`、`/`)。设置后仅 `前缀+关键词` 可触发。'),
    at: Schema.boolean()
      .default(false)
      .description('被 @机器人 也视为指令前缀 (如 `@机器人 查电费`)。'),
  }).description('指令前缀。前缀列表为空且未开启 @ 识别时不启用此功能, 关键词消息按 Koishi 默认方式解析。'),
  menuKeyword: Schema.string()
    .default('CDUT菜单')
    .pattern(/^\S+$/)
    .description('菜单指令名称 (不含空格), 用于展示全部可用指令及用法。'),
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
  logging: Schema.object({
    received: Schema.boolean()
      .default(true)
      .description('匹配指令时输出日志: 平台、群号 (私聊标注)、用户 ID、消息原文; 命中缓存 / 触发限流 / 名单拦截时附注。'),
    sent: Schema.boolean()
      .default(true)
      .description('回复指令时输出日志: 平台、群号 (私聊标注)、用户 ID、回复内容; 定时任务的推送与执行结果日志也受此开关控制。'),
  }).description('日志开关。'),
  cron: Schema.object({
    jobs: Schema.array(Schema.object({
      command: Schema.string()
        .default('')
        .description('要定时执行的指令关键词 (如 `查电费`、`充电费`、`CDUT菜单`, 以插件设置中的关键词配置为准); 留空默认为查电费指令。'),
      arguments: Schema.string()
        .default('')
        .description('指令参数文本, 与消息中指令后携带的内容一致 (如 `银杏园 1栋 512 空调`、`空调 50元`); 留空使用插件设置中的默认房间。'),
      expression: Schema.string()
        .default('')
        .description('cron 表达式, 5 个字段: `分 时 日 月 周`, 支持 `*`、`,`、`-`、`/`; 如 `0 8 * * *` 表示每天 08:00, `*/30 8-22 * * *` 表示 8 点到 22 点每 30 分钟。'),
      targets: Schema.array(Schema.string())
        .default([])
        .description('发送目标列表, 每项为 `平台:群号` (如 `onebot:12345678`) 或 `平台:private:用户ID` (私聊, 如 `onebot:private:123456`); 留空则该任务不生效。'),
      delay: Schema.object({
        time: Schema.natural().default(0).description('延时数值, 0 表示连续发送。'),
        unit: timeUnit,
      }).description('多个目标之间的发送延时。'),
      conditions: Schema.string()
        .default('')
        .description('发送条件, 如 `remain < 20`、`type == 照明` (中文值可直接书写); 变量与消息模板通用 (remain total canbuy park type building room project 等, 随指令而异); 多个条件用 `与`/`或`/`非` (或 `&&`/`||`/`!`) 连接, 支持括号; 留空表示总是发送; 查询多个用电类型时任一类型满足即发送; 条件不满足时跳过发送, 但仍输出执行结果日志。'),
      template: Schema.string()
        .role('textarea')
        .default('')
        .description('消息模板, 留空使用该指令的默认模板; 可用变量与对应指令的模板相同。'),
    }))
      .default([])
      .description('定时任务列表: 按 cron 表达式定时执行指令并将结果推送到目标。'),
    preview: Schema.natural()
      .default(5)
      .description('控制台 NodeCDUT 页面中每个任务显示的未来触发次数。'),
  }).description('定时任务 (cron)。'),
  filter: Schema.object({
    groupMode: listMode.description('群名单模式。'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('群号列表; 仅作用于群消息, 私聊不受群名单限制。'),
    userMode: listMode.description('用户名单模式。'),
    users: Schema.array(Schema.string())
      .default([])
      .description('用户 ID 列表; 群消息与私聊均生效 (群内发送者同样匹配用户名单)。'),
  }).description('黑白名单: 仅影响本插件的指令响应, 不影响其他插件。'),
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

// ---------- cron 表达式 (5 字段: 分 时 日 月 周) ----------

export interface CronField {
  /** 字段为 `*` (不限制); 用于日/周同时受限时取或的标准 cron 语义 */
  any: boolean
  values: Set<number>
}

export interface CronSpec {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}
/** 解析单个 cron 字段: 支持 `*`、单值、区间、步长 (`a/n`、`a-b/n`) 与逗号列表 */
function parseCronField(field: string, min: number, max: number, normalize: (n: number) => number = (n) => n): CronField {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!match) throw new Error(`无法解析字段 "${field}"`)
    const step = match[2] ? Number(match[2]) : 1
    if (step < 1) throw new Error(`字段 "${field}" 的步长必须为正整数`)
    let lo: number, hi: number
    if (match[1] === '*') [lo, hi] = [min, max]
    else if (match[1].includes('-')) [lo, hi] = match[1].split('-').map(Number)
    else {
      lo = Number(match[1])
      // `a/n` 等价于 `a-max/n` (与 Vixie cron 一致)
      hi = match[2] ? max : lo
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`字段 "${field}" 的取值超出范围 [${min}, ${max}]`)
    for (let value = lo; value <= hi; value += step) values.add(normalize(value))
  }
  return { any: field === '*', values }
}

/** 解析 5 字段 cron 表达式 (分 时 日 月 周; 周日可用 0 或 7 表示) */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`应包含 5 个字段 (分 时 日 月 周), 当前为 ${fields.length} 个`)
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dom: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dow: parseCronField(fields[4], 0, 7, (n) => (n === 7 ? 0 : n)),
  }
}

/** 日匹配: 日与周同时受限时满足其一即可 (标准 cron 语义) */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const domOk = spec.dom.any || spec.dom.values.has(date.getDate())
  const dowOk = spec.dow.any || spec.dow.values.has(date.getDay())
  if (spec.dom.any) return dowOk
  if (spec.dow.any) return domOk
  return domOk || dowOk
}

/** 计算 after 之后 (不含 after 所在分钟) 的未来 count 次触发时间; 最多向后搜索 4 年 */
export function nextOccurrences(spec: CronSpec, count: number, after = new Date()): Date[] {
  const times: Date[] = []
  const cursor = new Date(after)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = new Date(after)
  limit.setFullYear(limit.getFullYear() + 4)
  while (times.length < count && cursor < limit) {
    if (!spec.month.values.has(cursor.getMonth() + 1)) {
      cursor.setDate(1)
      cursor.setMonth(cursor.getMonth() + 1)
      cursor.setHours(0, 0, 0, 0)
    } else if (!dayMatches(spec, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
    } else if (!spec.hour.values.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
    } else if (!spec.minute.values.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
    } else {
      times.push(new Date(cursor))
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
    }
  }
  return times
}

export interface CronTarget {
  platform: string
  /** 群号 (私聊时为空) */
  channelId?: string
  /** 私聊用户 ID */
  userId?: string
}

/** 解析发送目标: `平台:群号` 或 `平台:private:用户ID` */
export function parseCronTarget(target: string): CronTarget {
  const [platform, kind, extra] = target.trim().split(':')
  if (!platform || !kind) throw new Error('目标格式应为 `平台:群号` 或 `平台:private:用户ID`')
  if (kind === 'private') {
    if (!extra) throw new Error('私聊目标缺少用户 ID, 格式应为 `平台:private:用户ID`')
    return { platform, userId: extra }
  }
  return { platform, channelId: kind }
}

// ---------- 发送条件表达式 (变量与消息模板通用, 与/或/非 连接) ----------

export type CondOperand =
  | { type: 'var'; name: string }
  | { type: 'value'; value: string }

export type CondNode =
  | { type: 'or' | 'and'; left: CondNode; right: CondNode }
  | { type: 'not'; operand: CondNode }
  | { type: 'cmp'; op: string; left: CondOperand; right: CondOperand }
  | { type: 'truthy'; operand: CondOperand }

interface CondToken {
  type: 'op' | 'lparen' | 'rparen' | 'operand'
  value: string
}

/** 条件表达式分词: 运算符、括号、数字、引号字符串、变量名、与/或/非 关键字; 中文裸词按字符串字面量处理 */
function tokenizeConditions(source: string): CondToken[] {
  const tokens: CondToken[] = []
  const pattern = /\s*(<=|>=|==|!=|&&|\|\||[<>()!]|\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|与|或|非|and\b|or\b|not\b|[A-Za-z_]\w*|[\p{Script=Han}][\p{Script=Han}\w]*)/gyu
  let pos = 0
  while (pos < source.length) {
    pattern.lastIndex = pos
    const match = pattern.exec(source)
    if (!match) {
      if (/^\s*$/.test(source.slice(pos))) break
      throw new Error(`无法解析 "${source.slice(pos)}"`)
    }
    pos = pattern.lastIndex
    const raw = match[1]
    if (raw === '(') tokens.push({ type: 'lparen', value: raw })
    else if (raw === ')') tokens.push({ type: 'rparen', value: raw })
    else if (/^(<=|>=|==|!=|&&|\|\||[<>!]|与|或|非|and|or|not)$/i.test(raw)) tokens.push({ type: 'op', value: raw })
    else tokens.push({ type: 'operand', value: raw })
  }
  return tokens
}

/** 解析条件表达式; 优先级: 非 > 与 > 或, 支持括号 */
export function parseConditions(source: string): CondNode {
  const tokens = tokenizeConditions(source.trim())
  if (!tokens.length) throw new Error('条件表达式为空')
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (...ops: string[]) => {
    const token = peek()
    return token?.type === 'op' && ops.some((op) => token.value.toLowerCase() === op)
  }
  function parseOperand(): CondOperand {
    const token = peek()
    if (!token || token.type !== 'operand') throw new Error(`"${token?.value ?? '末尾'}" 处应为数值、字符串或变量`)
    pos++
    if (/^(['"])/.test(token.value)) return { type: 'value', value: token.value.slice(1, -1).replace(/\\(.)/g, '$1') }
    if (/^\d/.test(token.value)) return { type: 'value', value: token.value }
    // 中文裸词 (如 `type == 照明` 中的 照明) 按字符串字面量处理
    if (/^\p{Script=Han}/u.test(token.value)) return { type: 'value', value: token.value }
    return { type: 'var', name: token.value }
  }
  function parseAtom(): CondNode {
    if (isOp('非', '!', 'not')) {
      pos++
      return { type: 'not', operand: parseAtom() }
    }
    if (peek()?.type === 'lparen') {
      pos++
      const node = parseOr()
      if (peek()?.type !== 'rparen') throw new Error('缺少右括号')
      pos++
      return node
    }
    const left = parseOperand()
    if (isOp('<', '<=', '>', '>=', '==', '!=')) {
      const op = tokens[pos++].value
      return { type: 'cmp', op, left, right: parseOperand() }
    }
    return { type: 'truthy', operand: left }
  }
  function parseAnd(): CondNode {
    let node = parseAtom()
    while (isOp('与', '&&', 'and')) {
      pos++
      node = { type: 'and', left: node, right: parseAtom() }
    }
    return node
  }
  function parseOr(): CondNode {
    let node = parseAnd()
    while (isOp('或', '||', 'or')) {
      pos++
      node = { type: 'or', left: node, right: parseAnd() }
    }
    return node
  }
  const node = parseOr()
  if (pos < tokens.length) throw new Error(`"${tokens[pos].value}" 处存在多余内容`)
  return node
}

/** 求值操作数: 变量取自 vars (缺失为 undefined), 字面量原样返回 */
function operandValue(operand: CondOperand, vars: Record<string, unknown>): string | undefined {
  if (operand.type === 'value') return operand.value
  const value = vars[operand.name]
  return value == null ? undefined : String(value)
}

/** 求值条件表达式; 变量缺失时比较结果为 false */
export function evalConditions(node: CondNode, vars: Record<string, unknown>): boolean {
  switch (node.type) {
    case 'or': return evalConditions(node.left, vars) || evalConditions(node.right, vars)
    case 'and': return evalConditions(node.left, vars) && evalConditions(node.right, vars)
    case 'not': return !evalConditions(node.operand, vars)
    case 'truthy': {
      const value = operandValue(node.operand, vars)
      return value !== undefined && value !== '' && value !== '0'
    }
    case 'cmp': {
      const left = operandValue(node.left, vars)
      const right = operandValue(node.right, vars)
      if (left === undefined || right === undefined) return false
      // 两侧均为数值时按数值比较, 否则按字符串比较
      const numeric = left !== '' && right !== '' && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
      const l = numeric ? Number(left) : left
      const r = numeric ? Number(right) : right
      switch (node.op) {
        case '<': return l < r
        case '<=': return l <= r
        case '>': return l > r
        case '>=': return l >= r
        case '==': return l === r
        case '!=': return l !== r
        default: return false
      }
    }
  }
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
   * 指令执行结果: reply 为回复内容 (限流时为空); note 为日志附注 (缓存/限流提示);
   * vars 为模板变量列表 (查询多个用电类型时每个类型一项), 供定时任务条件表达式求值。
   */
  interface CmdResult {
    reply?: string
    note?: string
    vars?: Record<string, unknown>[]
  }

  /** 指令执行产出: cacheable 为 false 时结果不写入缓存 */
  interface CmdProduce {
    reply: string
    cacheable: boolean
    vars?: Record<string, unknown>[]
  }

  /**
   * 限流与缓存包装: 窗口内已有响应则静默 (note 标注限流);
   * 缓存命中直接回复 (note 标注缓存); 失败结果不写入缓存。
   */
  async function respond(key: string, produce: () => Promise<CmdProduce>): Promise<CmdResult> {
    const now = Date.now()
    if (rateLimitMs > 0 && now - lastServedAt < rateLimitMs) return { note: '触发限流, 本次不响应' }
    if (cacheMs > 0) {
      const hit = cacheStore.get(key)
      if (hit) {
        if (hit.expires > now) {
          lastServedAt = now
          return { reply: hit.reply, note: '命中缓存' }
        }
        cacheStore.delete(key)
      }
    }
    const { reply, cacheable, vars } = await produce()
    lastServedAt = Date.now()
    if (cacheMs > 0 && cacheable) {
      cacheStore.set(key, { reply, expires: lastServedAt + cacheMs })
    }
    return { reply, vars }
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

  /** 按类型逐条查询并渲染; 单类型失败仅该行为错误信息, 不中断另一类型; template 缺省用全局回复模板 */
  async function queryBalanceLines(room: ResolvedRoom & { type: RoomType }, template?: string): Promise<CmdProduce> {
    const types: ElecType[] = room.type === 'both' ? ['照明', '空调'] : [room.type]
    const lines: string[] = []
    const vars: Record<string, unknown>[] = []
    let failed = false
    for (const type of types) {
      try {
        const { routed, balance } = await client.queryBalance({ ...room, type })
        const entry = balanceVars(room, type, routed, balance)
        vars.push(entry)
        lines.push(renderTemplate(template ?? config.replyTemplate, entry))
      } catch (err) {
        failed = true
        logger.warn(err)
        lines.push(renderTemplate(config.errorTemplate, {
          error: `${type}查询失败: ${err instanceof Error ? err.message : String(err)}`,
        }))
      }
    }
    return { reply: lines.join('\n'), cacheable: !failed, vars }
  }

  async function handleQuery(text: string, template?: string): Promise<CmdResult> {
    const { room, missing } = resolveQueryRoom(text)
    if (missing.length || !room) {
      return { reply: errorText(`缺少${missing.join('、')}信息, 请在消息中补充或在插件设置中配置默认房间`) }
    }
    // 模板覆盖会影响回复内容, 计入缓存键
    const key = `balance:${JSON.stringify(room)}${template ? `:${template}` : ''}`
    return respond(key, () => queryBalanceLines(room, template))
  }

  /** 充值指令: 必须指定用电类型和金额, 房间可选 (缺省用默认房间); template 缺省用全局充值模板 */
  async function handleCharge(text: string, template?: string): Promise<CmdResult> {
    const { amount, room: parsed } = parseChargeText(text)
    if (!parsed.type) return { reply: errorText('请指定用电类型: 照明 或 空调') }
    if (amount === undefined) return { reply: errorText('请指定充值金额, 如: 50元') }
    if (!(amount > 0)) return { reply: errorText('充值金额必须为正数') }
    const room: RoomConfig = { ...config.room, ...parsed, type: parsed.type }
    const missing = missingLabels(room, false)
    if (missing.length) {
      return { reply: errorText(`缺少${missing.join('、')}信息, 请在消息中补充或在插件设置中配置默认房间`) }
    }
    const full = room as ResolvedRoom & { type: ElecType }
    const key = `charge:${JSON.stringify({ ...full, amount })}${template ? `:${template}` : ''}`
    return respond(key, async () => {
      try {
        const { routed, order } = await client.createOrder(full, amount)
        const payLink = asRecord(order.payLink)
        const vars = {
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
        }
        return { reply: renderTemplate(template ?? config.chargeTemplate, vars), cacheable: true, vars: [vars] }
      } catch (err) {
        logger.warn(err)
        return { reply: errorText(err instanceof Error ? err.message : String(err)), cacheable: false }
      }
    })
  }

  // ---------- 指令注册表 ----------
  // 新增指令时向 commands 追加一项即可: Koishi 指令注册、前缀中间件匹配与菜单内容均由此派生。

  interface PluginCommand {
    keyword: string
    description: string
    usage: string
    /** template 为定时任务的消息模板覆盖, 指令消息调用时不传 */
    handle: (text: string, template?: string) => Promise<CmdResult>
  }

  const queryUsage = `可携带房间信息, 如: ${config.keyword} 银杏园 1栋 512 空调; 不指定照明/空调时两者都查询; 缺省使用插件设置中的默认房间。`
  const chargeUsage = `必须指定用电类型和金额, 如: ${config.chargeKeyword} 空调 50元; 房间信息可选, 缺省使用默认房间。`

  // 菜单指令置顶, 其余指令按注册顺序排列
  const commands: PluginCommand[] = [
    {
      keyword: config.menuKeyword,
      description: '显示本菜单',
      usage: '直接发送即可查看全部可用指令及用法。',
      handle: () => respond('menu', async () => ({ reply: menuText(), cacheable: true })),
    },
    { keyword: config.keyword, description: '查询寝室电费余额', usage: queryUsage, handle: handleQuery },
    { keyword: config.chargeKeyword, description: '充值寝室电费 (创建待支付订单)', usage: chargeUsage, handle: handleCharge },
  ]

  /** 菜单内容从指令注册表派生, 新增指令自动出现在菜单中 */
  function menuText(): string {
    const lines = commands.map((cmd, index) => `${index + 1}. ${cmd.keyword}: ${cmd.description}\n   用法: ${cmd.usage}`)
    return `【CDUT 菜单】共 ${commands.length} 个可用指令:\n${lines.join('\n')}`
  }

  /** 日志上下文: 平台、群号 (私聊时标注) 与用户 ID */
  function logContext(session: Session): string {
    return `${session.platform} ${session.guildId ? `群 ${session.guildId}` : '私聊'} | 用户 ${session.userId}`
  }

  /** 收到日志: 输出群号、用户 ID 与消息原文; 缓存/限流时附注 */
  function logReceived(session: Session, cmd: PluginCommand, note?: string) {
    logger.info('匹配指令 [%s] | %s | 消息: %s%s',
      cmd.keyword, logContext(session), session.content, note ? ` | ${note}` : '')
  }

  /** 发出日志: 输出群号、用户 ID 与回复内容 */
  function logSent(session: Session, cmd: PluginCommand, reply: string) {
    logger.info('回复指令 [%s] | %s | 回复: %s', cmd.keyword, logContext(session), reply)
  }

  /**
   * 黑白名单过滤: 返回拦截原因, 不拦截时返回 undefined。
   * 仅影响本插件的指令响应 (在 dispatch 入口拦截), 不干涉其他插件。
   * 群名单仅作用于群消息; 用户名单对群消息与私聊均生效 (群内发送者同样匹配)。
   */
  function blockedReason(session: Session): string | undefined {
    const { groupMode, groups, userMode, users } = config.filter
    if (session.guildId) {
      const listed = groups.includes(session.guildId)
      if (groupMode === 'black' ? listed : !listed) {
        return groupMode === 'black' ? '群在黑名单中' : '群不在白名单中'
      }
    }
    if (session.userId) {
      const listed = users.includes(session.userId)
      if (userMode === 'black' ? listed : !listed) {
        return userMode === 'black' ? '用户在黑名单中' : '用户不在白名单中'
      }
    }
  }

  async function dispatch(session: Session, cmd: PluginCommand, text: string) {
    const blocked = blockedReason(session)
    if (blocked) {
      if (config.logging.received) logReceived(session, cmd, `${blocked}, 本次不响应`)
      return
    }
    const { reply, note } = await cmd.handle(text)
    if (config.logging.received) logReceived(session, cmd, note)
    if (reply) {
      await session.send(reply)
      if (config.logging.sent) logSent(session, cmd, reply)
    }
  }

  // 关键词较长的指令优先匹配, 避免短关键词遮蔽长关键词
  const sortedCommands = [...commands].sort((a, b) => b.keyword.length - a.keyword.length)

  for (const cmd of commands) {
    ctx.command(`${cmd.keyword} [room:text]`, cmd.description)
      .usage(cmd.usage)
      .action(({ session }, room) => dispatch(session, cmd, room ?? ''))
  }

  const prefixList = config.prefix.list.filter(Boolean)
  if (prefixList.length || config.prefix.at) {
    // 前缀可以是任意字符串: 在指令解析前的中间件中做纯文本匹配,
    // 命中前缀指令时直接处理并拦截; 裸关键词消息静默忽略 (仅前缀形式可触发)。
    ctx.middleware(async (session, next) => {
      const stripped = session.stripped
      const text = stripped?.content
      if (!text) return next()
      // 前缀较长的优先匹配, 避免短前缀遮蔽长前缀
      const triggers = prefixList
        .flatMap((prefix) => sortedCommands.map((cmd): [string, PluginCommand] => [prefix + cmd.keyword, cmd]))
        .sort((a, b) => b[0].length - a[0].length)
      for (const [trigger, cmd] of triggers) {
        if (!text.startsWith(trigger)) continue
        await dispatch(session, cmd, text.slice(trigger.length).trim())
        return
      }
      // @ 机器人视为前缀: stripped.content 已剥离开头的 @ 元素
      if (config.prefix.at && stripped.atSelf) {
        for (const cmd of sortedCommands) {
          if (!text.startsWith(cmd.keyword)) continue
          await dispatch(session, cmd, text.slice(cmd.keyword.length).trim())
          return
        }
      }
      if (sortedCommands.some((cmd) => text === cmd.keyword || text.startsWith(cmd.keyword + ' '))) {
        return
      }
      return next()
    }, true)
  }

  // ---------- 定时任务 (cron) ----------

  /** 可延时等待: 基于 ctx.setTimeout, 插件卸载时未触发的等待随之作废 */
  function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    ctx.setTimeout(resolve, ms)
    return promise
  }

  function describeCronTarget(target: CronTarget): string {
    return target.userId ? `${target.platform} 私聊 ${target.userId}` : `${target.platform} 群 ${target.channelId}`
  }

  /** 向单个目标推送, 返回是否成功; 推送日志受 sent 开关控制 */
  async function pushToTarget(cmd: PluginCommand, raw: string, reply: string): Promise<void> {
    const target = parseCronTarget(raw)
    const bot = ctx.bots.find((bot) => bot.platform === target.platform)
    if (!bot) throw new Error(`平台 ${target.platform} 没有已登录的机器人`)
    if (target.userId) await bot.sendPrivateMessage(target.userId, reply)
    else await bot.sendMessage(target.channelId!, reply)
    if (config.logging.sent) {
      logger.info('定时发送 [%s] | %s | 回复: %s', cmd.keyword, describeCronTarget(target), reply)
    }
  }

  /**
   * 执行一次定时任务: 运行指令 (可携带参数与模板覆盖), 按条件表达式决定是否推送。
   * 条件不满足或无可发送内容时不推送, 但仍输出执行结果日志 (受 sent 开关控制)。
   */
  async function runCronJob(job: CronJobConfig, cmd: PluginCommand) {
    const template = job.template?.trim() || undefined
    const { reply, note, vars } = await cmd.handle(job.arguments ?? '', template)
    if (!reply) {
      if (config.logging.sent) logger.info('定时任务 [%s] | 未产生回复%s', cmd.keyword, note ? ` (${note})` : '')
      return
    }
    if (job.conditions?.trim()) {
      let pass: boolean
      try {
        const conditions = parseConditions(job.conditions)
        // 指令未产出模板变量时以空记录求值 (变量缺失的比较结果均为 false);
        // 查询多个用电类型时任一类型满足即发送
        pass = (vars?.length ? vars : [{}]).some((entry) => evalConditions(conditions, entry))
      } catch (err) {
        logger.warn('定时任务 [%s] 的条件表达式无效 (%s): %s', cmd.keyword, job.conditions, err instanceof Error ? err.message : String(err))
        return
      }
      if (!pass) {
        if (config.logging.sent) logger.info('定时任务 [%s] | 条件不满足, 跳过发送 | 执行结果: %s', cmd.keyword, reply)
        return
      }
    }
    const delayMs = (job.delay?.time ?? 0) * (job.delay?.unit ?? 60) * 1000
    let first = true
    for (const raw of job.targets) {
      if (!first && delayMs > 0) await sleep(delayMs)
      first = false
      try {
        await pushToTarget(cmd, raw, reply)
      } catch (err) {
        logger.warn('定时任务 [%s] 发送到 %s 失败: %s', cmd.keyword, raw, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** 按下一次触发时间排程; 触发后重新排程, 随插件生命周期自动销毁 */
  function armCronJob(job: CronJobConfig, cmd: PluginCommand, spec: CronSpec) {
    const [next] = nextOccurrences(spec, 1)
    if (!next) {
      logger.warn('定时任务 [%s] (%s) 未来 4 年内没有触发时间, 已停止', cmd.keyword, job.expression)
      return
    }
    ctx.setTimeout(async () => {
      try {
        await runCronJob(job, cmd)
      } catch (err) {
        logger.warn('定时任务 [%s] (%s) 执行失败: %s', cmd.keyword, job.expression, err instanceof Error ? err.message : String(err))
      }
      armCronJob(job, cmd, spec)
    }, next.getTime() - Date.now())
  }

  for (const job of config.cron.jobs) {
    // 目标为空时任务不生效
    const targets = (job.targets ?? []).map((raw) => raw.trim()).filter(Boolean)
    if (!targets.length) continue
    job.targets = targets
    // 指令关键词缺省为查电费指令; 定时任务按关键词引用指令注册表, 新增指令自动可用
    const keyword = job.command?.trim() || config.keyword
    const cmd = commands.find((cmd) => cmd.keyword === keyword)
    if (!cmd) {
      logger.warn('定时任务的指令关键词不存在 (%s), 已跳过', keyword)
      continue
    }
    let spec: CronSpec
    try {
      spec = parseCron(job.expression ?? '')
    } catch (err) {
      logger.warn('定时任务 [%s] 的 cron 表达式无效 (%s): %s', keyword, job.expression, err instanceof Error ? err.message : String(err))
      continue
    }
    armCronJob(job, cmd, spec)
    logger.info('已注册定时任务: [%s] %s → %s', keyword, job.expression, targets.join(', '))
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

    ctx.console.addListener('node-cdut/cron-times', async (): Promise<CronJobPreview[]> => {
      return config.cron.jobs.map((job): CronJobPreview => {
        const expression = job.expression?.trim() ?? ''
        const targets = (job.targets ?? []).map((raw) => raw.trim()).filter(Boolean)
        const preview: CronJobPreview = {
          command: job.command?.trim() || config.keyword,
          arguments: job.arguments?.trim() ?? '',
          expression,
          targets,
          enabled: targets.length > 0,
          times: [],
        }
        if (!expression) {
          preview.error = '未设置 cron 表达式'
          return preview
        }
        try {
          preview.times = nextOccurrences(parseCron(expression), config.cron.preview).map((time) => time.toISOString())
        } catch (err) {
          preview.error = err instanceof Error ? err.message : String(err)
        }
        return preview
      })
    })
  })
}
