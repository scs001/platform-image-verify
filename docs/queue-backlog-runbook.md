# 队列积压 / 假绿的判读手册

> 来源：`openspec/changes/harden-fleet-execution-economics` 任务 5.3。
> 2026-11-08~09 两次误判的产物——先说结论：**看见"队列很深"之前，先确认这个数字是怎么算出来的。**

## 一、为什么这个数字曾经不可信

`jobs.json` 里有两个时间戳，含义不同：

| 字段 | 含义 | 会不会被重置 |
|---|---|---|
| `queuedAt` | **本次尝试**入队的时刻 | **会**——每次重新入队、每次启动 `drainRepairQueue` 都重打 |
| `firstQueuedAt` | 这发请求**第一次**要槽位的时刻 | 不会（`saveTasks` 白名单专门保留） |

用 `queuedAt` 算等待时长，重启后整批积压会显示成"刚入队"。实测（2026-11-08）：

- 用 `queuedAt`：最老等待 ≈ **1 分钟**；
- 用 `firstQueuedAt`：p50 **85 分钟**、最长 **148 分钟**。

同一个队列，差了两个数量级。已在 `task-engine.js::queueAnchorMs` 与
`server/cron-runner.js::_queueWaitMs` 统一为 `firstQueuedAt ?? queuedAt`。

## 二、看见积压：一条命令

```bash
# 1) 队列健康（就绪面同源）：200 正常 / 503 降级
curl -s -o /tmp/q.json -w '%{http_code}\n' http://127.0.0.1:3100/readyz
python3 -m json.tool /tmp/q.json
```

`/readyz` 的字段：

| 字段 | 读法 |
|---|---|
| `queued` | 所有 resident cell 的排队总数 |
| `oldestQueuedMs` | **最老等待**（`null` = 没有任何 cell 答上来，不要读成 0） |
| `degradedCells` | 哪些 cell 自己报了降级（超阈值/超预算） |
| `unknown` | 问不到的 cell 及原因（**不算失败**：一个慢 cell 不该摘掉整个平台） |
| `answered` | 答上来的 cell 数；`answered < cells` 说明有 cell 失联，结合 `unknown` 看 |

**注意**：`/api/ready`（cell 侧、带 `queue` 段与 503）从 pod 内直连是 **401**——
网关拦在鉴权后面，k8s 探针读不到。要用 `/readyz`（网关侧、无鉴权、聚合各 cell）。

## 三、直接看盘（不依赖任何端点）

```bash
POD=$(kubectl -n fd-prod get pods -o name | grep 'platform-' | grep -v demo | head -1)
kubectl -n fd-prod exec $POD -c platform -- node -e '
const fs=require("fs"),path=require("path");
const now=Date.now();
for (const c of fs.readdirSync("/data/cells")) {
  const f=path.join("/data/cells",c,"data","cron-store","jobs.json");
  if(!fs.existsSync(f)) continue;
  let a; try{a=JSON.parse(fs.readFileSync(f,"utf8"));}catch(e){continue;}
  if(!Array.isArray(a)) continue;
  const q=a.filter(t=>t&&t.state==="queued");
  if(!q.length) continue;
  const w=q.map(t=>{const k=Number.isFinite(t.firstQueuedAt)?t.firstQueuedAt:t.queuedAt;
    return Number.isFinite(k)?Math.round((now-k)/60000):null}).filter(x=>x!==null).sort((x,y)=>x-y);
  console.log(c,"queued="+q.length,"p50="+w[Math.floor(w.length/2)]+"min","max="+Math.max(...w)+"min");
}'
```

## 四、四态口径：别把"没跑"算成"失败"（这是最容易犯的错）

`history[]` 有**四种**结局，不是成功/失败两种：

```js
h.success === null && h.missed   → 到期未执行（槽位被占，从未开始）
h.success === true               → 完成
h.state === "skipped"            → 主动跳过（老化/降级）
h.success === false              → 真失败
```

- **失败率** = `failed / (done + failed + skipped)` —— 分母**只含真正执行过的**；
- **排队饥饿** = `missed / (done + failed + skipped)` —— 这个比值才是"排不上队"的硬指标。

2026-11-08 实测：最近 24h 真执行 590（done 148 / failed 328 / skipped 114），
另有 **842 次到期未跑** → 失败率 55.6%、`missed:executed = 1.43:1`。
（第一版按二态算得出 89.7% 失败率，是错的——把 842 条 missed 当成了失败。）

## 五、判断"该不该加承载"

顺序不能颠倒：

1. **先看失败构成**：如果 68% 是 `budget_exhausted`，加并发只是更快地把额度撞完；
2. **再看积压是"排不上"还是"跑得慢"**：`missed` 高 = 排不上；`turn_timeout` 高 = 跑得慢；
3. **最后才谈并发**：`TASK_WORKER_MAX>0` 需要确认三件事——
   容器大版本已抬（准入按 `used + cell 足迹` 比对 `limit × 0.85`）、
   池级看门狗在镜像里（否则不结算的回合会永久占槽）、
   目标 tag 已在节点缓存（否则 `Recreate` 会拉取失败）。

## 六、已知的坑（都实测过）

| 现象 | 真因 |
|---|---|
| 积压很深但 `/api/ready` 绿 | ①探针读不到（网关 401）；②`queuedAt` 被重启重置 |
| 改 limit 后 pod 建不出来、全站断 | `fd-prod` 配额 `limits.memory` 顶满；`Recreate` 先删旧 pod → 直接断服。**改资源前先 `get quota`** |
| worker 池开了但回合空转 608s | 唤醒准入拒（`limit` 太小，投影 <15% headroom）；且当时无池级看门狗 |
| `budget_exhausted` 占比极高 | 每日额度 8M 已耗尽；加并发无益，要么分账要么降任务量 |
