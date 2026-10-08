# dsh lock / peer 死结 — 交接单（给桌面/dsh-matrix 车道）

2026-10-08 由 add-doc-studio 的镜像构建链撞到并定位。本文件是**诊断与交接**，不是修复记录。

## 现象（三处同一病根）

| 位置 | 症状 |
|---|---|
| 干净 `npm ci` | ERESOLVE（CI ci.yml、Dockerfile builder 层） |
| `npm ci --legacy-peer-deps`（现已在 release.yml / ci.yml / Dockerfile 三处） | 能装能构建，但**漏装 rc.2 peer 闭包** → CI 单测 `test-agent-notify-bridge` 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-credentials`；镜像内 dsh-matrix 启动门拒（`missing: @deepseek-ai/dsh-*(lock: 0.1.1-rc.2)` 全列），boot 冒烟红 |
| `npm ci --force` / `npm install --package-lock-only --force` | EUSAGE：`lock 与 package.json 不同步`（cordis-plugin-loader@1.0.5、dsh-brand@0.1.1-rc.2 等不在 lock 内） |

## 根因（已实证，非猜测）

两代 dsh 包无法共存于**同一依赖树**：

```
dsh-brand@0.1.1-rc.2   peer → dsh-invariants@^0.1.1-rc.2
dsh-llm@0.0.1-rc.5     peer → dsh-invariants@^0.0.1-rc.5
dsh-llm@0.1.1-rc.2     peer → dsh-brand@^0.1.1-rc.2
```

`npm view` 三处 peer 已核对。rc.2 的 anonymous-user-id/command-feedback/dsh-base 系与 rc.5 的 tools/llm/sdk 系各自要不同代的 invariants/brand，而 npm 的扁平化在同一树里只能留一个版本 → 严格 `npm ci` 必拒。

**已排除的假设**（别再试）：版本字段不同步（已同步 1.3.5）、直接依赖缺失（0/51）、registry 缺包（`0.1.1-rc.2` 存在）、flag 级绕过（见上表，三条全堵）。

## 可行解（按推荐顺序）

1. **上游对齐代际**：把 rc.5 系（dsh-llm/sdk/session 等）统一升到 rc.2 线，或反之；两代不再混装，tree 自然可解析。这是唯一治本解。
2. **显式钉版 + 嵌套解析**：对必须两代共存的包显式声明并使用 `overrides`，或接受 npm 的嵌套多版本布局（lock 里两个 invariants 各挂其子树）。需 `npm install` 重生成 lock 并验证 `npm ci` 通过。
3. **回退"peer 闭包钉死"改动**（4e348c3 那一轮把一批 dsh 包挪进 peerDependencies）：若这些 peer 本不该是 peer，改回 dependencies 即解——这属于该车道的设计决策。

## 修好后请做

- 撤掉三处 `--legacy-peer-deps`（`.github/workflows/release.yml`、`.github/workflows/ci.yml` 两处、`Dockerfile` builder 与 /opt/dsh 两处），它们是症状级缝合，留着会掩盖未来的真依赖问题。
- 验证标准：`npm ci`（无 flag）绿 + CI 全绿 + 镜像 boot 冒烟绿（`/api/config` + dsh-contracts）。
- 镜像构建可走 `scs001/platform-image-verify` 的 `image-publish` 工作流（公开仓免费 runner，TCR 凭据已配 Secrets，推 hkccr → relay 回灌 ccr）；私仓无 GHA 额度期间它就是构建通道。
