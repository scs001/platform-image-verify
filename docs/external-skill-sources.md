# 外部技能源（External Skill Sources）— 刀一

> openspec: `add-external-skill-sources`（刀一，只读镜像）。刀二（安装/多文件存储/治理知情确认）另立 change。

## 是什么

壹座扩展市场（Settings → 工具与技能）新增**「外部源」tab**：镜像外部技能市场的条目供发现。只读——没有任何安装路径，条目元数据不落盘、不进 pack、不进物化树；每个卡片带来源徽章、许可证三态 chip（declared / not-declared / unknown）与**「未经本平台审校」**标记。

与「商店」tab 的关系见 `openspec/specs/ecosystem-curation/spec.md`（外部镜像面是命名独立面，精选面的准入/排序/展示规则逐字节不变）。

## 源适配器契约

模块：`external-sources.js`（根目录，与 registry-bridge 平行，不耦合）。

- 每源两函数：`list(query, {limit})` 搜索、`get(slug)` 详情；返回归一化 Entry。
- Entry 关键字段：`source` / `originUrl` / `licenseState`（三态）/ `version` + `versionLayer`（版本取自哪层元数据——腾讯实测同一包两层版本互相矛盾，故记录来源层不判真伪）。
- 快照缓存：键 = 请求形状；TTL ≤ 1h；坏响应保留上一份好快照并标 `stale`（沿用 registry-bridge 姿态）；首次即失败 → 该源报 failed，不造数据。
- 聚合：`Promise.allSettled` 扇出，每源 top-N（`EXTERNAL_SOURCE_PAGE_SIZE`，默认 20，上限 50），按源分组原样返回；**浏览器永不直连外部 API**。
- 出站纪律：10s 超时、无凭据、平台 UA。

### 当前源清单

| id | 市场 | 鉴权 | licenseState | 说明 |
|---|---|---|---|---|
| `skillhub` | 腾讯 SkillHub（skillhub.cn） | 免鉴权 | unknown（API 无 license 字段） | search 无游标无 total，limit 即上限 |
| `smithery` | Smithery（api.smithery.ai） | 免鉴权 | unknown（许可证在上游仓库） | gitUrl 即 originUrl；~25k 条 |

### env 开关

- `EXTERNAL_SKILL_SOURCES`：csv 启用清单；**unset/空 = 全开**；未知 id 忽略；设为不存在的 id（如 `none`）= 全关 = 货架空。
- `EXTERNAL_SOURCE_PAGE_SIZE`：每源返回条数（默认 20，上限 50）。

### 端点

- `GET /api/extensions/external/sources` — 启用源清单
- `GET /api/extensions/external/search?q=` — 聚合搜索（按源分组）
- `GET /api/extensions/external/entry/:source/:slug` — 单条详情

全部只读 GET；写动词不存在（e2e 有只读断言钉死）。

## 上线核验（部署窗执行，未做不算完）

1. **prod 可达性**：从 cheap-* 生产节点 `curl https://api.smithery.ai/skills?pageSize=1`（本机可通不代表 CN 节点可通）。不通 → 该部署 `EXTERNAL_SKILL_SOURCES=skillhub` 关停 smithery，记台账。
2. **Smithery 再分发条款**：读其 terms/API 条款；刀一只读展示 + 来源归属徽章是本次依赖的合规底线；真镜像（刀二+）前必须复核。结论补记本文件。
3. **关源演练**：生产设 `EXTERNAL_SKILL_SOURCES=skillhub` 冒烟一次（smithery 组应消失且不报错），再恢复。

## 证据链（探索底稿，2026-10-14 四路调研 + 20 项亲手核验）

- **DeepSeek 无官方插件市场**：官方索引格式仅 proposal（`.agents/notes/proposed/.../2026-10-02-plugin-market-index-format.md`，原文 "No official market exists"）；客户端插件页只有安装无浏览；社区市场 awesome-dsh-plugin 索引真身在 GitHub 仓 `data/plugins/*.yml`（站点 plugins.json 传输截断不可依赖）。→ dsh 插件生态本 change 明确不接（宿主全权限代码，与 pack v1 边界、`dsh-adapter-boundary` allowlist 双冲突）。
- **SKILL.md 是事实标准**：agentskills.io 规范 6 字段，46 客户端（含 Codex/Gemini CLI/Cursor/Copilot）；腾讯 SkillHub 官方文档自述遵循同规范；实测腾讯包解包 = `SKILL.md + scripts/ + _meta.json` 多文件结构（刀二存储升格的直接动因）。
- **skills.sh 排除**：Vercel OIDC 硬墙（401 + docs 原文确认）；glama 需 API key + 数据许可条款；mcp.so 无 API（robots 禁）。
- **注入面**：本 change 为零（无落盘）；SKILL.md 正文进系统提示词的注入风险在刀二引入落盘时才出现，届时须带治理知情确认。
