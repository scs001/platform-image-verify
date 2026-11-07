# Tasks: add-zhiyu-private-window-send

## 1. 路由器：私窗车道

- [x] 1.1 `room-router.js`：应答行/事件行 visibility 按 mode（private → `private:<发起者 user id>`）；新增 `dispatchPrivateTurn`（定向 facade、跳过广播/@解析、日预算闸照常、settle usage id 带 `-private`）
- [x] 1.2 `index.js`：`POST /api/zhiyu/rooms/:id/private`（active user seat 闸、分身在席检查、缺席 409 零落库、吩咐行 private 档、fire-and-forget 派发）

## 2. 前端

- [x] 2.1 私窗抽屉输入区：发送 → `POST /private`，guest 不渲染输入区

## 3. 测试

- [x] 3.1 私窗交换落 private 档 + 共享读取面不可见 + guest 403 + 分身缺席 409 零落库 + 日预算计数 + usage 尾缀
- [x] 3.2 全量 zhiyu 套件回归绿；biome/typecheck

## 4. 出片与真机

- [ ] 4.1 提交双推 + `--init` 快照出片（toplevel 前查）+ workflows 恢复 + CI 绿
- [ ] 4.2 relay → ccr 硬门 → GitOps bump（fetch 对账当前 image 行，防并发 bump 竞态）→ 滚版 → 双 pod 全等
- [ ] 4.3 真机：私窗吩咐 → 吩咐行+应答行 private 档落库、guest 流与共享历史零可见（3.2 正向样本闭环）；走查单 3.2 勾选

## 5. 收口

- [ ] 5.1 strict 校验 → 归档入 spec；台账续记
