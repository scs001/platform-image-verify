# Tasks — fix-supply-machine-faces

## 1. facet 宿主：机器路径不再被壳兜底

- [x] 1.1 在 `facet/index.js` 抽出机器面路径拒答清单（`/llms.txt`、`/llms-full.txt`、`/catalog.json`、`/robots.txt`），在 SPA 兜底之前判定并返回 404（`text/plain` 空体），清单导出为常量供测试复用 —— 验证：`node --test scripts/test-facet-machine-paths.mjs` 四路径均 404 且 body 不含 `<!doctype`
  - 实证：清单与中间件在 `facet/machine-paths.js`（`MACHINE_SURFACE_PATHS` / `isMachineSurfacePath` / `machineSurfaceGuard`），`facet/index.js:41,311` 在 `express.static` 与兜底之前挂载；`node --test scripts/test-facet-machine-paths.mjs` → **6 tests / 6 pass**（含大小写与尾斜杠变体、HEAD、POST 不误判）
- [x] 1.2 反向验证：把拒答清单临时清空 → 同一用例必须转红（四条路径回到 200 HTML）；恢复即绿 —— 验证：改前改后各跑一次，记录红/绿
  - 实证：把 `isMachineSurfacePath` 改为 `return false && …` → **2 条转红**（`matching ignores case…`、`machine paths answer 404…`），其余 4 条仍绿；恢复 → 6/6 绿。红的是「机器路径」那两条，不是无关用例
- [x] 1.3 人类路由回归：`/`、`/#/docs` 直链、未知路径仍返回壳文档；`/api/**` 仍走 API —— 验证：既有 `e2e` 壳用例与新增断言同绿
  - 实证：同一测试内 `human routes still reach the shell`（`/`、`/docs`、`/packs`、`/some/unknown/path` 均 200 text/html 且带 `<!doctype`）与 `the API plane is not intercepted`（`/api/ping` 200 JSON）绿

## 2. plaza 宿主：根路径四件套真的存在

- [x] 2.1 `scripts/deploy-plaza.sh` 发布步骤把 `generated/{llms.txt,llms-full.txt,catalog.json}` 与 `robots.txt` 落到站点根，并用目录内原子替换（先写 `.tmp` 再 rename）避免半套文件在线 —— 验证：脚本 dry-run 输出四路径与目标目录，无写入遗漏
  - 实证：落位逻辑独立成 `scripts/plaza-stage.sh`（deploy 通过 ssh stdin 送同一文件，本地测试跑同一文件）：解到同级 staging → 三份导出物 + robots.txt 写成 `.tmp` → 缺任一份 exit 1 → 站点内容覆盖 → 四个机器面最后逐个 `mv`（同 fs 原子）。原脚本只拷 `llms.txt`+`robots.txt`，`llms-full.txt`/`catalog.json` 从未落到根——这就是线上 404 的一半原因
- [x] 2.2 发布后自检：脚本末尾对四个根路径做 `curl -fsS` + content-type 断言（`text/plain` / `application/json`），任一不符即非零退出 —— 验证：故意删一个文件后脚本退出码非零且点名该路径
  - 实证：`deploy-plaza.sh` 新增 ③b：逐条 `curl -fsS -w '%{http_code} %{content_type}'`，断言 200 + 类型 + 非空 + body 不含 HTML 壳，任一失败 `exit 1`。单测 `scripts/test-plaza-machine-faces.mjs` → **2/2 绿**：①四件套逐字节等于 `generated/`；②缺 `catalog.json` 的包 → 落位 exit 1 且站点根上一版文件未动（原子性判据）
  - 附带修：`plaza-stage.sh` 里 `$f：`（变量名后接全角冒号）在 C locale 会把冒号字节吃进变量名 → unbound；统一改 `${f}`
- [ ] 2.3 线上实测记录：`agent.finddatatech.cloud` 四路径 200、类型正确、`/llms.txt` 首屏可读 —— 验证：curl 输出贴进 tasks 实证行
  - 现状实测（2026-11-09，修复前）：agent 四路径**全 404**；facet `/llms.txt` 与 `/catalog.json` **200 text/html**。修复上线后需复测并补记

