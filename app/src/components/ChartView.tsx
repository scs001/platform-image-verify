// Chart rendering (design D5): a controlled WebView hosting echarts, fed the
// option JSON over postMessage. Failure contract = the other clients':
// timeout or an echarts error degrades to the raw code block. v1 loads
// echarts from a CDN — charts only exist for data a reachable server sent —
// with a vendored offline copy as the v1.x hardening path.

import { useEffect, useRef, useState } from "react";
import { WebView } from "react-native-webview";
import { Text, View, StyleSheet } from "react-native";
import { palette } from "./palette";
import { CHART_SHELL } from "@/lib/chart-shell";

const SHELL = CHART_SHELL;

export function ChartView({ option, height = 220 }: { option: unknown; height?: number }) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Settled by the shell's postMessage('ok'|'fail') after setOption; without
  // it the 4s degrade timer flipped every healthy chart to the fallback.
  const settled = useRef(false);

  useEffect(() => {
    if (!ready || failed) return;
    settled.current = false;
    webRef.current?.postMessage(JSON.stringify(option));
    // The degrade contract: no confirmation within 4s = treat as failure.
    const t = setTimeout(() => {
      if (!settled.current) setFailed(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [ready, option, failed]);

  if (failed) {
    return (
      <View style={[styles.fallback, { height }]}>
        <Text style={styles.fallbackText} selectable>
          {JSON.stringify(option, null, 1).slice(0, 600)}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden", backgroundColor: palette.card, borderWidth: 1, borderColor: palette.line }}>
      <WebView
        ref={webRef}
        source={{ html: SHELL }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={(e) => {
          const data = String(e.nativeEvent.data);
          if (data === "ready") setReady(true);
          if (data === "ok") settled.current = true;
          if (data.includes("fail")) {
            settled.current = true;
            setFailed(true);
          }
        }}
        onError={() => setFailed(true)}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: palette.codeBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 10,
    justifyContent: "center",
  },
  fallbackText: { fontSize: 11, fontFamily: "Menlo", color: palette.muted, lineHeight: 15 },
});
