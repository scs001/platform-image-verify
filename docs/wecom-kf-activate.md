# 微信客服（kf）sidecar · 部署与激活

面向：客户企业的管理后台管理员 + 一台服务器（**出口 IP 可控**）。
目标：在客户自己的环境里，把「微信里用户来咨询」的会话完整落到本地，数据不出客户边界。

本文只写客户需要做的事。软件内部怎么判、怎么重试，见
`openspec/changes/add-wecom-kf-ingest/`。

---

## 0. 先确认一件事：这条通道是不是你要的

微信客服（官方名：**微信客服**，接口前缀 `cgi-bin/kf`）的能力与代价：

| | 事实 |
|---|---|
| 拿得到 | 客户在**微信里**给客服账号发来的全部消息（文本/图片/语音/视频/文件/菜单），以及进入会话、会话结束、撤回、接待人员变更等系统事件 |
| 拿不到 | 员工之间的聊天（那是另一条通道） |
| 保留 | 腾讯只保留 **3 天**。拉取器停 3 天以上，那段就是**永久丢失**，不可补 |
| 回复窗口 | 只能回复**客户最后一条消息之后 48 小时内**的会话；超时只能等客户再来 |
| 费用 | 不按席位收费（与会话存档不同），但**企业未认证时累计仅可接待 100 位客户** |
| 前提 | 自建应用必须被加进「微信客服 → 可调用接口的应用」；**接待人员必须在该应用可见范围内** |
| 出口 IP | **必须有固定出口 IP，并加入「企业可信 IP」**。见 §1.3，这是最容易踩的一条 |
| 数据归属 | 数据落在客户自己的机器上，我方不承接数据处理者身份 |

如果上面有任一条不符合你的预期，**先别部署**——尤其「保留 3 天」和「必须有可信 IP」，
它们是这个产品形态的硬约束，不是配置项。

---

## 1. 后台三件配置（都在企业微信管理后台）

### 1.1 把自建应用选为「可调用接口的应用」

「应用管理 → 微信客服 → 可调用接口的应用」里加上你的自建应用。
**没加会返回 `errcode=48002`（api forbidden），表现为「secret 明明是对的却调不通」。**

注意：在这个页面上勾选后，弹「设置成功」的 toast **不等于真的保存成功**。
判据是重新打开页面，客服账号那一行显示「正通过自建应用管理此账号」。以页面状态为准，不以提示为准。

### 1.2 拿到真正的 `open_kfid`

**后台页面上的那串数字不是 `open_kfid`。** 把后台显示的「客服账号 ID」
（形如 `25620181794725350`）传给接口会直接返回 `errcode=95000 invalid open_kfid`。

真值必须从接口取：

```bash
# 用你的 corpid/secret 换 token 后
curl -s "https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=$TOKEN" \
  -H 'content-type: application/json' -d '{"offset":0,"limit":100}'
```

返回的 `account_list[].open_kfid`（形如 `wkqmGucgAAlOx0IPWASY_zpufMyzYDyg`）才是。
只有一个客服账号时也可以不配，软件会自动采用；多个账号时必须显式指定。

### 1.3 企业可信 IP（必做）

「应用管理 → 你的自建应用 → 企业可信 IP」里加入**这台服务器的出口 IP**。

三个必须知道的事实：

1. `gettoken` **不受** IP 限制，所以「能取到 access_token」不代表「能调业务接口」。
2. 业务接口从非白名单 IP 调用会返回 `errcode=60020 not allow to access from your ip`，
   errmsg 里带着实际出口 IP，拿去加白名单即可。
3. 部署机换机房/换 NAT 就会失效。**这条决定了这条通道能部署在哪台机器上**，
   部署前先用下面的命令确认出口 IP 与后台白名单一致：

```bash
curl -s https://ifconfig.me/ip     # 与后台「企业可信 IP」逐字比对
```

---

## 2. 环境变量一览

| 变量 | 必填 | 说明 |
|---|---|---|
| `KF_SYNC_ENABLED` | 自动拉取时必填 | 只认字面 `1`。不填则通道静默不启动（不报错、不建库） |
| `KF_CORPID` | 是 | 企业 ID |
| `KF_SECRET` | 是 | 自建应用的 Secret（**不是**通讯录 Secret）。只从环境注入，不要写进命令行或提交 |
| `KF_OPEN_KFID` | 建议填 | 客服账号 `open_kfid`，取自 §1.2。留空则自动解析（多账号会明确报错） |
| `KF_DB` | 否 | 库文件路径，默认 `data/kf.db` |
| `KF_MEDIA_DIR` | 否 | 附件目录。填了才会下载附件；不填只记录 `media_id` |
| `KF_CORP_VERIFIED` | 否 | 企业已认证时填 `1`，诊断里的容量上限随之变成 2000/5000 |
| `KF_BASE_URL` | 否 | 仅调试用，默认官方地址 |

