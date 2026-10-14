// Unit coverage for the produced-file rule (openspec:
// wire-shell-produced-artifacts, task 1.3). Which files a turn produced is a
// question about the TOOL, and the rule that answered it before this change
// dispatched on nothing: it scanned a fixed set of argument keys and then the
// tool's RESULT TEXT, so `ls -la` contributed the files it listed and
// `zip -r bundle.zip src/` contributed `src/a.txt` (an input, read from zip's
// stdout) while missing `bundle.zip` itself.
//
// Node ≥23.6 strips the TS import natively (same approach as
// scripts/test-chart-fence-hash.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

const { producedFilePaths } = await import("../packages/core/src/lib/file-tool-paths.ts");
const { looksLikeFile, kindOf, resolveRef } = await import("../packages/core/src/lib/file-ref.ts");

const produced = (name, args) => producedFilePaths(name, args);

test("a file-writing tool contributes the file it wrote", () => {
  // Real shapes: dsh's `write` carries file_path + content; `edit` carries
  // file_path + old_string/new_string.
  assert.deepEqual(produced("write", { file_path: "/ws/report.md", content: "x" }), [
    "/ws/report.md",
  ]);
  assert.deepEqual(
    produced("edit", { file_path: "notes.txt", old_string: "a", new_string: "b" }),
    ["notes.txt"],
  );
  // An empty replacement still wrote the file (deleting text is an edit).
  assert.deepEqual(
    produced("edit", { file_path: "notes.txt", old_string: "a", new_string: "" }),
    ["notes.txt"],
  );
});

test("the rule keys on shape, not on a tool name", () => {
  // A harness this repo has never seen still contributes if its call supplies
  // content for a path — the point of not using a name allowlist.
  assert.deepEqual(produced("Write", { file_path: "/ws/a.md", content: "x" }), ["/ws/a.md"]);
  assert.deepEqual(produced("write_file", { path: "/ws/a.md", content: "x" }), ["/ws/a.md"]);
  assert.deepEqual(produced("create_file", { file: "/ws/a.md", text: "x" }), ["/ws/a.md"]);
  // ...and a call that names a path WITHOUT content is a reader, whatever it is
  // called: no content key, no contribution.
  assert.deepEqual(produced("write", { file_path: "/ws/a.md" }), []);
  assert.deepEqual(produced("some_future_reader", { path: "/ws/a.md" }), []);
});

test("the string-replace editor contributes its path only when it mutates", () => {
  // Real argument shapes: {command, path, ...}.
  assert.deepEqual(produced("str_replace_editor", { command: "create", path: "/ws/a.ts" }), [
    "/ws/a.ts",
  ]);
  assert.deepEqual(
    produced("str_replace_editor", { command: "str_replace", path: "/ws/a.ts", old_str: "x" }),
    ["/ws/a.ts"],
  );
  assert.deepEqual(produced("str_replace_editor", { command: "insert", path: "/ws/a.ts" }), [
    "/ws/a.ts",
  ]);
  // `view` only reads — the defect this rule fixes.
  assert.deepEqual(produced("str_replace_editor", { command: "view", path: "/ws/a.ts" }), []);
});

test("a file-reading tool contributes nothing", () => {
  // Each of these names a file in a real argument shape; none of them wrote it.
  assert.deepEqual(produced("read", { file_path: "/ws/a.ts" }), []);
  assert.deepEqual(produced("glob", { pattern: "**/*.ts" }), []);
  assert.deepEqual(produced("grep", { pattern: "foo" }), []);
  assert.deepEqual(produced("list_files", { path: "/ws" }), []);
});

test("a call with no content and no command contributes nothing", () => {
  // Default-deny in the sense that matters: nothing is reported unless the call
  // either declares an output (a shell command) or hands over content for a
  // path (a writer). A call that only names paths is a reader.
  assert.deepEqual(produced("some_future_tool", { path: "/ws/a.ts", file_path: "/ws/b.md" }), []);
  assert.deepEqual(produced("todo_write", { todos: [] }), []);
  assert.deepEqual(produced(undefined, { path: "/ws/a.ts" }), []);
  assert.deepEqual(produced("write", null), []);
  assert.deepEqual(produced("write", { content: "x" }), []); // content but no path
});

test("a shell command that archives contributes the archive", () => {
  assert.deepEqual(produced("bash", { command: "zip -r bundle.zip src/" }), ["bundle.zip"]);
  assert.deepEqual(produced("bash", { command: "tar -czf release.tar.gz dist/" }), [
    "release.tar.gz",
  ]);
  assert.deepEqual(produced("bash", { command: "gzip -k big.log" }), ["big.log"]);
  assert.deepEqual(produced("bash", { command: "cp report.pdf /ws/out/copy.pdf" }), [
    "report.pdf",
    "/ws/out/copy.pdf",
  ]);
});

