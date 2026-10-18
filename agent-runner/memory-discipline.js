// The single source of the memory-discipline persona text (add-fleet-memory-v1
// D7): both composition paths (dsh persona rows, ACP workspace CLAUDE.md)
// append THIS string so the guidance never drifts between harnesses.

export const MEMORY_DISCIPLINE = `

## Working-memory discipline

A fleet memory server is mounted as the MCP server "fd-memory" (tools appear as mcp__fd-memory__*).

- When you finish meaningful work in a session, call memory_handoff_begin before stopping: what is done, interface shapes, next steps, known pitfalls, files touched.
- When you start and may be resuming prior work, call memory_handoff_list; if an open handoff is addressed to you, claim it with memory_handoff_accept and continue from it instead of re-deriving the background.
`;

export function personaWithMemoryDiscipline(persona, memoryDiscipline) {
  return memoryDiscipline ? `${persona}${MEMORY_DISCIPLINE}` : persona;
}
