# spider-heal 执行体：fleet 出口与技能传播 —— 萬星侧配合事项

> 来源：finddata 侧 2026-10-12 凭据轮换与链路体检
> 对象：萬星（paas）侧
> 状态：三项待办，其中 P0 阻断修复链真工单

## 背景（一段话）

2026-10-12 我们处理了一起 agent 自报的 `git_pat` 脱敏事故：两次 Regenerate + v9/v10 重部署，
新值 `ws_a6f56…7zNX` 已 pin 到执行体并端到端验证通过。处置过程中发现**两个萬星侧的结构性问题**，
其中一个会直接阻断修复链处理真工单。以下是证据、影响与建议修法。

---

## P0 · runner-b / runner-c 无 GitHub 出口（阻断真工单）

### 现象（实证）

spider-heal 的 v9/v10 部署被 **fleet 自动选址**落到了 `runner-b` / `runner-c`：

```
$ kubectl -n fd-prod exec agent-runner-c -c runner -- curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com
000        # TCP 超时

$ kubectl -n fd-prod exec agent-runner-c -c runner -- python3 -c 'import socket; socket.create_connection(("github.com",443),timeout=6)'
TimeoutError
```

- `runner-b`（cheap-6，tailnet `100.64.0.13`）与 `runner-c`（cheap-7，`100.64.0.14`）**均连不上 GitHub**。
- 对照：`cheap-1` 主机 `curl https://github.com` → **200**；`cheap-1` 的 `agent-runner-dsh` 容器内同样 200。
- DNS 正常（`github.com → 20.205.243.166`），**是 TCP 层不通**，非解析问题。

### 影响

spider-heal 的修复/生成流程必须读 GitHub（浅检出工单与目标单元、推分支、开 PR）。
落在无出口的 runner 上时，**真工单会卡在取件/推送环节**。
（注：当前技能走 GitHub **API + tarball** 而非系统 git——镜像历版不含 git，这不是本次回归——
但 API 同样需要 GitHub 出口，所以出口是硬需求。）

### 修法（已实测有效，建议照抄 fd-health-runner 先例）

**推荐：给两个 runner 注入代理环境变量**。cheap 节点侧已有现成的 mihomo 出口中继，
且 `fd-health-runner`（同一 cheap 集群）就是这么解决的——复用同一个 secret 即可：

```yaml
# fd-infra-deploy/all-services/prod/agent-runner-b.yaml（runner-c 同法）
    spec:
      containers:
        - name: runner
          envFrom:
            - secretRef:
                name: agent-runner-b-env
            - secretRef:
                name: fd-health-proxy        # ← 新增这一行
```

`fd-health-proxy` 的键（已存在，无需新建）：`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，
值形如 `http://<user>:<pass>@100.64.0.7:30081`，`NO_PROXY` 含
`localhost,127.0.0.1,100.64.0.0/10,10.42.0.0/16,10.0.0.0/8,.finddatatech.cloud,.tencentyun.com`。

**已在 runner-b pod 内实测**（临时导出同一 secret 的值后）：

```
https://github.com               -> 200
https://api.github.com           -> 200
https://platform.finddatatech.cloud -> 200   # NO_PROXY 生效，未绕远
```

同时确认 **runner-b 能连通 mihomo 中继**（`100.64.0.7:30081` TCP OK）与 cheap-1 runner
（`100.64.0.11:8790` TCP OK）——即网络路径本身是通的，只差 env 注入。

**备选（若不愿给全部 agent 走代理）**：把 spider-heal 固定调度到 cheap-1。
部署接口支持显式指定：

```bash
# 现有脚本尚未透出 runnerId；可直接对部署接口带参（body 增加 runnerId）
POST /api/packs/KkCie7NlrHluo4LiKPnn0w/versions/<v>/deploy
{ "runnerId": "cheap-1", "secrets": { "spider-heal": { "git_pat": "…" } } }
```

（`gateway/packs.js` 部署路由：`runnerIdBody` 命中 fleet 表即显式选址，未命中返 400 并列出合法 id。
当前 fleet 表三行：`cheap-1` / `runner-b` / `runner-c`。）
我们也可以给 `scripts/spider-heal-pack.mjs` 加一个 `RUNNER_ID` env 透出——**需要萬星侧确认走哪条路**，
若走这条我们可以直接提 PR。

> ⚠️ 注意自动选址逻辑（`gateway/fleet-scheduler.js` `pickPlacement`）按
> **内存余量最大、children 最少**排序，**不看 GitHub 出口**——所以只要 b/c 无出口，
> 后续每次部署都可能再被调度过去。修出口（推荐）比固定调度更稳。

---

## P1 · 技能正文传播断链（我们已热修，需萬星侧永久化）

### 现象（实证）

registry 里 spider-heal 四个技能条目的取值源是**陈旧的**：

```
$ mongosh mcp_registry --eval 'db.agent_skills_default.findOne({name:"spider-heal-repair"})'
  skill_md_content = null
  skill_md_raw_url = https://craw.finddatatech.cloud/api/packs/KkCie7NlrHluo4LiKPnn0w/versions/1/skills/spider-heal-repair.md
                                                                    ^^^^^^^^^^^^^^^^ 冻在 10-03 创建时的 v1
  skill_md_url     = https://facet.finddatatech.cloud/api/packs/…/versions/9/skills/spider-heal-repair.md
```

