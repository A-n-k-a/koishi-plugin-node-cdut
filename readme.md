# koishi-plugin-node-cdut

[![npm](https://img.shields.io/npm/v/koishi-plugin-node-cdut?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-node-cdut)

将成都理工大学服务接入 Koishi —— 对接 [NodeCDUT](../NodeCDUT) 接口服务的登录 (`/auth/login`) 与电费查缴 (`/paym/electricity/*`)。

## 功能

- 发送关键词 (默认 `查电费`) 查询寝室电费余额，可在消息中携带房间信息：
  - `查电费` —— 使用插件设置中的默认房间
  - `查电费 银杏园 1栋 512 空调` —— 园区 / `N栋` / 房间号 / `照明|空调`，缺省项回退到默认房间
- 凭据托管：首次调用自动登录，会话凭据 (X-Auth-Cookies blob) 持久化到插件目录下的 `session.json`；后续请求自动携带，响应带回新凭据时自动替换；`session_expired` 时自动重新登录并重试一次。凭据与账号绑定，修改账号后旧凭据自动作废。
- 控制台 **NodeCDUT** 页面：测试登录、测试房间查询 (可临时覆盖房间字段)。

## 配置

| 字段 | 说明 |
|---|---|
| `baseUrl` | NodeCDUT 服务地址，默认 `http://localhost:3000` |
| `username` / `password` | 统一身份认证账号 (学号) 与密码 |
| `room` | 默认房间：园区 / 用电类型 / 栋号 / 房间号 |
| `keyword` | 触发关键词 (指令名，不含空格)，默认 `查电费` |
| `replyTemplate` | 成功回复模板，变量: `{park}` `{type}` `{building}` `{room}` `{remain}` `{total}` `{canbuy}` `{project}` |
| `errorTemplate` | 失败回复模板，变量: `{error}` |
