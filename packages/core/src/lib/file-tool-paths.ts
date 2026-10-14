// Tool-call path extraction, shared by the web's preview affordance and the
// turn artifact strip (add-artifact-delivery) and the produced-file rule
// (wire-shell-produced-artifacts). Kept here (not in web-only code) so the mini
// program resolves tool paths through the SAME rule instead of a drifting copy
// — the same discipline the file-ref rule follows.
//
// Which files a turn produced is a question about the TOOL, not about whether a
// file path happens to appear in the call. A reader names a file it is reading;
// reporting that as a product is a false positive, and scanning a command's
// OUTPUT text produces them wholesale (a directory listing, a log line). So
// `producedFilePaths` dispatches on the tool and, for a shell call, reads only
// the command string — the one place a command declares what it writes.

// Extensions that mark a token as naming a file. One list, used by the path
// scan here and (as the broad produced-file set) by file-ref.ts, so the two
// cannot disagree about what a file looks like.
export const FILE_EXTENSION_SRC =
  "png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|log|md|markdown|csv|tsv|html?|docx|xlsx?|doc|pptx?|json|ya?ml|xml|zip|tar|gz|tgz|7z|rar|bz2|xz";

// The argument keys that can name the file a call operates on. Shared by the
// shape rule below; a harness spelling it `file` or `filename` is admitted for
// the same reason a new tool name is.
const PATH_KEYS = ["file_path", "path", "filepath", "file", "filename", "output", "target"];

// The argument keys that carry the CONTENT a call is writing. Their presence
// alongside a path is what distinguishes a producer from a reader — the
// discriminator that does not depend on what the tool is called.
const CONTENT_KEYS = [
  "content",
  "file_text",
  "new_string",
  "new_str",
  "text",
  "contents",
  "body",
  "data",
];

// Tools whose `command` argument is a MODE, not a command line. Their paths are
// handled by their own branch rather than by the shell scan.
const MODE_COMMAND_TOOLS = new Set(["str_replace_editor"]);

// A path-shaped token: an optional ./ or / prefix, word/dot/dash body, and a
// recognized final extension. Built fresh per scan — a module-level /g regex
// carries lastIndex between calls.
const PATH_TOKEN_SRC = `(?:[.~]?\\/)?[\\w./-]*[\\w-]\\.(?:${FILE_EXTENSION_SRC})`;

function pathTokens(text: string): string[] {
  return [...text.matchAll(new RegExp(PATH_TOKEN_SRC, "gi"))].map((m) => m[0]);
}

// Commands that declare an output among their arguments. A command that
// produces a file through something not on this list (`make`, `python -c`, a
// bespoke script) contributes nothing unless it redirects; the list is one
// constant to extend when a real case shows up.
const PRODUCING_VERBS = new Set([
  "zip",
  "tar",
  "gzip",
  "7z",
  "rar",
  "cp",
  "mv",
  "rsync",
  "pandoc",
  "ffmpeg",
  "convert",
  "soffice",
  "dd",
  "split",
]);

// Wrappers that sit in front of the real verb (`sudo zip …`). Skipped when
// finding a segment's verb, so the wrapper does not hide it.
const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "nice", "time", "nohup"]);

// A redirection target is an output by construction. Stops at shell operators,
// so `2>&1` (a descriptor) matches nothing and `< input` is not considered.
const REDIRECT_RE = />>?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;

// Segment separators: a command may run several programs, each with its own
// verb (`cd out && zip -r …`).
const SEGMENT_SPLIT_RE = /&&|\|\||[;|]/;

// The server caps a status lookup at 20 paths (LOOKUP_MAX_PATHS); capping here
// too keeps a pathological command from pushing a real artifact off the list.
const MAX_CANDIDATES = 20;

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

// Candidates from a shell command string. Two output signals admit one: an
// explicit redirection, or a producing verb in the segment. Neither present —
// `ls -la`, `curl …`, `git status`, `sed -n '1,40p' f`, `wc -c < f` — yields
// nothing, which is the point: those commands write no file.
function commandCandidates(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(REDIRECT_RE)) {
    const target = unquote(m[1] ?? "");
    // /dev/null and friends are sinks, not files.
    if (target && !target.startsWith("/dev/")) out.push(target);
  }
  for (const segment of command.split(SEGMENT_SPLIT_RE)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && COMMAND_PREFIXES.has(tokens[i] ?? "")) i++;
    // A leading path (`/usr/bin/zip`) still names the verb.
    const verb = (tokens[i] ?? "").split("/").pop() ?? "";
    if (!PRODUCING_VERBS.has(verb)) continue;
    for (const token of pathTokens(segment)) out.push(unquote(token));
  }
  return out;
}

// The files this tool call produced, deduplicated and capped. `name` is the
// tool that ran; `args` its parsed arguments. The call's RESULT is deliberately
// not a parameter: output text naming a file is not evidence the call made it.
//
// The discriminator is SHAPE, not a tool-name list. A call that supplies
// content for a path is writing that file; a call that supplies only a path is
// reading, listing, or searching it. Names were tried first and rejected: the
// platform is going multi-harness (Claude Code's `Write`, Gemini's
// `write_file`, dsh's `write`), and a name allowlist drops a harness silently
// the day it is added — the failure mode this whole change is about.
export function producedFilePaths(name: unknown, args: unknown): string[] {
  const tool = typeof name === "string" ? name : "";
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const str = (key: string): string | null => {
    const v = a?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  // Present-and-non-null, so an empty replacement still counts: `edit` with an
  // empty new_string deletes text, and it wrote the file to do it.
  const present = (key: string): boolean => a?.[key] != null;

  const candidates: string[] = [];

  // A shell call. Its command string is the only place a shell declares what it
  // writes. `str_replace_editor` also carries a `command`, but its value is a
  // mode name (`view`/`create`), not a command line — excluded here and handled
  // by its own branch below.
  const command = str("command");
  if (command && !MODE_COMMAND_TOOLS.has(tool)) {
    candidates.push(...commandCandidates(command));
  }

  // A call that hands over content for a path is producing that path, whatever
  // the tool is called. This is what admits a writer from a harness this repo
  // has never seen, and what keeps `read`/`glob`/`grep` out (they carry no
  // content).
  const path = PATH_KEYS.map(str).find((p): p is string => Boolean(p)) ?? null;
  if (path && CONTENT_KEYS.some(present)) candidates.push(path);

  // `str_replace_editor` in a mutating mode: its path is the target regardless
  // of which content key the mode uses. `view` only reads.
  if (MODE_COMMAND_TOOLS.has(tool) && a?.command !== "view") {
    const p = str("path");
    if (p) candidates.push(p);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