- 内容端点（`skill_routes.py` `get_skill_content`）逻辑：`skill.skill_md_content` 为空 →
  回退到 `skill.skill_md_raw_url or skill.skill_md_url`。
- 而 `skill_md_raw_url` 是**创建时（10-03，pack v1）写入后再没更新过**，
  于是**子机冷启动永远拉到 v1 的旧技能文本**——我们 v9/v10 里写的技能加固根本没到执行体。
- 这正是同一起泄露事故里 agent 重复犯错的原因：它读到的仍是 v1 版「单行 grep+sed 读凭据」的旧指令。

### 为什么部署没带上新正文

`SkillRegistrationRequest`（`registry/schemas/skill_models.py`）**没有 `skill_md_content` 字段**：

```
request fields: [… 'skill_md_url', 'repository_url', 'version', 'id', …]
skill_md_content in request? False
skill_md_raw_url in request? False
```

而部署侧（`lib/agent-serving.js` `deployToRegistry`）**明明 PUT 了 `skill_md_content` 与
`skill_md_url`**（每技能 upsert，含当前版本号），但：
- `skill_md_content` 被请求模型丢弃（不在 schema）；
- `skill_md_raw_url` 从未被设置（不在 schema），首次创建时由 registry 从 `skill_md_url`
  翻译一次（`translate_skill_url`，非 GitHub URL 原样保留）→ 之后**永不更新**。

### 我们已做的热修（临时）

直接写库把当前版本正文与 raw_url 补上（`mcp_gateway_registry-registry-1` 容器内
`/app/.venv/bin/python` + pymongo，`agent_skills_default`）：

```python
col.update_one({"name": n}, {"$set": {
  "skill_md_content": <当前版本正文>,
  "skill_md_raw_url": f"https://facet.finddatatech.cloud/api/packs/{pack}/versions/10/skills/{n}.md",
}})
```

已验证子机拿到新文本（`cred()` 在场、旧 sed 消失）。**但这只是补数据，不改链路——
下次 pack 升级正文仍不会自动传播。**

### 建议的永久修法（二选一）

1. **schema 增字段（推荐）**：`SkillRegistrationRequest` 加 `skill_md_content: str | None`
   （与 `SkillCard` 已有的同名字段对齐），PUT 时落库；这样部署侧现有代码即刻生效，
   正文随版本走。
2. **raw_url 随版本刷新**：在 `deployToRegistry` 的技能 upsert 里同时 PUT
   `skill_md_raw_url`（当前版本 URL）；需 schema 同步放行该字段。此法保留「按 URL 拉取」
   语义，但多一次外网取件。

> 无论选哪条，**建议同时把 `skill_md_url` 与 `skill_md_raw_url` 一起随版本更新**，
> 避免再出现「展示的是 v9、实际取的是 v1」的错位。

---

## P2 · 凭据读取纪律（防复发，建议写进技能/平台约定）

本次泄露的机理：`$DSH_HOME/.credentials.yaml` 里 `git_pat` 是**块标量**
（`git_pat: >-`，值在下一行），单行 `grep+sed` 取到空串，agent 为排查**打印了文件原文**，
完整值落入会话日志。

finddata 侧已在技能文本里加固（`cred()` 覆盖行内/块标量/空值续行三形态 + 明令
**绝不为「看清楚」打印凭据文件**）。建议萬星侧：

- 平台侧考虑对 child 的凭据文件做**读取审计/告警**（或提供官方读取工具），
  让技能不必自己解析 YAML；
- 若保留文件形态，建议把块标量写法改为**单行引号值**，从源头消除解析歧义。

---

## 验证清单（供萬星侧自证）

修完后按此清单验收（命令均可直接跑）：

```bash
# 1) 出口
kubectl -n fd-prod exec deploy/agent-runner-b -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://api.github.com     # 期望 200
kubectl -n fd-prod exec deploy/agent-runner-c -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://api.github.com     # 期望 200

# 2) 内网不被代理绕远（NO_PROXY 生效）
kubectl -n fd-prod exec deploy/agent-runner-b -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://platform.finddatatech.cloud  # 期望 200

# 3) 技能正文随版本（P1 修完后：升级 pack 到新版本，再查 registry）
#    skill_md_content 非空 且 与当前版本一致；skill_md_raw_url 指向当前版本
```

---

## 附：本次轮换的完整事实（存档）

- 泄露：agent 自报（脱敏命令对块标量失效）；落点=会话轨迹文件，已删；finddata 仓内零命中。
- 轮换：两次 Regenerate + v9/v10 重部署；在用 `git_pat ws_a6f56…7zNX`；
  每次窄授权复验（身份 FindDataOfficial / 目标仓写 201 / 非目标仓 403 / 私有仓 404）。
- 取证：runner 会话存档为 **zstd 多帧**（单帧解码只得骨架），逐帧拼接扫描后新值 0 命中。
- 镜像无 git：**历版皆无，非本次回归**；技能走 API+tarball（会话实证 ghApi/tarball 引用）。
- 我们侧的记录：`docs/spider-heal-pack.md` 末节（④ git PAT 权限范围）。