## 3. plaza 导出：计数唯一口径 + 可重跑

- [x] 3.1 `scripts/plaza-export.mjs` 的 `llms.txt` 抬头改为按物种枚举逐项计数（pack / skill / mcp / facade / data-anchor），删除「agents」合称 —— 验证：生成物里 `grep -c "agents" ` 为 0，且五个物种名各出现一次
  - 实证：`buildLlmsTxt` 改为 `Five species: N packs, N skills, N MCP servers (N public tools), N facades, N official data anchors`；分节也拆成 Packs / Skills / MCP servers / Facades / Official data anchors 五段（原来 Packs+Facades+Anchors 合成一个 "Agents (577)" 段）。`catalog.counts` 补 `facades` / `officialData` 两键，与 `counts.json` 的 byCategory 同源
- [x] 3.2 `catalog.json` 与 `llms.txt` 的同一物种计数相等，且与 `counts.json` 相等 —— 验证：新增断言脚本，三个来源逐一比对
  - 实证：断言并入 `scripts/test-plaza-export.mjs`（复用既有 fixture，不复制夹具）新增用例 `llms.txt reports every species separately and no merged total`：五物种计数与 `catalog.counts` / `byCategory` 逐一等值，且 `/\b\d+ agents\b/` 与 `## Agents (` 均不得出现
- [x] 3.3 `generatedAt` 同时写进 `llms.txt` 抬头与 `catalog.json` 顶层，取自同一次导出 —— 验证：两处时间戳逐字节相等
  - 实证：同一用例断言 `llms.includes("As of: " + catalog.generatedAt)`；两处都来自 `runExport` 里同一个 `generatedAt` 变量
- [x] 3.4 现有 G1/G2/G3 门禁在计数口径改动后仍全绿（不合规即不写盘） —— 验证：跑一次导出，故意篡改一个物种计数 → 导出失败且目录未被改写
  - 实证：`node --test scripts/test-plaza-export.mjs` → **17/17 绿**，其中既有 G1 对账红例（`count reconciliation gate: any species mismatch red, zero artifacts`、`G1 facade count mismatch fails the build with zero artifacts`）继续绿，红例仍断言 `catalog.json` 不存在
  - 附带修：既有断言 `deepEqual(r.counts, {packs,skills,mcpServers,tools})` 因新增两键而红，改为含 `facades: 0, officialData: 0`

## 4. 新鲜度：定时再生成

- [x] 4.1 在部署面新增定时任务调用同一 `deploy-plaza.sh`，并发策略不可重入，周期值写在清单里可审 —— 验证：清单可读，周期与并发策略明确
  - 决策变更（D2 落地形态）：任务原文写的是「GitOps CronJob」，实际改为 **GitHub Actions 定时档** `.github/workflows/plaza-refresh.yml`。理由：导出器只读 facet 的公开 HTTPS 接口（`/api/packs`、`/api/skills-catalog`、`/api/mcp-catalog`、`/api/facades-catalog`、`/api/data-anchors-catalog`），不需要集群内网；而落位目标在雷池机的 Caddy 静态目录，集群内的 Job 反而要额外持有同一把 ssh 私钥与仓库检出。db 定时档复用 `deploy-plaza.sh` 全链路（导出→打包→上传→原子落位→四路径自检），不另写发布逻辑
  - 实证：`cron: "17 2,10,18 * * *"`（日三次，避整点）、`concurrency.group=plaza-refresh` + `cancel-in-progress: false`（不可重入）；密钥只需 `PLAZA_DEPLOY_HOST` / `PLAZA_DEPLOY_KEY`，缺 host 时**主动失败**而不是空跑
- [ ] 4.2 首轮自动跑通：记录 job 成功实例与产物 `generatedAt` 前进一次 —— 验证：两次 `generatedAt` 相差一个周期，且市场新增条目出现在 `catalog.json`
  - 阻塞：需先在仓库 Secrets 里配 `PLAZA_DEPLOY_HOST` / `PLAZA_DEPLOY_KEY`，并合并到默认分支后定时档才会调度
