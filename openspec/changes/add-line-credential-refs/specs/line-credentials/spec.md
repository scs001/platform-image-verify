# line-credentials Specification

## Purpose

壹座侧的各产品线凭据轨道（wire-customer / lex / wanxing-caller 三 ref）：让 dsh 会话以
用户自己的身份调用各线操作 MCP。分两型——**短命 ID token 型**（wire-customer/lex：浏览器
PKCE 静默铸，上游验签，过期省略-重铸）与**长命 key 型**（wanxing-caller：粘贴 sk-，401
stale）。凭据只存服务端、只经注入路径出现。

## Requirements

### Requirement: Three line refs with type-specific lifecycle

壹座 SHALL 按 (identity, line) 各存一份凭据：line=wire-customer/lex 存 ID token（JWT，
含 exp），line=wanxing-caller 存 `sk-` key。任何响应/日志 SHALL NOT 含 token 明文或
sk- 前缀片段；投影只含 connected/stale/expiresAt。无凭据时对应 MCP server 行 SHALL
被省略并留按 ref 聚合的告警。

#### Scenario: 投影无密钥

- WHEN 任意连接状态被查询
- THEN 响应不含 ID token、sk- 或其片段

### Requirement: Short-lived ID tokens are omitted when expired and re-minted by the browser

wire-customer/lex 的 liveToken SHALL 仅在 token 未过期（余量 >0）时返回；过期或缺失 SHALL
返回 null（server 行省略）。重铸 SHALL 由浏览器会话驱动（PKCE+prompt=none 静默授权，各线
自己的 Logto app 与 audience——上游权威验签不改变）；服务端 SHALL NOT 代铸 ID token。
401 翻面 SHALL 清缓存（stale 语义不用于此型——重铸即愈）。

#### Scenario: 过期省略与自动恢复

- WHEN ID token 过期后发生 profile 写入
- THEN server 行省略；用户浏览器打开壹座时静默重铸，下次写入恢复注入

#### Scenario: 上游验签语义不变

- WHEN 注入的 ID token 被 wire/lex 校验
- THEN 签名/audience/组织门禁判定全在上游（服务不代判）

### Requirement: wanxing-caller paste semantics mirror the connector family

wanxing-caller SHALL 以 `sk-` 前缀校验粘贴（计费面板自铸的长命 key）；401 SHALL 置
stale 并提示重贴（网络失败不动缓存）。turn 工具经此凭据的计费边界结算语义不变——
凭据注入不改变 caller 的计费身份。

#### Scenario: 断开即省略

- WHEN 用户断开任意 line 且发生 profile 写入
- THEN 对应 server 行省略

### Requirement: Line connection routes are token-free

`GET /api/lines/:line/connection` SHALL 返回状态投影（connected/stale/expiresAt/line）；
`POST /api/lines/:line/credential` SHALL 按 line 校验形状（wire/lex=JWT 三段+可解析 exp；
wanxing-caller=`sk-` 前缀）后存储并触发 profile 重应用；未知 line SHALL 404。
DB 不可用 SHALL 退化为「未连接」。

#### Scenario: 未知线拒绝

- WHEN POST /api/lines/unknown/credential
- THEN 404
