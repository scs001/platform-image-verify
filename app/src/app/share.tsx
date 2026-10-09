// Share — placeholder for the 1.2 skeleton; task 5.1 fills in the public
// read-only shared-session view.

import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";

export default function ShareScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.page}>
      <Text style={styles.title}>{t("share.title")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper, padding: 20 },
  title: { fontSize: 22, fontWeight: "600", color: palette.ink },
});
