# koishi-plugin-node-cdut

[![npm](https://img.shields.io/npm/v/koishi-plugin-node-cdut?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-node-cdut)

将成都理工大学服务接入 Koishi —— 对接 [NodeCDUT](https://github.com/A-n-k-a/NodeCDUT) 接口服务。

## 功能

- **查电费** (默认关键词 `查电费`):
  - `查电费` —— 使用插件设置中的默认房间
  - `查电费 银杏园 1栋 512 空调` —— 园区 / `N栋` / 房间号 / `照明|空调`，缺省项回退到默认房间
  - 指定了房间信息但未指定照明/空调时，两者都查询（逐行回复）
- **充电费** (默认关键词 `充电费`): 必须指定用电类型和金额，房间可选
  - `充电费 空调 50元`、`充电费 银杏园 1栋 512 照明 0.01`
  - 创建真实待支付订单（自动关闭同项目未完成订单），回复含支付链接
- **凭据托管**：首次调用自动登录，会话凭据持久化到插件目录下的 `session.json`；后续请求自动携带，响应带回新凭据时自动替换；凭据过期时自动重新登录并重试。凭据与账号绑定，修改账号后旧凭据自动作废。
- **控制台 NodeCDUT 页面**：测试登录、测试房间查询 (可临时覆盖房间字段，用电类型可选「照明和空调」)。

## 配置

| 字段 | 说明 |
|---|---|
| `baseUrl` | NodeCDUT 服务地址，默认 `http://localhost:3000` |
| `username` / `password` | 统一身份认证账号 (学号) 与密码 |
| `room` | 默认房间：园区 / 用电类型 (含「照明和空调」) / 栋号 / 房间号 |
| `prefix` | 指令前缀，任意字符串（如 `！`、`/`），留空（默认）表示不使用；设置后仅 `前缀+关键词` 可触发 |
| `keyword` / `chargeKeyword` | 查询 / 充值触发关键词，默认 `查电费` / `充电费` |
| `replyTemplate` | 查询成功模板，变量: `{park}` `{type}` `{building}` `{room}` `{remain}` `{total}` `{canbuy}` `{project}` |
| `chargeTemplate` | 充值下单模板，变量: `{amount}` `{park}` `{type}` `{building}` `{room}` `{orderNo}` `{orderId}` `{payLink}` `{closeTime}` |
| `errorTemplate` | 失败模板，变量: `{error}` |
| `cache` | 指令缓存（时长数值 + 单位：秒/分钟/小时，默认 15 分钟，0 关闭）：相同指令在缓存期内直接回复缓存结果，不触发接口请求 |
| `rateLimit` | 消息限流（时长数值 + 单位，默认 0 即关闭）：一个时间窗口内插件只响应一条指令 |
