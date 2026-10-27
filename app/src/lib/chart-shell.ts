// Chart WebView shell (task 4.2): the HTML an echarts option is posted into.
// Contract with the RN host (ChartView.tsx):
//   posts 'ready' once the shell can receive options (DOMContentLoaded),
//   posts 'ok'   after a successful echarts.setOption,
//   posts 'fail' on any render error (and stops trusting itself via __fail).
// v1 loads echarts from a CDN — charts only exist for data a reachable server
// sent — with a vendored offline copy as the v1.x hardening path.

export const CHART_SHELL = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}</style></head><body><div id="c" style="width:100vw;height:100vh"></div>
<script src="https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js" onerror="window.__fail=1"></script>
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
