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
