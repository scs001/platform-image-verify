// Chat tab — placeholder for the 1.2 skeleton; the full chat lane (streaming,
// composer, history, selection) lands with task 3.2. The header carries the
// connection affordances the real page will keep.

import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";

export default function ChatScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.page}>
      <Text style={styles.title}>{t("chat.placeholderTitle")}</Text>
      <Text style={styles.body}>{t("chat.placeholderBody")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper, padding: 20, gap: 8 },
  title: { fontSize: 22, fontWeight: "600", color: palette.ink },
  body: { fontSize: 14, color: palette.muted, lineHeight: 20 },
});
