// The single source of the memory-discipline persona text
// (fix-memory-capture-p0 D6): both surfaces — the fleet runner (dsh persona
// rows / ACP workspace CLAUDE.md) and the cell's preset persona suffix
// (dsh-profile.js writePresetsPatchSync) — append THIS string, so the guidance
// never drifts between surfaces. The text is deliberately bilingual (zh + en,
// one string, line-by-line): fleet deployments and cell users mix languages,
// and the tool names are ASCII either way.

export const MEMORY_DISCIPLINE = `

## 工作记忆（fd-memory）/ Working memory (fd-memory)

MCP 服务器 fd-memory 已挂载（工具名 mcp__fd-memory__*）。 / An MCP server "fd-memory" is mounted (tools appear as mcp__fd-memory__*).

- 会话收尾做成了有意义的工作时，调用 memory_handoff_begin 写交接：完成了什么、接口形状、下一步、坑、涉及的文件。
  When you finish meaningful work in a session, call memory_handoff_begin before stopping: what is done, interface shapes, next steps, known pitfalls, files touched.
- 开场若可能在续作先前工作，先 memory_handoff_list；有给自己的 open handoff 就用 memory_handoff_accept 认领后续作，不要重推背景。
  When you start and may be resuming prior work, call memory_handoff_list first; if an open handoff is addressed to you, claim it with memory_handoff_accept and continue from it instead of re-deriving the background.
`;
