## 1. 数据面：provenance 三轴与许可门

- [x] 1.1 在 pack manifest 校验器（`lib/pack-manifest.js`）新增可选 `provenance` 结构 `{kind:"official-adopted", upstreamUrl, upstreamName, license, revision, adoptedBy, reviewedBy, reviewedAt}`，缺省保持旧行为；验证=旧 manifest 逐字节通过、新结构通过、`kind` 非法值被拒（单测）。**已实施**：`validateProvenance` + `PROVENANCE_KEYS/KINDS/LICENSE_RE/REVISION_RE/URL_RE`，`scripts/test-official-adoption.mjs` 6 条形状用例绿。
- [x] 1.2 实现唯一投影函数 `describeProvenance(pack)` 合成三轴（类型徽章来自 `lib/pack-badge.js` / 官方性来自 roster `OFFICIAL_AUTHOR_EMAILS` / 来源来自 manifest `provenance`），平台面与 facet 面都只读它；验证=类型×官方性×来源组合矩阵各一条断言；`deriveBadge` 与 roster 判定零改动（回归对拍）。**已实施**：`lib/pack-provenance.js`（`describeProvenance` / `describeShelfProvenance` / `PROVENANCE_SOURCE`），详情读 `GET /api/packs/:id` 已接；`community` 态不置键 → 旧 payload 逐字节不变。
- [x] 1.3 实现许可门：仅 MIT / Apache-2.0 / BSD 系放行，AGPL / 非商用 / 无声明硬拒且记失败轴与观测到的许可原文（或显式「未声明」）；**许可来源必须是上游包本身**，**不得读货架 `licenseState`（实测恒 unknown）**；多许可取最宽松；验证=四类样本 + 「货架 unknown 但上游 MIT 放行」+ 「MIT OR 非商用取 MIT」用例，拒绝时零副作用。**已实施**：`lib/license-gate.js`（`scanLicenseText` / `evaluateLicense` / `assertLicenseAdmissible`），含真实夹具（MCP 仓 NOASSERTION 元数据 + MIT/Apache 原文）。
- [ ] 1.4 让 provenance 越过 `preset-pack-bridge.js` 而不被丢弃——转正路径显式携带（不改桥自身语义）；验证=走转正路径产出的草稿含完整 provenance，走自建预设路径行为逐字节不变（回归）。**未做**：桥的消费侧尚未接（转正 mint 通道未建，见 2.x/阶段二）。

## 2. 取包与审校（复用既有链路）

