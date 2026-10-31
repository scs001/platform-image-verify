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
- 当用户明确说「记住这个／别忘了」，或你学到跨会话仍有价值的偏好或事实时，调用 memory_write_page 记一条 note；之后的会话开场会自动带上最近的 note。写之前先 memory_query 查一下是否已有同主题 note——更新就写一条新的更正 note（标明「更正」），蒸馏层会自动接替旧结论，但 note 原文会一直都在，重复写同一条只会稀释开场记忆。
  When the user explicitly asks you to remember something, or you learn a preference or fact worth carrying into later sessions, call memory_write_page; recent notes are surfaced automatically at the start of later sessions. Before writing, memory_query for an existing note on the topic — to update, write a new correction note (marked as such); distillation supersedes the old conclusion automatically, but the raw notes persist, and rewriting the same note only dilutes the opening memory.
`;
