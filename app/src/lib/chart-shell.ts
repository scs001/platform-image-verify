// Chart WebView shell (task 4.2): the HTML an echarts option is posted into.
// Contract with the RN host (ChartView.tsx):
//   posts 'ready' once the shell can receive options (DOMContentLoaded),
//   posts 'ok'   after a successful echarts.setOption,
//   posts 'fail' on any render error (and stops trusting itself via __fail).
// The CDN is pinned to echarts 5.5.x on purpose: the CI emulator's Android
// System WebView is Chrome 83 (2020) and echarts 6's bundle fails to parse
// there, which flipped every mobile chart to the fallback state on the first
// acceptance run (2026-10-27). 5.5's dist is the broad-compatibility build.
// A vendored offline copy remains the v1.x hardening path (design risk log).

export const CHART_SHELL = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}</style></head><body><div id="c" style="width:100vw;height:100vh"></div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js" onerror="window.__fail=1"></script>
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
