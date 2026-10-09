// Settings — placeholder for the 1.2 skeleton; task 5.2 fills in instance
// reachability, unbind-and-switch, language switch, and version info.

import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";

export default function SettingsScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.page}>
      <Text style={styles.title}>{t("settings.title")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper, padding: 20 },
  title: { fontSize: 22, fontWeight: "600", color: palette.ink },
});
