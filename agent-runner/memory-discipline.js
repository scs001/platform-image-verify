// The runner-side re-export of the single-source discipline text
// (fix-memory-capture-p0 D6): the canonical string lives at the repo root
// (memory-discipline.js) so the cell's preset persona suffix and the runner
// import the exact same bytes; this module keeps the runner's historical
// import path stable. The text is bilingual (zh + en) by decision — see the
// root module.

export { MEMORY_DISCIPLINE } from "../memory-discipline.js";

export function personaWithMemoryDiscipline(persona, memoryDiscipline) {
  return memoryDiscipline ? `${persona}${memoryDiscipline}` : persona;
}
