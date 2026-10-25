# memory-eval Specification

## ADDED Requirements

### Requirement: 老 note 深度场景度量蒸馏召回增量

续作评测场景集 SHALL 含不少于 2 个「老 note」场景：期望背景全部存于同 project 按新近排序排名 >3 的 note 页——现 digest 读面（L1 段至多 3 条）不可达、唯蒸馏后经 L2 检索可达的背景。harness SHALL 对该类场景先经真实蒸馏路径（与生产同契约的侧车 /distill 调用）准备种子根，再渲染 digest 臂，并以不经蒸馏的同根渲染为对照；老.note 场景子集上蒸馏臂对现 digest 臂 SHALL 保持不劣（重推导度均值差 ≥1 分），全集门槛（重推导度 avg diff ≥0.5、win/noninferior ≥70%）不放松，结果记入 continue-baseline。

#### Scenario: 老 note 背景唯蒸馏可达

- **WHEN** 对含老 note 场景的种子根先蒸馏后渲染 digest
- **THEN** 渲染块含经蒸馏产出的对应 L2 条目（背景可达），对照组（不蒸馏）不含

#### Scenario: 老.note 子集不劣门槛

- **WHEN** 以含老 note 场景的全集跑门
- **THEN** 老.note 子集蒸馏臂重推导度均值较现 digest 臂高 ≥1 分，全集双门照旧通过，结果入 continue-baseline
