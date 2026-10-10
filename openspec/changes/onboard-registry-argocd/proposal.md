## Why

registry（谦面）是唯一还在 docker compose 手滚的核心服务（cheap-1 `/opt/mcp-gateway-registry`），与 fd-prod 的 ArgoCD/GitOps 布局脱节；用户 2026-10-10 定案：registry 入驻 ArgoCD 单独立项（slim-registry-image 发布时确认部署腿暂留 compose 滚动）。

## What Changes

- compose 栈 → k8s manifests：bind mount（`~/mcp-gateway/{servers,agents,models,ssl,logs}`）迁 PV/hostPath、mongo 数据卷迁 StatefulSet 或保持外置、双容器拓扑（registry+auth-server）与 nginx 配置入 ConfigMap。
- ArgoCD application 指向 GitOps 仓（gitee），与 platform 同列。
- 迁移窗：先影子部署后切流，保留 compose 栈一键回退。

## Capabilities

### New Capabilities
（探索后定——预计 `registry-deployment`）

### Modified Capabilities
- `registry-lineage`: 部署形态从 compose 栈演进为 GitOps 管理（钉版换镜像语义不变）。
