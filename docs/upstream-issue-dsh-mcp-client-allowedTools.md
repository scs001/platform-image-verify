# 上游提案：`dsh-mcp-client` 增加 `allowedTools`（工具级过滤面）

> 递交对象：@deepseek-ai/dsh（dsh-mcp-client）。本文件是可直接递交的 issue 草稿（英文正文），随
> `add-mcp-tool-scoping` 设计 D1/附录产出。递交渠道由维护者定（GitHub issue 或内部）。

---

## Title

`dsh-mcp-client`: support per-server tool filtering at registration (`allowedTools`)

## Motivation

The MCP client bridge registers **every** tool a server's `tools/list` reports
(`mcp__<server>__<rawName>`). Large servers make this expensive: our platform's
registry hosts servers with 161, 71 and 52 tools, and a persona that needs
three of them still pays the full tool-schema surface in context tokens — on
128k-class windows this is a material fraction — plus measurably worse
tool-choice quality on weaker models.

Filtering is fundamentally a **client-side** concern: the context cost happens
at the client, and servers the client reaches directly (user-deployed, not
behind a filtering gateway) can be narrowed nowhere else.

Downstream platforms can approximate this today with `ctx.tools.restrict()`
per agent scope, but that path has real friction: `restrict()` throws on
unknown names (MCP tool sets are dynamic — drift between composition and
sync breaks the composition), it must be applied per-agent-scope after tool
sync, and the filtered tools still exist in the registry (guard-only
enforcement degrades to "visible but not callable").

## Proposal

Add an optional config field to both `StdioConfig` and `StreamableHttpConfig`:

```ts
/** Tool leaf names to register; omitted tools never enter the tool
 *  registry. Absent/undefined = register every tool (today's behavior). */
allowedTools?: string[];
```

Semantics we'd propose (and would be happy to contribute):

1. **Filter at tool synchronization**, not after registration: names not in
   the list are never registered — no schema in the model-facing roster, no
   execution path, nothing for `tool_search`-style introspection to see.
2. **Leaf names**, not public names: `serverName` is already the entry's own
   config; the list matches the raw name from `tools/list`.
3. **Re-applied on reconnect/resync**: a server adding tools after connect
   stays filtered; a server removing an allowed tool behaves exactly as it
   does today for any tool (the registration disappears).
4. **No failure on list drift**: unknown names in `allowedTools` are inert
   (the tool simply never appears), matching how a static list must behave
   against a dynamic server surface. A `failOnStartupError: true` entry whose
   server is unreachable fails exactly as today — the field is orthogonal.
5. Empty array = register nothing (an explicit "no tools" mount is useful:
   health-checking a server without exposing its surface).

## Non-goals

- Pattern/wildcard matching (exact names first; a platform needing patterns
  can expand them against its own catalog snapshot).
- Deny-lists (allow-only covers the declarative "this integration needs
  exactly these tools" case; per-user trimming is a UI concern on top).

## Alternatives considered

- `ctx.tools.restrict()` per scope: works today, but unknown-name throws +
  per-scope application + post-registration timing make it fragile for
  dynamic MCP surfaces (details above).
- A filtering local proxy per server: semantically clean but costs a process
  per filtered server and protocol-forwarding maintenance.
- Gateway-side filtering: only covers servers behind a filtering gateway;
  user-deployed servers are unreachable.

---

## 维护者备注（递交前删除）

- 我们的替身实现（桥：guard 硬闸 + restrict 尽力收窄）已上线于
  paas `add-mcp-tool-scoping`（`dsh-profile-template/platform-tool-scope.js`）。
  上游字段落地后，迁移点收敛在 `dsh-profile.js` 的 `toMcpClientEntry`
  （把 allowlist 直接写进 loader 条目 config），桥退化为 guard 兜底或移除。
- 验收基线：`scripts/test-tool-scope-bridge.mjs` 的语义（拦截永不 throw、
  收窄尽力、漂移双方向安全）即本提案的行为契约。
