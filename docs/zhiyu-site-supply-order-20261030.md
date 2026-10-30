# 智语官网 · 交付包与上线补给单

> 生成：2026-10-30（paas 私有仓）。本文是**给雷池侧运维 AI 的执行附件**，正文规范见
> `docs/zhiyu-site-deploy-requirements.md`。本文只补三件：交付物清单、补给包、上线后的
> demo 房间启用单（可选）。

## 一、交付物清单

| 交付物 | 路径（本仓） | 是否上产线静态目录 |
|---|---|---|
| 智语站三文件 | `site-zhiyu/{index.html,style.css,script.js}` | ✅ 是（唯一要发布的东西） |
| 永忆站回链改动 | `../fd-memory/site/index.html`（两处：导航「智语」+ 页脚一行） | ✅ 是（与智语同批） |
| 部署需求 | `docs/zhiyu-site-deploy-requirements.md` | ❌ 否 |
| 设计记录 | `docs/zhiyu-site-design.md` | ❌ 否（含内部词清单） |
| design surface brief | `.impeccable/surfaces/site-zhiyu-index-html.md` | ❌ 否 |

## 二、补给包（唯一推荐通道）

> 当前包 sha256：`f3f41e073f5f05969ada1104143f48e6a5890667cc77866ca46a1e7f2cd46e37`（12,598B 左右，3 个文件）。重打包后必须重算并回填此行。

**不要用 raw.githubusercontent.com**（雷池机与 cheap1 实测被 SSL 重置）。二选一：

```bash
# A. 随本文附带的 tar（推荐，最小面）
tar -czf /tmp/zhiyu-deploy-20261030.tar.gz \
    -C /Users/chengsishi/paas/site-zhiyu index.html style.css script.js
shasum -a 256 /tmp/zhiyu-deploy-20261030.tar.gz

# B. 走仓库（已推送分支 feat/zhiyu-official-site）
curl -L -o /tmp/paas.tar.gz \
  "https://codeload.github.com/FindDataTechnology/fd-craw-private/tar.gz/refs/heads/feat/zhiyu-official-site"
```

三个文件的独立哈希见 `docs/zhiyu-dns-and-edge-request.md` §6（取到后应逐一核对）。

雷池机侧：

```bash
mkdir -p /srv/zhiyu-site && tar -xzf zhiyu-deploy-20261030.tar.gz -C /srv/zhiyu-site
ls -l /srv/zhiyu-site      # 期望：恰好 index.html style.css script.js
caddy reload --config /etc/caddy/Caddyfile
```

## 三、上线核对单（逐条打勾）

- [ ] DNS：`dig +short zhiyu.finddatatech.cloud` → `103.236.89.212`
- [ ] 证书：`curl -sI https://zhiyu.finddatatech.cloud/ | head -1` → `200`
- [ ] 标题：响应体含 `<title>智语 · Zhiyu`
- [ ] 首屏句：响应体含「让智能体团队」
- [ ] 泄漏门：`grep -cE '壹座|yizuo\.local|10\.43\.|NodePort|31899|sub2api|spider-heal'` → 0
- [ ] 合成标注：响应体含「合成」（≥1 处）
- [ ] 视觉桌面：滚动时圆桌依次转向 分身席 → 访客席 → 门口 → 桌心
- [ ] 视觉移动：390px 下章节顺排、席标可读、首屏 H1 与两个按钮在位
- [ ] 互链：yongyi ⇄ zhiyu 双向可达
- [ ] 永忆站：导航与页脚各出现一处 `zhiyu.finddatatech.cloud`

## 四、可选：把活演示变成真房间

不做也能上线（页面会明确标注「合成演示」）。要做，按顺序：

1. **造房**：用普通用户账号在万星建一间房，命名「智语值守」，配置空闲结束时长。
2. **部署值守分身**：走正常创建 → 部署路径（内部＝范例，无后门）。人格提示词要点：
   只答智语/万星的产品问题；不确定就转人工（事项串）；不泄漏任何内部实现。
