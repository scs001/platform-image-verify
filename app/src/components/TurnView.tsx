// One turn of the transcript. User turns are quiet bubbles; assistant turns
// walk the block stream — text through Markdown, thinking as a one-line
// collapsed affordance, tool/skill/command activity grouped into ONE
// collapsed row that opens on demand or on error (the activity-groups
// contract), errors as inline red text. Copy/regenerate actions live on the
// chat screen's long-press menu (kept out of the turn for v1 simplicity).

import { useMemo, useState } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import {
  groupTurnBlocks,
  groupHasPendingAsk,
  isGroupOpen,
  groupHasError,
  useChatStore,
  type Turn,
} from "@platform/core";
import { Markdown } from "./Markdown";
import { palette } from "./palette";

function ToolGroupRow({ turn, group }: { turn: Extract<Turn, { role: "assistant" }>; group: ReturnType<typeof groupTurnBlocks>[number] }) {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const errored = groupHasError(group);
  const openByAsk = groupHasPendingAsk(group, pendingQuestion);
  const [manualOpen, setManualOpen] = useState(false);
  const open = manualOpen || isGroupOpen(turn, group) || errored || openByAsk;
  const label = group.blocks[0];
  return (
    <View style={styles.groupWrap}>
      <Pressable style={styles.groupHeader} onPress={() => setManualOpen(!open)}>
        <Text style={[styles.groupGlyph, errored && { color: palette.danger }]}>
          {errored ? "✕" : "⚙"}
        </Text>
        <Text style={styles.groupTitle} numberOfLines={1}>
          {label?.kind === "tool" || label?.kind === "skill" || label?.kind === "command"
            ? `${label.name} · ${group.blocks.length} 步`
            : `活动 · ${group.blocks.length} 步`}
        </Text>
        <Text style={styles.groupChevron}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open && (
        <View style={styles.groupBody}>
          {group.blocks.map((b, i) => (
            <Text key={i} style={styles.groupLine} numberOfLines={3}>
              {b.kind === "tool" && `${b.state === "error" ? "✕ " : ""}${b.name}(${JSON.stringify(b.args).slice(0, 120)})`}
              {b.kind === "skill" && `✦ ${b.name}`}
              {b.kind === "command" && `$ ${b.name}`}
              {b.kind === "text" && b.text.slice(0, 160)}
              {b.kind === "thinking" && `·· ${b.text.slice(0, 120)}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// Local structural import of the ask-pending check (core exports it).

export function TurnView({ turn }: { turn: Turn }) {
  const groups = useMemo(
    () => (turn.role === "assistant" ? groupTurnBlocks(turn.blocks) : []),
    [turn],
  );
  if (turn.role === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>
            {turn.text}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantRow}>
      {groups.map((g, i) => {
        const first = g.blocks[0];
        if (g.blocks.length === 1 && first.kind === "text") {
          return <Markdown key={i} text={first.text} />;
        }
        if (g.blocks.length === 1 && first.kind === "error") {
          return (
            <Text key={i} style={styles.errorText}>
              {first.message}
            </Text>
          );
        }
        if (g.blocks.length === 1 && first.kind === "thinking") {
          return (
            <Text key={i} style={styles.thinking} numberOfLines={first.open ? undefined : 1}>
              {first.open ? first.text : `思考中… ${first.text.slice(0, 60)}`}
            </Text>
          );
        }
        return <ToolGroupRow key={i} turn={turn} group={g} />;
      })}
      {turn.streaming && <Text style={styles.cursor}>▍</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 6 },
  userBubble: {
    backgroundColor: palette.primary,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "85%",
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 22 },
  assistantRow: { paddingVertical: 6, gap: 4 },
  errorText: { color: palette.danger, fontSize: 14, lineHeight: 20 },
  thinking: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  cursor: { color: palette.primary, fontSize: 15 },
  groupWrap: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    marginVertical: 4,
    overflow: "hidden",
  },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  groupGlyph: { fontSize: 14, color: palette.muted },
  groupTitle: { flex: 1, fontSize: 13, color: palette.ink },
  groupChevron: { fontSize: 12, color: palette.muted },
  groupBody: { borderTopWidth: 1, borderTopColor: palette.line, padding: 10, gap: 6 },
  groupLine: { fontSize: 12, lineHeight: 17, color: palette.muted, fontFamily: "Menlo" },
});
