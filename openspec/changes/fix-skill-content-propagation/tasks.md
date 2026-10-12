# Tasks: fix-skill-content-propagation

实施仓：`~/code/mcp-gateway-registry`（fd fork）。分支策略见 design D4——从
fd-1.1.1 对应提交（c4b09948）切 `fix-skill-content-propagation` 分支。

## 1. schema 增字段（方案 A）

- [ ] 1.1 `registry/schemas/skill_models.py`：`SkillRegistrationRequest` 增加
  `skill_md_content: str | None = Field(None, ...)`（描述对齐 SkillCard 同名字段：
  inline SKILL.md content, stored instead of URL fetch），并加 field_validator
  把空串归一为 None（design D3）
- [ ] 1.2 单测（`tests/unit/test_skill_models.py`）：字段可解析、空串归一 None、
  不带字段的载荷不产生该键（exclude_unset 语义）

## 2. update 路径派生刷新（方案 B）

- [ ] 2.1 `registry/services/skill_service.py` `update_skill`：updates 含
  `skill_md_url` 且与现值不同 → `translate_skill_url` 重派生 `skill_md_raw_url`
  写入 updates（design D2，注意需先取 existing——现函数只在 proxy 字段被碰时才读
  库，需扩为 skill_md_url 在 updates 时也读）
- [ ] 2.2 `update_skill`：`skill_md_content` 在 updates 且与现值不同 → 刷新
  `content_updated_at`（design D3）
- [ ] 2.3 单测（skill service update 路径）：URL 变→raw_url 跟随；URL 不变→
  raw_url 不动；正文变化→content_updated_at 刷新；正文未设→存量保留

## 3. 路由层验证

- [ ] 3.1 PUT `/api/skills/{path}` 集成测试（现有 update 路由测试就近扩展）：
  载荷带 `skill_md_content` → 落库可见（GET 卡片返回新正文）；不带 → 不清空；
  载荷带新版本化 `skill_md_url` → `skill_md_raw_url` 同步新版本
- [ ] 3.2 内容端点回归：`skill_md_content` 非空时优先返回库内正文（现有行为，
  加一条防回归断言即可）

## 4. 验证与收口

- [ ] 4.1 全量单测（`pytest tests/unit -k skill`）绿 + 受影响面跑全量不红
- [ ] 4.2 staging/本地起 registry 冒烟：模拟部署侧 PUT（带正文+版本化 URL 的
  两连击 v1→v2），断言 `/api/skills/{name}/content` 两轮都返回对应版本正文
- [ ] 4.3 发布载体拍板（design D4，推荐 cherry-pick fd-1.1.2）→ 构建（标准
  TCR 线，GHA→hkccr→relay→ccr）→ cheap-1 compose 栈滚版 → 生产复验
  4.2 同款冒烟
- [ ] 4.4 openspec archive（validate --specs 通过后归档，sync `skill-content-propagation`
  新 capability 入主 specs）