test("a shell command that redirects contributes its target", () => {
  assert.deepEqual(produced("bash", { command: "make bundle > out.zip" }), ["out.zip"]);
  assert.deepEqual(produced("bash", { command: "cat a.txt b.txt >> merged.txt" }), ["merged.txt"]);
  // A descriptor redirect is not a file.
  assert.deepEqual(produced("bash", { command: "npm install 2>&1" }), []);
  // /dev/null is a sink.
  assert.deepEqual(produced("bash", { command: "make > /dev/null" }), []);
});

test("a read-only shell command contributes nothing", () => {
  // These are the shapes real transcripts actually contain.
  for (const command of [
    "pwd && ls -la",
    "ls -la && git status --short",
    "curl -s 'https://api.example.com/v1/forecast?format=json'",
    "git status",
    "sed -n '1,40p' count_1_to_40.txt",
    "wc -c < /ws/world.txt; od -c /ws/world.txt",
    "env | grep -iE 'dsh|mcp' | sort",
    "grep -rn 'memory' /ws/src | head",
  ]) {
    assert.deepEqual(produced("bash", { command }), [], `must contribute nothing: ${command}`);
  }
});

test("a command's output text is never a source of produced files", () => {
  // The rule takes only the command string, so a listing or log line cannot be
  // mistaken for a product — this was the false-positive mechanism.
  assert.deepEqual(produced("bash", { command: "ls -la", description: "List files" }), []);
  assert.deepEqual(produced("bash", { command: "zip -r bundle.zip src/" }), ["bundle.zip"]);
  // `src/a.txt` appears nowhere: it lived only in zip's stdout.
});

test("a producing verb names only the files the command itself mentions", () => {
  // A known residual: an input named alongside the output is reported too.
  // Pinned so the behavior is explicit rather than discovered.
  assert.deepEqual(produced("bash", { command: "zip -r bundle.zip src/a.txt" }), [
    "bundle.zip",
    "src/a.txt",
  ]);
});

test("a command that cd's elsewhere yields a token that resolution then drops", () => {
  // Two layers, and the split is deliberate. This rule reports the LITERAL
  // token the command named — `../bundle.zip` is relative to a directory that
  // exists only inside the command, and resolving that would need a shell
  // interpreter. The reference layer (resolveRef) refuses a leading escape, so
  // the token never reaches the strip: net effect is "contributes nothing",
  // which is the safe answer rather than a wrong path.
  const tokens = produced("bash", { command: "cd out && zip -q ../bundle.zip *" });
  assert.deepEqual(tokens, ["../bundle.zip"]);
  for (const token of tokens) {
    assert.equal(resolveRef(token, "/ws"), null, "an escaping token must not resolve");
  }
});

test("candidates are deduplicated and capped", () => {
  assert.deepEqual(produced("bash", { command: "zip a.zip a.zip" }), ["a.zip"]);
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.zip`).join(" ");
  const out = produced("bash", { command: `zip -r all.zip ${many}` });
  assert.ok(out.length <= 20, "capped at the server's lookup limit");
});

test("a shell call is recognized by its command argument, not its tool name", () => {
  // The persistent and pwsh variants are separate tool names with the same
  // argument shape; keying on the shape keeps them contributing.
  assert.deepEqual(produced("bash_persistent", { command: "zip -r b.zip src/" }), ["b.zip"]);
  assert.deepEqual(produced("pwsh", { command: "zip -r b.zip src/" }), ["b.zip"]);
  // A tool carrying no command string contributes nothing.
  assert.deepEqual(produced("bash", { description: "no command here" }), []);
});

test("archive and compression extensions are recognized produced-file types", () => {
  for (const name of ["a.tar", "a.gz", "a.tgz", "a.7z", "a.rar", "a.bz2", "a.xz", "a.tar.gz"]) {
    assert.ok(looksLikeFile(name), `${name} must count as a produced file`);
    // Recognized as produced, but the drawer cannot render them.
    assert.equal(kindOf(name), "none", `${name} has no renderer`);
  }
  assert.deepEqual(produced("bash", { command: "tar -czf release.tar.gz dist/" }), [
    "release.tar.gz",
  ]);
  assert.deepEqual(produced("bash", { command: "7z a pack.7z docs/" }), ["pack.7z"]);
});