- [x] 2.1 转正取包复用 `external-sources.js` 的 `fetchPackage`（SkillHub zip / Smithery GitHub contents），不新增适配器；验证=两源各取一枚真实包成功，多文件树与脚本标注与货架预览一致。**已验证**：复用既有链路、`test-external-install` 14/14 绿；未新增适配器。
- [x] 2.2 取包时同时取上游许可证据（包内 LICENSE / 仓库 LICENSE / package.json license），作为 1.3 许可门的输入并存入审校记录；验证=构造「货架 licenseState=unknown 但上游有 MIT LICENSE」的用例，判定以 LICENSE 为准且原文留档。**已实施**：`lib/upstream-license.js`（`collectUpstreamLicenseEvidence` / `licenseEvidenceFromPackage`），`scripts/test-upstream-license.mjs` 7/7 绿（含失效永不抛的 fail-closed 用例）。
- [x] 2.3 快照钉定：记录上游 commit sha，把正文 + 辅助文件树内联进 pack 版本，运行期不回源；验证=切断上游后该 Agent 仍能安装并物化出完整技能目录（构造上游 404 用例）。**已实施**：`lib/adoption.js` 的 `resolvePinnedRevision`（40-hex 直用不花请求 / 分支经 commits API 解析成 sha / 解析失败回落 ref 并如实标 `revisionKind:"ref"`，绝不假装钉住）+ `buildAdoptedManifest` 内联正文与辅助文件（SKILL.md 剔除、`safePackagePath` 过滤逃逸、frontmatter 经 `sanitizeFrontmatter`）；`test-adoption.mjs` 的 self-contained 用例直证「上游没了包仍完整」。**未做**：真实发布后的 pod 内物化实证（随出片班）。
- [x] 2.4 审校记录落库：adoptedBy / reviewedBy / reviewedAt 可读回，且转正包发布账号必须在 `OFFICIAL_AUTHOR_EMAILS` roster 内（否则 official 徽章不亮）；验证=查询一枚转正包返回三字段齐全，roster 外账号转正后 `official===false`。**已实施（核心）**：`adoptExternalSkill` 强制 operator 与 reviewer 双双在案（缺失即 `adoption-unattributed` 拒绝），三字段写入 `manifest.provenance` 随版本冻结（版本回滚不失真）；roster 约束由既有 `isOfficial` 天然生效——`describeProvenance` 对非 roster 恒判 community、`adopted` 置 null。**未做**：HTTP 端点层的 session 身份注入（发布仍走既有 publish 通道，身份与 roster 由它保证）。
- [x] 2.5 工具面默认收窄为 `chat`（复用 `lib/pack-manifest.js` 既有 tool-face tiers，不新增档位）；放宽需审校记录（理由 + 审校者）；验证=默认产出无 shell/文件/浏览器/子代理触达；放宽后仅显式声明的面生效。**已实施并加严**：真机发现首个候选 `nano-pdf` 是 CLI 工具（`requires.bins:["nano-pdf"]`），chat 面会产出「能说不能做」的残废 Agent → 新增 `detectCapabilityNeeds`，需要执行能力且未显式 `widenFullToolFace` 时 **`toolface-insufficient` 拒绝**；放宽时产物不声明 toolFace（全工具面），report 记 `capabilityNeeds` 与审校提示。`test-adoption.mjs` 覆盖拒绝与放宽两条。

## 3. 展示面

- [ ] 3.1 详情页与列表经 `describeProvenance` 渲染 adopted provenance：上游 URL、上游名、许可证、钉定 revision；验证=UI 眼见三态并列可辨（官方原创 / adopted / 生态·未审）。**半**：服务端投影已接（详情 payload 带 `provenance.{source,adopted}`）；前端未见。
- [ ] 3.2 facet 侧同构渲染（调同一 `describeProvenance`），且不削弱既有 curated 准入/排序（对拍开启与关闭该展示的 curated 列表逐字节一致）；验证=facet 单测对拍通过。**未做**。

## 4. 阶段一：手工转正 2–3 枚真案例

- [ ] 4.1 挑选 2–3 枚「真热门 × 真宽松许可 × 质量过硬」候选；验证=候选清单落盘，含上游 URL、许可证、钉定 sha、选择理由。
- [ ] 4.2 逐枚走完「取包 → 许可门 → 审校 → 铸官方 Agent（persona 起草 + chat 面）→ mint + 定价门 → 上架」全链；验证=每枚在精选市场可见且详情页 provenance 齐全。
- [ ] 4.3 用真实案例回校模型：若发现 provenance/许可/快照字段不够用，回改 1.1–2.4 的 spec 与实现并记录；验证=模型变更记入台账，spec 与实现同步。
- [ ] 4.4 上游更新演练一次：造一个上游修订 → 走 diff → 铸 vN+1 → 订阅者不自动漂移；验证=记录 diff 可见、旧订阅仍在旧版本、显式跟新后切换。

## 5. 收口

- [ ] 5.1 `openspec validate add-official-adopted-agents --strict` 全绿；验证=命令输出 0 错。
- [ ] 5.2 全量相关测试套（manifest / external-sources / curator 对拍）通过；验证=测试命令输出全绿。
- [ ] 5.3 更新 `docs/creating-packs.md` 增一节「官方转正（operator）」，写清许可门与 provenance 三态；验证=文档存在且与 spec 用语一致。