- [ ] 4.3 失败可见：故意让导出失败一次，旧快照继续服务且时间戳不变（不发布半套） —— 验证：失败实例日志 + 线上时间戳未变
  - 已具备的机制：导出器 G 门禁失败即 throw 且**不写盘**（`writeArtifacts` 在门禁之后）；`plaza-stage.sh` 缺件即 exit 1 且不动站点根。需要一次真实失败实例留档

## 5. CLI：不知道 id 也能走到 install

- [x] 5.1 `facet list` 读 `/api/packs`，输出 `id / name / version / category`，支持 `--base / --line / --limit / --json` —— 验证：`node --test facet/cli/test/list.test.js` 覆盖表格与 `--json` 两种输出，id 与 `install` 接受的形式逐字节一致
  - 实证：`facet/cli/facet.js` 新增 `listRun` / `fetchListing` / `printListing`；测试改为 `scripts/test-facet-cli-discovery.mjs`（跑真 CLI 子进程 + 本地 stub 目录，比单测函数更接近用户）：表格输出含 `id  v3  名称 · 线`，尾部给出 `install <id>` 且自部署时带 `--base`；`--json` 输出为服务端原始行（`rows[0].id` 与目录 id 相等）
- [x] 5.2 `facet search <query>` 复用市场查询语义，支持同上开关 —— 验证：`search 合同 --line lex` 只返回该线命中项；空结果输出显式「无匹配」而非空表
  - 实证：同一测试文件 `search` 用例：命中只出 lex 项；无命中输出 `无匹配：<base> 上没有匹配「…」的功能集`，且**不打印 install 提示**
- [x] 5.3 上游不可达：报出尝试的 base 与原因，且不打印半截目录 —— 验证：指向 `http://127.0.0.1:1` 跑 `list --base`，退出码非零、输出含该 base
  - 实证：`fetchListing` 捕获后抛 `目录不可达：<base>（原因）——未打印任何半截目录`；用例用一个已关闭端口验证退出码非零、输出含该 base、不含任何目录行
- [x] 5.4 `help` 与 `#/docs` 的命令表同步新增两条子命令（单一来源在 `cliFacts`） —— 验证：`facet help` 输出含 `list`/`search`，且 `DocsView` 渲染同一文本
  - 实证：USAGE 增两条用法行 + 一段子命令说明；`facet/web/src/cliFacts.ts` 增 `FACET_LIST_COMMAND` / `FACET_SEARCH_COMMAND`；`scripts/test-facet-docs-facts.mjs` 新增用例断言两个常量**确实对应 CLI 会分发的子命令**（`opts.command === "list|search"`）且 help 里有对应行——常量指向死命令即红
  - 差额（明记，不静默缩小）：`#/docs` 安装段的视觉编排（把 list/search 插进「找包→装」动线）未做——那是 UI 面，属 ②/市场收口那一批，需 locales 五语与 impeccable 流程
  - 补（8.2 收口时发现）：CLI 的**用户手册** `facet/cli/README.md` 原本没有 `list`/`search`，也没有 `update` 的来源市场说明——已补两节（含「目录不可达时点名地址、不打印半截目录」「自部署装的不被换成官方同名包」两条口径），否则功能只有 `--help` 里能看见

## 6. CLI：自部署不被带回官方市场

- [x] 6.1 `install` 把解析后的 base 写进 `installed.json` 的每条记录 —— 验证：`--base X` 安装后 `cat ~/.facet/installed.json` 含该 base
  - 实证：`install` 的 `recordInstall` 增 `base` 字段；用例断言 `recs.installs[0].base === <stub base>`
- [x] 6.2 `update` 按记录解析 base（显式 `--base` > 记录 > 官方），逐包报告实际来源 —— 验证：装自自建源后再 `update`，抓包里无官方域名请求（stub 断言）
  - 实证：`parseArgs` 增 `baseExplicit`；`update` 逐包解析 `opts.baseExplicit ? opts.base : rec.base || DEFAULT_BASE`，并打印 `来源 …（--base / 随记录 / 记录无 base，默认官方市场）`。用例把官方基址指到一个死端口，再跑无参 `update`：**成功**且 stub 收到请求、输出含「随记录」——若回落官方就会失败，所以绿灯本身是证据
