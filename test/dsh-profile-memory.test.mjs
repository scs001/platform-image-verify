// fix-memory-capture-p0 D6 — cell preset persona carries the (single-source,
// bilingual) memory-discipline text when the cell memory mount is configured,
// and the composition stays byte-identical when it is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

// DSH_HOME is read once at dsh-profile.js module load — pin it to a temp home
// BEFORE the dynamic import below so the deployment-singleton write lands
// nowhere real.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "fdm-presets-"));
for (const k of ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA"]) delete process.env[k];

const { writePresetsPatchSync } = await import("../dsh-profile.js");
const { MEMORY_DISCIPLINE: CELL_TEXT } = await import("../cell-memory.js");
const { MEMORY_DISCIPLINE: RUNNER_TEXT } = await import("../agent-runner/memory-discipline.js");

const extraPresets = [
  { id: "custom1", name: "Custom One", description: "d", persona: "你是自定义一号。" },
  { id: "custom2", name: "Custom Two", description: "d", persona: "你是自定义二号。" },
];

function personaRows(patchPath) {
  const patch = yaml.load(readFileSync(patchPath, "utf8"));
  const rows = [];
  for (const entry of patch) {
    for (const row of entry.insert ?? []) {
      if (String(row.id ?? "").startsWith("preset-")) {
        const persona = (row.config?.plugins ?? []).find((p) => p?.id === "persona");
        if (persona) rows.push({ preset: row.config.id, suffix: persona.config?.suffix ?? "" });
      }
    }
  }
  return rows;
}

test("P0 cell: single-source discipline is bilingual and identical on both surfaces", () => {
  assert.equal(CELL_TEXT, RUNNER_TEXT);
  assert.ok(CELL_TEXT.includes("工作记忆"));
  assert.ok(CELL_TEXT.includes("Working memory (fd-memory)"));
  assert.ok(CELL_TEXT.includes("memory_handoff_begin"));
});

test("P0 cell: mount off → presets patch carries no discipline (byte-identical baseline)", () => {
  const p = writePresetsPatchSync({ extraPresets });
  const text = readFileSync(p, "utf8");
  assert.ok(!text.includes("mcp__fd-memory__"));
  assert.ok(!text.includes("工作记忆"));
  const rows = personaRows(p);
  assert.ok(rows.length >= 3, `standard + 2 custom presets, got ${rows.length}`);
  for (const r of rows) assert.equal(r.suffix, "");
  process.env.__p0BaselinePatch = p;
});

test("P0 cell: mount on → every persona preset carries the discipline in the suffix", () => {
  process.env.CELL_MEMORY_ENABLED = "1";
  process.env.CELL_MEMORY_URL = "http://127.0.0.1:49999";
  process.env.CELL_MEMORY_PLATFORM_TOKEN = "plat";
  process.env.CELL_MEMORY_DATA = mkdtempSync(join(tmpdir(), "fdm-cellmem-"));
  const p = writePresetsPatchSync({ extraPresets });
  const rows = personaRows(p);
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    assert.ok(r.suffix.includes("memory_handoff_begin"), `${r.preset} missing discipline`);
    assert.ok(r.suffix.includes("Working memory (fd-memory)"));
  }
});

test("P0 cell: mount off again → identical bytes to the baseline write", () => {
  for (const k of ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA"]) delete process.env[k];
  const p = writePresetsPatchSync({ extraPresets });
  assert.equal(readFileSync(p, "utf8"), readFileSync(process.env.__p0BaselinePatch, "utf8"));
});
