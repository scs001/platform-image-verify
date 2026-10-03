# Tasks: add-spider-heal-pack

## 1. pack 内容与脚本

- [x] 1.1 撰写 manifest（人格+三技能+serving 契约 rhythm 30m/budget 20m），本地 `lib/pack-manifest.js` 校验零错。验证：`node -e` 校验脚本输出 `[]` ——persona 811 字/三技能(987+2075+511)/rhythm 30m/budget 20m，validatePackManifest 零错
- [x] 1.2 `scripts/spider-heal-pack.mjs`：publish（幂等）+ `--deploy`（billing/secrets/notifyChannel/budget 覆盖）。验证：本地 `--help` + manifest 校验路径单测式自查 ——发布 v1+部署实测通过（buildManifest 可导出复用）

## 2. 部署与冒烟

- [x] 2.1 fd-prod 发布 v1 并部署（萬星运营号，private，无 PAT 降级形态）。验证：registry 条目+runner 起服（cheap1 日志 serving packs-*-spider-heal） ——pack KkCie7NlrHluo4LiKPnn0w v1，runner :8799 起服，健康刷新 healthy
- [x] 2.2 门面冒烟：调用键 SUBMIT 假工单→回执入队（凭据未配置→转人工）；同单重放去重；STATUS 查询。验证：探针/ curl 留档 ——SUBMIT→凭据缺失按协议终态 manual+结构化回执；重放同果；STATUS 跨回合读 inbox（state=manual/retry=0/note 完整）
- [x] 2.3 rhythm burn-in：meter.jsonl 落 `kind:self` 行（12:04:52Z，13.8s 空巡检，ok:true）——部署+30m 首巡如期

## 3. 文档与交接

- [x] 3.1 `docs/spider-heal-pack.md`：finddata 契约（SUBMIT/STATUS 协议、PAT 最小权限、secret 名约定 git_pat/gh_actor、部署/升级/回滚、rhythm 与外部触发关系、四类事件）。验证：文段与技能实文一致 验证：docs/spider-heal-pack.md 与技能实文一致
- [x] 3.2 finddata 侧待办清单落档（PAT 签发/工单目录就位/中央库 MCP 注册后追加引用）。验证：文档含清单 ——PAT 签发/工单流/中央库 MCP/试运行四项
