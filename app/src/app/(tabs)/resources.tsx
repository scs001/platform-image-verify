// Resources tab — placeholder for the 1.2 skeleton; task 4.3 replaces it with
// the library list + chart preview surface.

import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";

export default function ResourcesScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.page}>
      <Text style={styles.title}>{t("resources.placeholderTitle")}</Text>
      <Text style={styles.body}>{t("resources.placeholderBody")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper, padding: 20, gap: 8 },
  title: { fontSize: 22, fontWeight: "600", color: palette.ink },
  body: { fontSize: 14, color: palette.muted, lineHeight: 20 },
});