3. **开嵌入**：房间设置 → 开启嵌入 → 域名白名单填 `zhiyu.finddatatech.cloud`
   （本地自测可加 `localhost`）。**未填白名单无法开启**，这是既有闸。
4. **配护栏**：日预算（小额起步）、应答上限、熔断；模型钉 `:free` 车道。
5. **取令牌**：平台生成 widget 令牌（≥128 bit，平台存哈希）。把令牌写进
   `index.html` → `<div class="room-shell" id="liveRoom" data-room="<令牌>">`，重新上传该文件。
6. **回填验收**：页面上传后，该区应出现真 iframe；提问一句收到回复即通过。
   `script.js` 在挂载前会自动移除合成对话与「合成演示」标注——若标注没消失，说明 widget 未加载。

**安全边界（写死的）**：令牌公开可见是设计如此（防猜靠长度、授权靠白名单、吊销靠休克）。
**绝不要**把任何带写权限的凭据写进这三个静态文件。

## 五、回滚

```bash
# 站侧
cp /srv/zhiyu-site/index.html.bak-pre-20261030 /srv/zhiyu-site/index.html && caddy reload
# 或整站下线：删 Caddyfile 块 + reload，再删雷池 site；DNS A 记录 TTL 600s 内失效
```


---

## 七、§四 runbook 实际执行结果（2026-10-30 第二班补记）

按 §四 跑完，**三处与预案不同，均已在产**：

1. **在席 2 席，不是 6 席**。官方包六岗无 serving 契约不可部署；已铸**镜像私包**
   `bTnrv2P_JhmCzqqXCF0GIA`（岗位文案与官方 v5 逐字一致 + 六岗补 serving），
   部署时 **runner-serving 32 端口槽已满**（registry 34 条含同主机 untagged；fleet 名册里
   `runner-b`/`runner-c` 两台无 pod＝死行，无处可放），只落两席：
   `intro-guide`（产品向导）+ `intro-yizuo`（壹座专家）。余四席等端口，不是等代码。
2. **车道改选**。契约声明 `toolFace:"chat"` + 回合预算 3 分钟；模型先钉 `:free`
   （`google/gemma-4-31b-it:free`）实测持续 429/502，改钉 `deepseek-v4.1-flash` 后真答。
   注意模型有**两道闸**：计费车道白名单 ∩ **runner 名册**，后者更窄（名册实得 8 个模型）。
3. **嵌入白名单必须两条域名**：`zhiyu.finddatatech.cloud`（父站 meta 门）
   **＋ `platform.finddatatech.cloud`**（iframe 自身同源请求的 referer 落点）。
   只放前者→访客铸席 403（仓内 e2e 用伪造 referer 掩盖了这点，真机才露）。

房间 = `zy_42ce690574b5423bd2`，房主 `zhiyu@finddatatech.cloud`（对外角色地址，
访客头一行会原样显示房主邮箱，所以不能是个人邮箱）；`replyCap=1`、日预算 60 应答；
`idle_minutes` 直写 5256000 豁免闲置收房（API 上限 1440＝24h，常设展厅不该被临时房规则掐死）。

真机验收：真域 iframe 内未登录访客提问 → 产品向导真应答 →
`reply_cap_hit` 如实收住第二席。房间与令牌在平台侧，静态件回滚不影响它。


## 八、四席扩容：为什么没能落，以及回退了什么（2026-10-31）

**结论先说**：官网房间保持 **2 席**（产品向导 + 壹座专家），已上线并在真站验过应答。
余 4 席不是「再点一次部署」能解决的，它撞的是**容量与规划模型**，不是权限也不是代码。

### 8.1 一次错误改动（已回退，留作判据）

我依据「registry 全部条目都带显式 `port_override`」这个读数，把 runner env 与名册行
`port_span` 一并 32→64，理由是「runner 照记录端口绑，拓宽只扩新席位的规划窗」。

**那个读数是假的**：脚本按 `data.items` 解析，而 registry `/api/agents` 的真实结构是
**顶层 `agents`**，取到空数组，于是「0 条没有 override」被误读成「全部都有 override」。

