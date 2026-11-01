# Tasks: add-desktop-in-app-update

## 1. 发布道

- [ ] 1.1 静态道宿址落位——**机制已选**：release.yml 既有的 MinIO 公开镜像步（从未配 secrets 而
  跳过的 legacy 步，零新设施）；桶凭据（MINIO_* 四项）为运维配置项，配上即活——待配
- [x] 1.2 CI 发布班：release.yml 增「生成 latest*.yml」（gen-desktop-latest-yml.mjs，sha512/size
  原子写）+ 随 GitHub Release 与 MinIO 道上传；哈希一致性测试在 3.1

## 2. 客户端接线

- [ ] 2.1 electron-updater 依赖 + 主进程生命周期（延迟查新/后台下载/退出安装）+ 三态事件面
- [ ] 2.2 设置面：检查更新入口 + available/downloaded/error 状态可见 + macOS 降级原因标注
- [ ] 2.3 通道 URL 可配（默认道内置，桌面管家 config 面读取）

## 3. 测试

- [x] 3.1 单测 6/6（scripts/test-desktop-update.mjs）：生成↔解析回环（electron-updater yml 形状）/
  版本三方比较（1.3.9<1.3.10+prerelease 语义）/平台门（win 真升级·未签名 mac 降级·签名可翻）/
  mac 通知检查（新版本 dmg URL·通道不可达 null 静默·无通道不猜）/生成器垃圾入即抛
- [ ] 3.2 真机：Windows 端到端升级一次眼见；macOS 提示路径眼见；烟测道（win-install-smoke）不回归

## 4. 收尾

- [ ] 4.1 主 spec desktop-app-update 建立（归档时）+ 台账续记 + 双分支收正
