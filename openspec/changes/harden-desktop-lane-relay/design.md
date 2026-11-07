# Design — harden-desktop-lane-relay

## Context

发布链五段：release.yml（tag 触发）→ gen-desktop-latest-yml → hkccr OCI 中继
（`yizuo/desktop-releases:current`）→ cheap3 `desktop-lane-sync.sh`（cron */10）→
RustFS lane（100.64.0.10:9000/yizuo-desktop，匿名读）。11-07 排障实证：

1. **凭据名漂移**：release.yml lane push 读 `TCR_USER/TCR_PASS`；两个池实配
   `TCR_USERNAME/TCR_PASSWORD`（2026-10-13 起，image.yml / image-publish.yml 用同名，
   推送权多年在产真证）。名不匹配 → secrets 恒空 → fail-open 跳过。relay env（
   cheap3 `/etc/tcr-relay/env`）恰好也叫 TCR_USER/TCR_PASS——命名漂移的来源即此。
2. **`.dockerignore` 剔 `dist`**：lane OCI build `COPY dist/ /lane/` 用仓根做 context，
   `.dockerignore`（为主服务镜像服务，剔除 dist 合理）把 dist 剔出 context → build 必炸。
   attempt 1 缺凭据提前 exit 0，雷从未响过。
3. **全链 fail-open**：CI 缺凭据 exit 0 假绿；worker 连续 `SKIP pull failed` 只进
   /var/log。11-02 演练的 SYNCED 是手工推的图——CI 路至今一次未真通。

v1.3.28 已于 11-07 手工旁路上 lane（Mac 直推 RustFS，sha512 全程校验，yml 契约名落盘），
作为 CI 路修复期间的生产止血。

## Goals / Non-Goals

- Goals: CI 路一次配置正确即在任意池可跑；断链处 fail-loud；漂移可检出。
- Non-Goals: 不改客户端（updater.js/updater-core.js 零改动）；不改 lane 元数据契约；
  不做多通道/多池编排；告警通道（谁看 LANE-STALE）不在本 change 定死，只保证可检出。

## Decisions

- **D1 凭据名向仓内正统对齐（TCR_USERNAME/TCR_PASSWORD）**：两个池已有、推送权已证；
  反向（把池 secrets 改名）要动两池且与 image lane 割裂。别名 `TCR_USER/TCR_PASS`
  （11-07 临时补在 testaction001）在 CI 路真通一次后删除。
- **D2 隔离 context**：mktemp 目录装 dist 副本 + Dockerfile.lane，`docker build <tmpctx>`；
  context 根无 .dockerignore 即不受主仓规则影响。不用 `!dist` 反白名单（会把 electron
  产物重新放回主镜像 context，违背 .dockerignore 现有注释意图）。
- **D3 fail-loud 边界**：只对 tag 发布（`startsWith(refs/tags/v)`)收紧；凭据缺失在
  job 内显式报错退出 1。元数据生成仍前置（哈希一致性不依赖接力成败）。
- **D4 worker SKIP 语义**：`SKIP pull failed` 计数连续 N=3 后升级为 `LANE-STALE FAIL`
  （exit 1）；env 缺失类「配置性跳过」保持 SKIP（未部署不该报错）。对账探针复用
  desktop-lane-sync.sh 的拉取与校验代码路径（独立 `desktop-lane-check.sh`，cron 每日）：
  lane yml 版本 vs hkccr :current 内 yml 版本，不一致 exit 1。
- **D5 资产名契约**：electron-builder 产物名以 yml 内 `url` 为准（1.3.28 实测
  `Platform Setup 1.3.28.exe` 带空格；GH release 资产名被 softprops 替换为点分隔）。
  任何从 release 资产同步 lane 的路径必须按 yml 名落盘。写进 RELEASE_CHECKLIST 与
  desktop-lane-sync.sh 头注（OCI 路天然带原名，不受影响）。

## Risks / Trade-offs

- fail-loud 后缺凭据会红一个 job——这是目的（假绿才是事故），但换池当天会红一次直到
  checklist 执行；RELEASE_CHECKLIST 池迁移段同步落地对冲。
- 挪 tag 全量重建会让 release 资产哈希变化（electron-builder 非字节确定）——本 change
  不重发既有 tag，只在下次 release/演练生效。
- 探针每日一次 vs sync 每 10 分钟：探针只对账不发版，日内漂移窗可接受。

## Open Questions

- LANE-STALE 的告警消费面（接哪个巡检/看板）——待用户定，任务里挂独立项不阻塞。
