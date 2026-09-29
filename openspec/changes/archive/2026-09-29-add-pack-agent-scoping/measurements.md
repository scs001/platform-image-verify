# Measurements: add-pack-agent-scoping

Probe: `scripts/probe-pack-scope.mjs` (see its header for usage). Roster
numbers come from composing both patches against a deployment's real stores
and live-counting each server's tools (initialize + tools/list over the
patch's final transport config); token numbers come from `--turn-trace` (same
prompt, same model, both modes, usage read from the trace events).

## Local scratch deployment — 2026-09-29

Scratch cell (`/tmp`): repo mcp.json baseline (library, cron) + bundled
websearch; one installed pack (探测包, persona + 1 skill, no MCP refs); model
`deepseek/deepseek-v4.1-flash` via the token gateway.

### Roster (probe part 1)

| mode | servers | MCP tools | per-server |
| --- | --- | --- | --- |
| full | 3 | 9 | library 3, cron 4, websearch 2 |
| focused (probe-reviewer) | 2 | 7 | library 3, cron 4 |

Delta: −1 server, −2 MCP tools. Baseline (mcp.json) kept in both modes;
websearch (a bundled DB row, non-baseline) drops when focused.

### Turn trace (probe part 2)

Prompt: 「请用中文简要说明你能访问哪些工具和数据源，并举一个使用场景。」

| mode | inputTokens | cacheReadTokens | outputTokens | total |
| --- | --- | --- | --- | --- |
| full (standard) | 98 | 18 176 | 869 | 19 143 |
| focused (probe-reviewer) | 18 | 18 048 | 406 | 18 472 |

Delta: **−671 tokens/turn (−3.5 %)** — small because this cell's full roster
is tiny (2 schema-carrying servers). The output drop (−463) reflects the
focused persona enumerating a smaller surface in its answer.

A first uncached run measured full at 18 274 input tokens, confirming the
cache-read column is the same context replayed (gateway prompt cache).

## fd-prod expectation (rollout measurement — pending)

fd-prod's full roster was probed at 163+ MCP tool schemas; the focused band
target is ~20–40 tools. Run at rollout:

```bash
# roster comparison (server pod env: DB_PATH, MCP_CONFIG_PATH, DSH_HOME)
node scripts/probe-pack-scope.mjs
# token comparison (same prompt, same model, both modes)
node scripts/probe-pack-scope.mjs --turn-trace --url http://<fd-prod>
```

`PACK_BASELINE_MCP` (e.g. websearch there) shapes the focused floor; record
its value alongside the numbers when taken.
