# Tasks — harden-desktop-lane-relay

## 1. CI 发布班修复（release.yml）

- [ ] 1.1 lane push 步骤凭据名改 `TCR_USERNAME/TCR_PASSWORD`（对齐 image.yml 命名）；tag 发布时缺凭据显式报错 exit 1（fail-loud），非 tag 触发保持跳过。验证：本地 yamllint/gh workflow 语法检查 + 构造无凭据 dry-run 断言失败路径。
- [ ] 1.2 lane OCI build 改隔离临时 context（mktemp 装 dist 副本 + Dockerfile.lane），脱离仓根 `.dockerignore` 影响。验证：构造含 `.dockerignore`（剔除 dist）的样例目录跑 docker build，COPY 成功。
- [ ] 1.3 push 后加 `docker manifest inspect`（带凭据）复验 `:current` 存在，失败即 job 失败。验证：演练 run 日志含 manifest 复验输出。
- [ ] 1.4 test-tag 全链演练：打 `v0.0.2-test`（或复用演练 tag 约定）触发 release，眼见 `lane image pushed` + manifest 复验过 + cheap3 cron `SYNCED version=<test>`（此后恢复 lane 正式版本）。验证：cheap3 `/var/log/desktop-lane-sync.log` 出现 SYNCED，lane latest.yml 随后指回正式版。

## 2. cheap3 分发面（desktop-lane-sync.sh + 对账探针）

- [ ] 2.1 `desktop-lane-sync.sh`：`SKIP pull failed` 连续 ≥3 次升级为 `LANE-STALE FAIL`（exit 1）；配置性跳过（无 env）保持 SKIP。验证：临时屏蔽 hkccr 拉取跑 3 次，日志出现 LANE-STALE FAIL。
- [ ] 2.2 新增 `desktop-lane-check.sh` 每日对账（lane latest.yml 版本 vs hkccr :current 内 yml 版本，不一致 exit 1，日志带 `LANE-CHECK` 标记）。验证：人为改 lane yml 版本后探针报 LANE-CHECK FAIL。
- [ ] 2.3 `desktop-lane-sync.sh` 头注补资产名契约（yml `url` 为准；release 资产名点分隔≠原件名，OCI 路带原名不受影响）。验证：文件头注可见。
- [ ] 2.4 部署两脚本到 cheap3 `/usr/local/bin/` + cron（探针每日）；确认 `/var/log` 落痕。验证：cheap3 crontab -l 可见，手动触发一次 LANE-CHECK OK。

## 3. 文档与收尾

- [ ] 3.1 RELEASE_CHECKLIST.md 增「池迁移」段：换池必配 `TCR_USERNAME/TCR_PASSWORD`；workflow 面四件对齐清单；lane 落盘名以 yml 为准。验证：checklist 段落可见且与 release.yml 现状一致。
- [ ] 3.2 池仓（testaction001/005）workflow 面在下次出片手工补齐时带上 1.1–1.3 修复（纪律：池面与 paas main 对齐）。验证：下次 release run 的 lane push 步骤读新凭据名。
- [ ] 3.3 CI 路真通后收尾：删除 testaction001 的临时别名 secrets（TCR_USER/TCR_PASS）；删除 hkccr `:push-probe` 探针 tag（11-07 手工验证遗留）。验证：gh secret list 无别名；registry 无 probe tag。
- [ ] 3.4 （待裁）LANE-STALE 接入告警消费面（巡检/看板通道由用户定；不阻塞归档）。