**实测真相**：37 条里只有 **14 条**带 `port_override`，其余老条目实际绑在 `hash%32` 的
位置。网关改按 `%64` 规划后，把「其实已被占用」的槽当成空槽 → 该路径注册**悬挂**，
边界报 `registry POST /api/agents/register failed (504): {}`；**改前是快速且诚实的
400 `port span exhausted`**。

回退动作（全部已执行并复验）：
- 清单 `AGENT_RUNNER_PORT_SPAN` 回 32 — GitOps commit `d653491`，已 apply + rollout；
- 网关名册行 `agent_runners.port_span` 回 32（两侧必须一致，否则就是 co-host 撞车）；
- 镜像包可见性回 `private`（期间为验证假设临时改过 `public`+`unlisted`，已复原，
  确认它没有出现在公开市场）；
- 回退后真站复验：iframe 挂载、访客提问、产品向导真应答、`replyCap` 收口、零 JS 错。

**三条判据入册**：
1. 解析外部 API 响应前先打印顶层键，别假定 `data.items`；空数组 ≠ 全满足。
2. `%span` 哈希让「端口规划空间」依赖 span 值本身——改 span 是**重排**不是扩容，
   只在全条目都有显式 override 时才安全。
3. 失败形态的退化本身是信号：400（诚实拒绝）→ 504（悬挂）就说明改动是错的。

### 8.2 四席真正缺什么

| 约束 | 实测值 | 结论 |
|---|---|---|
| 端口规划窗 | 32 槽，37 条条目（其中 14 条显式 override） | 已满；扩窗要先解决无 override 条目的规划可信度 |
| runner 内存预算 | `AGENT_RUNNER_RESIDENT_BUDGET_MB=3328`，单 child≈540-600MB | 约 5-6 个并发，现已在跑 3 个 |
| pod 共宿资格 | 要求同包**共用**计费钥匙；部署门禁是「一席一键不可重复」 | `bTnrv2P` 被判 `pod-ineligible — members serve solo`，六席＝六个 dsh 进程 |
| 备用 runner | `runner-b`/`runner-c` 是**缩零的活部署**（不是死行） | 缩零本因见 GitOps `5fc4d8b`：配额耗尽曾卡住 fd-paper-trading 滚版 |
| 命名空间配额余量 | limits.memory 仅剩 **288Mi**、limits.cpu 剩 **700m**、pods 剩 5 | 塞不进 2Gi runner pod |
| 节点真实余量 | cheap-4/6/7 均 8GB，可用 3.9-4.4GB | cheap-6 是控制面，不宜再压 runner |

三条可行路线（都要先拍板，不宜静默动）：

- **A · 抬配额复活 runner-c（cheap-7 worker）**：GitOps 改 `compute-quota.yaml`（+2~4Gi）
  + `agent-runner-c` replicas 0→1 + 镜像从 `sha-51c33c3` 升到与 serving 同代 +
  名册行 `port_span` 到位。爆炸半径最小（不碰在服 30 个 agent），但动集群配额。
- **B · 抬 runner-serving 内存 + 扩窗**：`4Gi→6Gi`、span 扩窗须配套把无 override 条目
  逐个补 override（一次性重指 23 条）。最彻底，也最重。
- **C · 六席共宿**：让同包共用一把计费钥匙以取得 pod 共宿资格 → 六席摊一个 dsh 进程，
  内存问题基本消失。但要改「一席一键」这条计费归属纪律，属平台级决策。

### 8.3 遗留 1 条：`intro-lex` 半部署

`intro-lex` 已有 `pack_deployments` 行、registry 条目也在，但 runner 如实报
`listener ... NOT serving on :8815 — port 8815 already in use`（8815 是别家包
`reception` 的 override）。**它没有被邀请进房间，访客看不到它，不影响对外**。
清掉它需要 admin 权限（`/deployments/:id/kill` 返 `Admin group required`，当前身份
`isAdmin=false`、`adminGroups=["platform"]`），留作待办；不做也不会恶化——
runner 每次 reconcile 只报一行 warn，不动别的席位。
