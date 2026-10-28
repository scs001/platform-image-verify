// Chart WebView shell (task 4.2): the HTML an echarts option is posted into.
// Contract with the RN host (ChartView.tsx):
//   posts 'ready' once the shell can receive options (DOMContentLoaded),
//   posts 'ok'   after a successful echarts.setOption,
//   posts 'fail' on any render error (and stops trusting itself via __fail).
// echarts is VENDORED (app/src/lib/vendor/echarts-source.ts, 5.5.1) and inlined
// into the shell — no CDN. Two findings forced this: the acceptance emulator's
// WebView is Chrome 83 (echarts 6 fails to parse there, 2026-10-27) and its
// outbound network is unreliable (the CDN fetch failed → every chart degraded
// to the fallback state, 2026-10-28). A chart that needs the network is not a
// chart a customer can rely on, so the design's offline hardening path is now
// the default.

export function chartShellHtml(echartsSource: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}</style></head><body><div id="c" style="width:100vw;height:100vh"></div>
<script>${echartsSource}</script>
<script>
window.addEventListener('message', function(e){ try { render(JSON.parse(e.data)); } catch(err){ window.__fail=1; } });
function render(option){
  if (window.__fail || !window.echarts) { document.title='fail'; if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('fail'); return; }
  try {
    var chart = echarts.init(document.getElementById('c'));
    chart.setOption(option);
    document.title='ok';
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ok');
  } catch (err) {
    document.title='fail';
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('fail');
  }
}
document.addEventListener('DOMContentLoaded', function(){ if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ready'); });
</script></body></html>`;
}