不要做的事：把 `KF_SECRET` 写进 `docker-compose.yml`、systemd unit、或提交进仓库。
用环境变量文件并限制权限（`chmod 600`），或走你现有的密钥管理。

### 2.1 独立 sidecar（推荐形态）

不需要装整套平台。一个容器、一个库：

```bash
# 1) 依赖只有 Node 标准库，把这几样拷到目标机
#    paths.js  server/archive/window.js  server/archive/consent.js  server/archive/kf/

# 2) 配置单独放一个文件，只给 root 读
install -m 600 /dev/null /opt/kf-sidecar/env
cat > /opt/kf-sidecar/env <<'ENV'
KF_SYNC_ENABLED=1
KF_CORPID=ww...
KF_SECRET=...
KF_OPEN_KFID=wkqm...
KF_DB=/data/kf.db
KF_MEDIA_DIR=/data/media
ENV

# 3) 起容器。**必须 --network host**：出口 IP 就是这台机的 IP，
#    换成 bridge 会变成 NAT 后的另一个地址，白名单立刻失效。
docker run -d --name kf-sidecar --restart unless-stopped \
  --network host \
  --env-file /opt/kf-sidecar/env \
  -v /opt/kf-sidecar/app:/app -v /opt/kf-sidecar/data:/data -w /app \
  node:24-alpine node server/archive/kf/sidecar.mjs
```

自查两件事：

```bash
docker exec kf-sidecar node -e 'const r=await fetch("https://ifconfig.me/ip");console.log((await r.text()).trim())'
# 这个 IP 必须等于后台「企业可信 IP」
docker logs --tail 20 kf-sidecar
# 应看到 [kf-sync] pulled=... errors=0；启动 20s 后跑第一轮
```

sidecar 与平台的关系：读接口面（`/api/archive/kf/*`）只在平台里提供；纯 sidecar 形态下
用 CLI 命令查（`convs` / `inbox` / `search`），或者只落库、把库当唯一产出。

---

## 3. 首次启动与验收

```bash
# 1) 诊断：五态之一，退出码非 0 就不要启动拉取
node server/archive/kf/cli.mjs doctor

# 2) 拉一轮（不启动常驻，先确认能落库）
node server/archive/kf/cli.mjs sync

# 3) 看会话 / 待回复 / 检索
node server/archive/kf/cli.mjs convs
node server/archive/kf/cli.mjs inbox
node server/archive/kf/cli.mjs search 报价

# 4) 附件补取（配了 KF_MEDIA_DIR 才需要单独跑）
node server/archive/kf/cli.mjs media
```

`doctor` 的判定口径：

| verdict | 含义 | 你要做的 |
|---|---|---|
| `ready` | 接口通且有数据 | 可以常驻 |
| `ready_empty` | 接口通但 3 天窗口内没有消息 | 正常。这是「就绪」不是故障——从微信侧给客服号发一条即可 |
| `unconfigured` | 缺 `corpid`/`secret` | 填环境变量 |
| `api_unavailable` | 取票或接口调用失败 | 看 `blockers`：凭据配对 / 可调用接口的应用 / 出口 IP / 客服账号 id，四类分别点名 |

**验收的最小闭环**：用个人微信给客服账号发一条文字 + 一张图，重跑 `sync`，
然后确认三件事：

1. 客户那条消息 `origin=peer`，系统事件是 `origin=system`，本方回复是 `origin=self`；
2. 图片在 `KF_MEDIA_DIR` 下真的落成文件（不是零字节或几百字节的假图片）；
3. `inbox` 里这条会话进入「待回复」，且显示的截止时间是「客户最后一条消息 + 48 小时」。

---

## 4. 日常运维

- **拉取间隔**默认 5 分钟。因为官方只保留 3 天，别把间隔调到小时级——一次长时间停机
  就可能吞掉一段不可补的数据。
- **巡检看三个数**：`data/kf.db` 的游标是否在推进、`lastCheckedAt` 是否在 1 小时内、
  `inbox` 里有没有已错过的会话。读接口面：`GET /api/archive/kf/sync-status`、
  `/coverage`、`/inbox`（全部只读，没有写入入口）。
- **滞后判定**：超过 2 天告警，超过 3 天即「永久缺口」，只能从当下重新开始。

---

## 5. 三条不要做的事

1. **不要把后台那串数字当 `open_kfid`。** 会得到 `95000`，而且报错看起来像权限问题。
2. **不要用「取票成功」证明通道可用。** `gettoken` 不校验 IP，`60020` 一定出现在取票之后。
3. **不要给这条通道开自动回复。** 发出的是给真实客户的消息；本软件只有显式
   `reply <用户> <正文> --confirm` 才会发，默认是演练。请保留这个默认。
