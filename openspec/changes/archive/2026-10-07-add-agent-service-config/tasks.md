# add-agent-service-config — Tasks

## 1. Manifest 契约扩展

- [x] 1.1 `lib/pack-manifest.js` 增可选 `serving.model`（声明默认模型）与 `serving.modelWhitelist`（作者白名单）字段及校验，单测覆盖合法形状、非法模型串/白名单形状拒绝、旧 manifest（无新字段）照常通过
## 2. Descriptor 真源与 registry 写面

- [x] 2.1 `lib/agent-serving.js` + `gateway/packs.js`：descriptor `metadata` 增 `config_overrides`（稀疏）与 `effective_model`；部署动作把请求携带的 rhythms/budget/model 记为初始 `config_overrides`（deploy-time model 过与后写同款的写时车道校验），单测覆盖覆盖入档、未授权车道拒部署
- [x] 2.2 facet 部署面新增配置读写路由：GET 返回各维度生效值+来源（已覆盖/跟随声明），PUT 校验门禁（部署者/管理员放行、非部署者作者拒绝）+ 车道校验（部署键 group 车道 ∩ 作者白名单，拒绝指明违反约束）后写 `config_overrides` 并重算 effective，单测覆盖三个门禁场景与三校验场景
- [x] 2.3 升级路径重解析：upsert 用 `config_overrides` 对新版本 manifest 重算 effective 并回写，单测锁定"已覆盖跨升级保留、未覆盖跟随新默认、模型跨升级持久"
## 3. Runner 逐 child 模型（ADR-0019）

- [x] 3.1 `agent-runner/` child 派生 `effective_model ?? AGENT_RUNNER_LLM`，模型串经 `LLM_PROVIDERS_STORE` 路由解析，单测覆盖回落默认、路由命中
- [x] 3.2 manager 轮询 diff：`effective_model` 变化触发升级同款排水重生（复用 drain/respawn 通道，排水期新回合得明确排水错误），单测 + staging runner 排演验证五分钟窗内重生且新模型生效
## 4. Console API（双镜像）

- [x] 4.1 fd-wanxing `services/wanxing-facade/console.js` 加 `GET/PUT /api/wanxing/v1/console/deployments/:slug/config` 透写 facet 路由（仿 pauseAction 写通路与门禁），probe 脚本以部署者会话验证读改读
- [x] 4.2 paas `gateway/wanxing/console.js` 镜像同步同端点，与 fd-wanxing 版对拍（同部署同返回形状）
## 5. 管理界面

- [x] 5.1 fd-wanxing `wanxing-web` ConsoleView 增 agent 详情区：生效值 + 来源徽记 + 节奏/预算/模型（下拉=车道校验通过集）/卡片 name·description 行内编辑，组件测试覆盖来源徽记与提交回显
- [x] 5.2 壹座 web `PackDetailDialog` 部署区在已部署状态显示"去配置"深链至萬星 console agent 详情，组件测试覆盖深链出现条件
## 6. 集成验收与上线

- [x] 6.1 本地 lint/unit/build 全绿；e2e 走 GitHub CI（fast lane）：console 会话改节奏 → descriptor 五分钟窗生效、改模型 → 排水重生，两用例入 CI 且首跑绿
- [x] 6.2 三部署清单同滚（platform/facet/wanxing，ADR-0018 惯例）+ 上线探针：改节奏无感生效、改模型排水重生、模拟升级保留覆盖，三项全绿
- [x] 6.3 `openspec validate --strict` 绿后归档本 change，归档前跑 sync 校验（`validate --specs`，a2a-agent-serving/agent-runner 主 spec 并入核对）

---

## 实施留档（2026-10-07）

实现全部落地，本地可验门全绿；三处与任务文面的偏差/替换如实记录：

- **e2e 形态（6.1）**：fast lane 无 runner 进程，故 e2e 两用例为「部署→配置读写→descriptor 实证」+「模型写入无计费面即 fail-closed」；**改模型→排水重生**的验证在 CI 的单测面（`scripts/test-agent-runner.mjs`，真 manager 直驱，已绿）。e2e 尚待 push 入 CI 首跑（共享工作树，push 需用户点头）。
- **4.2 偏差**：console 面在 slice ② 已抽取到 fd-wanxing，paas 侧不存在 `gateway/wanxing/console.js`；等价交付 = packs 面带会话身份的用户门 + 内网孪生门（2.2 内实现并测试），双门同一内核（configReadCore/configWriteCore），"对拍"由构造保证。
- **5.1/5.2 验证替换**：两 web 仓无组件测试基建（无 vitest/jest）；以 build + typecheck（+ 万星 console 真身份链路的 fd-wanxing 测试）替代，浏览器级走查留用户验收。
- **本地证据**：paas 单测 855/855（含新增 serving 41、runner 36）、typecheck、check:locales、lint exit 0（仅 warnings）、双 web build 绿；fd-wanxing 套件 53/53；e2e registry stub 的 agent-entry 面独立冒烟通过（register/GET/PUT/404/401）。

## 上线留档（2026-10-07 深夜）

三轮发布循环（f37ab11 → 3de4a42 → ed35a84；GitOps 三清单同滚 + 万星 facade/web ebd610f；cheap1 runner 容器同镜像换版），**上线探针实抓三个测试面抓不到的真缺口，全部修复并复验**：

1. **facet-proxy 剥 actor 头**：代理重建固定头集，`x-acting-user/groups` 经平台域 `/api/packs/*` 代理后丢失 → facet 内网门 400。修复=补转发两枚头 + 端到端单测（3de4a42）。
2. **runner 容器重建丢 `--user root`**：profile 物化 EACCES（存量 home 全 root、镜像默认 node）。修复=按旧容器身份重建；真实 A2A 回合复验通过。另记：镜像默认 HEALTHCHECK 探 cell 角色 3000/api/config，runner 角色恒展示 unhealthy（无编排器动作，纯展示层，后续可 `--no-healthcheck` 或改探 runner 面）。
3. **配置写 PUT 缺 Content-Type**：真 registry（FastAPI）严格解析 → 整包 422；register 回落同缺头。双修（补头 + 回落阶梯 + e2e stub 镜像严格解析进 fast lane，ed35a84）。

**探针实证（daas-analyst，全走生产链）**：读面 200（budget 40 声明值、lanes=部署键真车道 33 条）；模型写 200（车道校验通过）→ 20s 轮询日志 `descriptor changed; draining old child` → 触碰重生（cold-starting）→ 新模型行为可见 → 还原（model null）→ 再排水重生 → 回复正常（"还原"）；真回合双凭据 A2A 全程可用。节奏写向由并行会话同链实证（2h→3h 写入成功）。**升级保留覆盖**留在 CI 单测面（live 升级需部署者会话，未在 CLI 通道可达）。

遗留：daas-analyst 上留有并行会话探针的 rhythm 覆盖 `[{every:"3h"}]` 与 model null 标记——rhythm 属其探针沉淀，交由收尾会话/用户决定清零。