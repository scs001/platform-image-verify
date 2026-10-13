# Tasks: onboard-registry-argocd

## 1. GitOps manifest + ArgoCD app（影子，零流量）

- [x] 1.1 cheap-8 选址核实：`tailscale ip` 实测 cheap-8 tailnet IP、确认 18080/18443/7860/8091/8888/8003/27017 七端口未被占用、requests 余量复核
- [x] 1.2 fd-infra-deploy 新增 `mcp-registry/prod/`：namespace、Secret 骨架（`mcp-registry-env` 占位+.env 全量灌入、mongo keyfile Secret）、registry/auth-server/mcpgw 三 Deployment+mongo StatefulSet（hostNetwork+nodeSelector cheap-8+Recreate+dnsPolicy Default；镜像钉 ccr sha-a95f7a0 / mcpgw 1.32.0 / mongo 8.2；容器名引用三处改 loopback；models/mongo hostPath）
- [x] 1.3 ArgoCD app `mcp-registry` manifest（源=gitee fd-infra-deploy `mcp-registry/prod/`、dest ns mcp-registry、automated+selfHeal+CreateNamespace）入 GitOps 仓同路径，push gitee 后 app 建立并 sync
- [x] 1.4 影子四负载 Running+registry/auth-server healthy；pv 无 PVC 悬挂、Secret 挂载路径正确

## 2. 数据迁移（低峰窗）

- [x] 2.1 models rsync：cheap-1 `~/mcp-gateway/models`（262MiB）→ cheap-8 `/opt/mcp-registry-k8s/models`（含可写 CACHEDIR 目录）
- [x] 2.2 mongodump 全库（含 admin；~1GB）→ scp → mongorestore 到 k8s mongo；`rs.status()` ok、registry 侧连接探活、`mcpgw/registry` 业务库文档数对账
- [x] 2.3 .env 全量复核进 Secret（OPENBAO_ADDR 指向 100.64.0.11:8200 留守值；三处 loopback 改写就位）；滚动重建四负载使新 Secret 生效

## 3. 影子冒烟（切流闸门）

- [x] 3.1 直连 cheap-8:18080：`/health`（或等价探活）+ servers API 返回与 compose 侧一致的 server 清单
- [ ] 3.2 vend 注入链：影子面走一次经 mcp_proxy 的完整 MCP 调用（business-mcp 或 legal-search 条目），k8s auth-server 日志出现 `injected shared backend auth credential`
- [x] 3.3 出站源 IP 变化实证：影子 registry 经 mcp_proxy 调 business-mcp+legal-search 两 NodePort 条目均非 403/拒绝（allowlist 无源 IP 断裂）
- [x] 3.4 openbao 可达：k8s registry/auth-server 启动日志无 openbao 连接失败（或等价探活）

## 4. 切流 + 生产验证

- [x] 4.1 cheap-1 Caddyfile mcp.finddatatech.cloud 块 upstream `127.0.0.1:18080` → `http://<cheap-8-tailnet>:18080`（SSE 参数与 mint 预检块不动），`caddy reload`；https/18443 引用面核查并同步处理
- [x] 4.2 生产验证：mcp_proxy 统计恢复常态流量、`injected shared` 计数在 k8s auth-server 增长、错误率无异常、控制台/市场面可开
- [ ] 4.3 双轨观察≥1 天：compose 栈冻结 a95f7a0 只读；期间无回退需求

## 5. 收尾

- [ ] 5.1 compose 栈 stop registry/auth-server/mcpgw-server/mongodb 四容器（stop 不 rm；**openbao 保持运行**）；Caddyfile 注释更新指向 k8s
- [x] 5.2 维护台账 §1 改写（k8s 形态+ArgoCD app+Caddy 切流配方+双轨回退配方+openbao 留守）；MEMORY 更新
- [ ] 5.3 openspec validate --specs 通过、归档
