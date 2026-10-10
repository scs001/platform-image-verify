## Why

registry 栈的 `mcpgw-server` 用 `public.ecr.aws/p3v1o3c6/mcpgw:1.32.0`（AWS 公共 ECR，905MB）——国内拉取可靠性差且与标准 TCR 通道脱节（slim-registry-image 探索时发现的遗留，grill Q4 定案单独立项）。

## What Changes

- 将 `mcpgw:1.32.0` 转存至 `ccr.ccs.tencentyun.com/yizuo/`（可经 hkccr→relay 标准通道），compose 引用改指 ccr 侧钉版 tag。
- 换版验证：mcpgw 转发 hop（`/mcp-proxy/{server}`）冒烟。

## Capabilities

### New Capabilities
（无——涉及时再定）

### Modified Capabilities
- `registry-lineage`: 镜像钉版要求从「钉版即可」收紧为「自建/转存镜像一律走 ccr 标准通道，上游直连引用仅允许过渡期」。
