## 1. root manifest（proxy-addr + tar 两条 critical）

- [x] 1.1 `package.json` 新增 `overrides: { "@mapbox/node-pre-gyp": { "tar": "^7.5.22" } }`，然后 `npm audit fix`；`npm ls tar` 全树仅 7.5.22（6.2.1 消失）、proxy-addr 单一 2.0.8，`npm audit` 47（2c/22h/23m）→ **27（0c/8h/19m）**，8 个 high 全为 §5 豁免/推迟集
- [x] 1.2 三处夹带复核：`@hono/node-server` 2.1.5（MCP SDK 1.32.1 自带配对）、`@noble/hashes` 1.8.0（仅 electron-builder 构建链）、extraneous tencentcloud-sdk ×3 随重装消失且 `grep -rn tencentcloud` 源码零引用——写入 round-record §4；余 `@img/sharp-wasm32`/`@emnapi/runtime` 磁盘残留不进 lock（`npm ci` 不装）
- [x] 1.3 门：`test:unit` 首轮 2 红 = 既有基线（write-boundary 断言属 chat-interaction-round2 欠账→已修 6/6；official-packs-lint 12≠14 归 add-pack-subscribe-actions）；`npm update brace-expansion` 后补一轮 1.1.21（@electron/asar 链）；lint 基线红 ×7、biome 2.5.11 未变——终末全量复跑见 5.x

## 2. web manifest

- [x] 2.1 `web/` `npm audit fix`：11（6h/5m）→ **3（0h/3m）**；react-router(-dom) 7.18.1→7.18.4、vite 6.4.5、nanoid 3.3.20、postcss 8.5.31、source-map-js 1.2.2；剩 3 moderate = mammoth→argparse/sprintf-js 链（npm「修复」=降 0.3.29，否决）。typecheck 红 = `PackDetailDialog.tsx manifest.cluster` TS2339（bf3f5916 起的基线红，归 agent-cluster-platform 在途）
- [x] 2.2 门：`web:build:e2e` ✓（4.93s）；e2e fast 全量 486 过/15 红 → 复跑 13 过/2 红 → worktree 二分两红均归非本轮（§7 终判）

## 3. miniapp manifest（swiper + shell-quote + decompress 三条 critical）

- [x] 3.1 基线：`build:weapp` ✓（2.72s），dist 36 文件 sha256 清单 `/tmp/weapp-before.sha`
- [x] 3.2 `miniapp/package.json` overrides `swiper 12.1.2` + `npm audit fix` + `npm update glob`（提升实例 10.5.0）：`npm ls` = swiper 12.1.2 (overridden) / shell-quote 1.12.0；critical 仅剩 decompress（豁免）
- [x] 3.3 重建 weapp：**dist 36/36 文件 sha256 与基线字节级一致**（override+audit fix 后一轮、glob update 后再一轮均一致）；typecheck ✓（tsconfig ES2020→ES2021，见 §6：2a747fc8 起 TS2550 基线红，独立 commit 修）；`test:markdown` 10/10 ✓
- [x] 3.4 decompress 豁免写入 round-record §3（`@tarojs/cli → download-git-repo → download → decompress`，仅 `taro init` 可达，复查 = @tarojs/cli 弃用 download-git-repo）

## 4. facet/web 与 dsh-matrix

- [x] 4.1 `facet/web` `npm audit fix`（vite 6.4.4）：**0 残留**；`npm --prefix facet/web run build` ✓（2.04s）
- [x] 4.2 dsh-matrix 零改动：`git diff --stat dsh-matrix/` = 0；mcp client 2.0.0 ×2（dsh-mcp-client 精确钉）+ fflate 0.8.2（libreoffice-kit 精确钉）三条豁免入 round-record §5，复查 = dsh 换版

## 5. 轮次记录、提交与核销

- [x] 5.1 `notes/round-record.md`：前后计数表（§1）、两 critical 清法（§2）、nested major 清单（§4）、豁免/推迟全录（§5）、app/ 4 条移交 add-mobile-app、基线红证据链（§6）、测试门记录含 e2e 二分终判（§7）
- [ ] 5.2 显式路径提交（三个分车：test 断言修 / miniapp tsconfig 修 / 依赖轮本体+change 目录），`git diff --cached --name-status` 核对后推 origin；`docs/registry-maintenance.md` 记「安全轮次已入库、待下一班列车」
- [ ] 5.3 推送后 `gh api .../dependabot/alerts?state=open` 复核：5 份持有 manifest 的 critical=0（decompress 豁免除外）；计数写回 round-record
