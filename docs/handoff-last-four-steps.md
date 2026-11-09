# 最后四步（外部动作清单）

> 2026-11-10 记。四个 change 的代码侧已全部完成并通过验证，剩下的四项都是**对外动作**，
> 需要人授权/持凭据。本文只写**已经核实过的**命令与触发方式，不写想当然的步骤。
>
> 相关 change：`fix-supply-machine-faces`(22/28)、`unify-line-board-tabs`(16/17)、
> `complete-creator-loop`(17/18)、`polish-material-market-tabs`(16/17)、
> `2026-11-10-unify-tab-idiom`（已归档）。

---

## ① 出片（解锁 ②③④ 的线上走查 + ① 的 facet 404 生效）

**触发方式**（`.github/workflows/image-publish.yml`）：push 到 `main`，或手动 `workflow_dispatch`。
镜像打两个标签：`<sha tag>` + `:main`。

出片后要做的三件走查（都在 tasks.md 里等着勾）：

```bash
# 1) facet 壳不再用 HTML 兜底机器路径（① 2.3 / 8.3）
for p in llms.txt llms-full.txt catalog.json robots.txt; do
  printf "facet/%s " "$p"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "https://facet.finddatatech.cloud/$p"
done            # 期望：四条全 404 text/plain

# 2) plaza 四件套在正门可用
for p in llms.txt llms-full.txt catalog.json robots.txt; do
  printf "agent/%s " "$p"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "https://agent.finddatatech.cloud/$p"
done            # 期望：200 + 各自类型（此前全是 404 —— 正是 ① 的一半）

# 3) 视觉走查：/boards/{facet,wanxing,wire,lex,base} 与 /agents 五页签
#    本地版已存 evidence/walkthrough-2026-11-10/，线上重拍一次即可
```

> 注意：plaza 根路径的四件套来自 `scripts/deploy-plaza.sh`（不是镜像）。只出片不跑它，
> `agent.*` 那四条仍会 404。两条通道要**一起**走。

---

## ② 两个 Secret（解锁 plaza 定时再生成）

在仓库 Settings → Secrets 里配：

| 名字 | 值 |
|---|---|
| `PLAZA_DEPLOY_HOST` | `deploy-plaza.sh` 的 TARGET，形如 `user@host`（能免密登录雷池机） |
| `PLAZA_DEPLOY_KEY` | 对应私钥全文 |

配好后 `.github/workflows/plaza-refresh.yml` 会按 `cron: "17 2,10,18 * * *"` 自动跑；
也可以立刻手动 `workflow_dispatch` 验证一轮。首跑成功后 `generatedAt` 会前进，
届时线上那份 2026-11-05 的旧快照（packs:82，市场实为 114）才算更新。

---

## ③ npm 发版（CLI 修复到达用户）

版本已 bump：`facet/cli/package.json` **0.3.0 → 0.4.0**（新增 `list`/`search`、`installed.json` 记 base）。

发版**只走 tag**（`.github/workflows/facet-cli-publish.yml`，OIDC trusted publishing，无长期 token）：

```bash
git tag facet-cli-v0.4.0 && git push origin facet-cli-v0.4.0
```

验证：`npm view @finddatatechnology/facet version` → `0.4.0`；
干净 HOME 下 `npx @finddatatechnology/facet list` 能列出目录。

---

## ④ 公开仓镜像 `docs/ecosystem/client-matrix.md`

`#/docs` 的能力矩阵深链指向它，公开仓当前 404（本地文件在 `docs/ecosystem/client-matrix.md`）。
把它随下次公开快照一起发布即可（`scripts/make-public-snapshot.mjs` 的排除清单里**没有**它，
所以正常出快照就会带上）。发布后：

```bash
curl -sI https://github.com/FindDataTechnology/platform/blob/main/docs/ecosystem/client-matrix.md | head -1
```

---

## 做完这些之后

四张单的剩余项（② 5.5、③ 4.5、④ 4.6、① 2.3/4.2/4.3/6.4/7.1/8.3）逐条勾掉即可归档。
`openspec validate <change> --strict` 现在全部为绿，归档不需要再改代码。
