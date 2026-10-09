# add-mobile-app — Tasks

## 1. 工程骨架

- [x] 1.1 `app/` Expo managed 工程（expo-router、TypeScript、eslint/tsconfig 对齐仓惯例）、`file:` 依赖接 `@platform/core`；`npx expo start` 能起空壳、根 package.json 增 `app:*` scripts；验证 `app:typecheck` 绿
- [x] 1.2 三 Tab 壳（对话/定时/资源）+ pair/share/settings 流程页路由占位；验证 Tab 切换与深链路由可达

## 2. 设备身份与配对客户端

- [x] 2.1 `lib/device-identity.ts`：deviceId 生成、Ed25519 keypair（@noble/curves）、SecureStore 存取；单测覆盖密钥持久化往返与签名形状（消息 `deviceId:nonce`，与 scripts/test-app-pairing.mjs 固定向量同源互证）
- [x] 2.2 `lib/pairing.ts`：capability 探测（含 401=未知照样试）、pair/challenge/login 客户端、401 binding_required→重配语义；单测覆盖 401/超时/老实例三态（fetch mock）
- [ ] 2.3 配对页 UI：扫码（expo-camera，权限被拒给输码路径）+ 手输地址/6 位码；真机冒烟：对 staging 实例完成首次配对拿到 token

## 3. core 注入与聊天主链

- [ ] 3.1 `lib/platform.ts` 注入层：configureHttp（tokenProvider）+ WsClient（RN WebSocket factory）+ AppState→重连+resync；单测：token 过期先静默换发一次再报错
- [ ] 3.2 聊天页（对齐 MP chat）：流式渲染、composer（含附件上传走文档摄入）、会话历史抽屉、模型/角色选择（流式守卫）、复制/重新生成、断线提示与重连；真机验证一轮完整对话（dead-LLM 也无死 UI）
- [ ] 3.3 对齐卡片族：问询卡（gate composer）、产物条带、折叠活动组、大纲栏；逐项与 MP 行为对照验收

## 4. 渲染契约

- [ ] 4.1 Markdown 渲染件（RN 渲染器 + core 解析约定）：标题/列表/代码块/表格滚动；失败降级原文
- [ ] 4.2 ChartWebView 池化组件：echarts HTML 壳资产、postMessage option JSON、高度自适应、失败→代码块；真机验证 bar/line/pie/scatter 四系列
- [ ] 4.3 资源页：列表+筛选+图表预览（复用 4.2）+文件元数据；cron 页：任务列表+启停+计划展示

## 5. 分享、设置、i18n

- [ ] 5.1 分享页：token 进→公开只读渲染（无鉴权头）、不可用态；对照 MP share 行为验收
- [ ] 5.2 设置页：实例地址与可达性、解绑换实例（DELETE 本机绑定→清态回配对页）、中英即时切换、版本信息；验证解绑后服务器侧 binding 消失
- [ ] 5.3 i18n：zh-CN/en 两份资产（可移植键拷贝 web）、系统语言初值、全页面无硬编码文案（lint 级检查）

## 6. 管线与发布

- [ ] 6.1 Maestro flows（android）：配对（mock 实例）、聊天流（真服务器+dead-LLM）、Tab 导航、语言切换；本地 `maestro test` 四流全绿
- [ ] 6.2 GHA `app-e2e.yml`（android 门禁 + iOS nightly 结构）+ 根 CI 增 `app lint/typecheck/unit` 步骤；公开仓通道首跑绿
- [ ] 6.3 EAS 配置（release profile、APK 签名托管、iOS archive）+ `expo prebuild` 自编译 README 段；首出 APK + TestFlight 构建成功
- [ ] 6.4 真机收官冒烟（iOS+Android 各一）：配对→聊天（含图表/问询卡）→cron/资源→设置解绑全链；`openspec validate add-mobile-app --strict` 通过 + 全仓既有门禁不倒退