- [x] 6.3 旧记录（无 base）回落到官方并在报告中明说 `base 默认` —— 验证：手写一条无 base 的记录，`update` 输出含该提示
  - 实证：用例手写 `{installs:[{…无 base…}]}`（注意记录文件形状是 `{installs:[…]}`，不是裸数组——第一版测试按裸数组写，CLI 读成"无记录"，是测试自己的错），断言输出含 `记录无 base` 与 `默认官方市场`
- [ ] 6.4 发版：走 OIDC trusted publishing 出 `@finddatatechnology/facet` 新版本 —— 验证：`npm view @finddatatechnology/facet version` 为新值，且 `npx ... facet list` 在干净 home 下可用
  - 阻塞：发版是对外动作（npm 上架），需你点头；`facet/cli/package.json` 版本号本批未动，建议随这批一起 bump

## 7. 文档：死链与自部署形态

- [ ] 7.1 把 `docs/ecosystem/client-matrix.md` 同步到公开仓（与既有六份 guide 同目录） —— 验证：公开仓该路径 200
- [x] 7.2 删除 `DocsView.tsx` 里 no-op 的 `.replace(/client-matrix\.md$/, "client-matrix.md")`，改由 `cliFacts` 单一来源产出矩阵链接 —— 验证：渲染出的 href 与 `cliFacts` 常量相等
  - 实证：`cliFacts.ts` 新增独立常量 `FACET_CLIENT_MATRIX_URL`（注释里点名它取代的那个 no-op 表达式）；`DocsView.tsx` 改为 `href={FACET_CLIENT_MATRIX_URL}`。反证：把 no-op 写法塞回去 → `scripts/test-docs-links.mjs` 的「matrix 单独常量 + 无 no-op replace」那条**转红**，恢复即绿
- [x] 7.3 `#/docs` 安装段并列展示官方与自部署（`--base`）两种命令 —— 验证：断言页面文本含 `--base`
  - 实证：每个客户端安装卡在官方命令下新增 `docs-install-selfhost-<target>` 一行，渲染 `${FACET_INSTALL_COMMAND} <packRef> --target <t> --base <your-facet-url>`；文案 `facetDocs.install.client.selfHost` 五语齐备（注意：facet 壳的文案在共享的 `web/src/locales/*`，不在 `facet/web/src/locales`——写错路径会静默不落盘）。`scripts/test-docs-links.mjs` 断言该形态存在
- [x] 7.4 链接存在性测试：docs 视图发出的每个深链路径都要在公开仓存在（在线查树，离线回落到签入的镜像清单） —— 验证：新增 `scripts/test-docs-links.mjs`，故意指向不存在路径 → 红
  - 实证：`scripts/test-docs-links.mjs` **4/4 绿**。判据是「链接指向的文件在不在」而不是「字符串长得对不对」：目标集从 `cliFacts` 的客户端表读出（六份指南一份不缺，`docs/ecosystem/` 是公开仓的镜像来源），再加矩阵指南、creating-packs、自部署一栏三条。反证两条已跑（no-op 表达式回归 → 红；缺指南 → 同一用例点名）

## 8. 收口

- [x] 8.1 `openspec validate fix-supply-machine-faces --strict` 绿 —— 验证：命令输出 `is valid`
  - 实证：`Change 'fix-supply-machine-faces' is valid`
- [x] 8.2 `npm run typecheck` + `npm run lint` + `npm run check:locales` 绿 —— 验证：三条命令退出码 0
  - 实证：typecheck 干净；biome 对 `facet/web/src/{DocsView.tsx,cliFacts.ts}` 零 finding；`check:locales` → `all 5 locales OK`（新增 `facetDocs.install.client.selfHost` 五语非空）
- [ ] 8.3 线上走查表：四 root 机器路径（plaza 200 / facet 404）、`#/docs` 矩阵链接可达、`facet list/search` 各一次真实输出 —— 验证：逐条贴输出
  - 阻塞：需要出片才能看线上；代码侧每一态已由单测/e2e 分别钉住
