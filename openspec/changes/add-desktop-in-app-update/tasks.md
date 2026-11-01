# Tasks: add-desktop-in-app-update

## 1. 发布道

- [ ] 1.1 静态道宿址落位（现有静态 serving 面择一挂载 `/desktop-releases/`，追加语义）
- [ ] 1.2 steward 打包班出包 + latest.yml 生成 + 推道（哈希一致性测试在 3.1）

## 2. 客户端接线

- [ ] 2.1 electron-updater 依赖 + 主进程生命周期（延迟查新/后台下载/退出安装）+ 三态事件面
- [ ] 2.2 设置面：检查更新入口 + available/downloaded/error 状态可见 + macOS 降级原因标注
- [ ] 2.3 通道 URL 可配（默认道内置，桌面管家 config 面读取）

## 3. 测试

- [ ] 3.1 单测：元数据生成/哈希一致性 + updater 三态 stub + 通道不可达静默降级
- [ ] 3.2 真机：Windows 端到端升级一次眼见；macOS 提示路径眼见；烟测道（win-install-smoke）不回归

## 4. 收尾

- [ ] 4.1 主 spec desktop-app-update 建立（归档时）+ 台账续记 + 双分支收正
