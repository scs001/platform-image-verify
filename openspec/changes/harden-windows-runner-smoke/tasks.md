# Tasks: harden-windows-runner-smoke (paas)

## 1. Product fixes

- [x] 1.1 `dsh-profile-template/package.json`：补 `"version": "0.0.0"`（inventory identityFromManifest 要求非空 version）
- [x] 1.2 `agent-runner/manager.js` `sampleRssBytes`：win32 短路 return null（消灭每 poll ps 噪声）
- [x] 1.3 `.github/workflows/win-install-smoke.yml`：新增 Phase B+ runner 腿——打包环境起 agent-runner（AGENT_SERVING_REGISTRY_URL 指向 Phase B 的 server 本地 feed，LLM 键不注入）→ manifest body 装 minimal serving pack → `/api/wanxing/fleet/deployments` 部署 → 轮询 `/health` 直到 `children>=1` → 断言 dsh 子进程存活 ≥30s（抓 0xc0000142 类「子进程秒死」回归）

## 2. Verify & ship

- [ ] 2.1 `node scripts/test-wanxing-facade.mjs` 等受影响套件全绿；`openspec validate harden-windows-runner-smoke --strict` 过
- [ ] 2.2 显式路径提交；下一班 win-smoke 跑 Phase B+ 真证（workflow_dispatch）
