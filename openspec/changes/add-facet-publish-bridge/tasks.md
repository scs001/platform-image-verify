# Tasks — add-facet-publish-bridge（F3.2）

- [x] 1.1 `facet/pairing.js`：配对三门+bindcode+设备管理面+`withAppBearer`（复用
      app-auth/mp-bindings；未配 secret 诚实 503）
- [x] 1.2 facet/index.js 接线：bindings 落 DATA_ROOT、resolveUser 第三通道、路由挂载
- [x] 1.3 CLI `publish`：载荷两源（本地清单/--from 拉取）+按需配对+静默续登+发布+
      id 映射；USAGE/版本号 v0.3.0
- [x] 2.1 测试：pairing 模块端到端 6/6（真路由+真加密+真 packs 落库）+ CLI publish
      三态 3/3（本地/跨实例/门语）；lint（本片文件）+facet/web build 绿
- [x] 2.2 MineView 回流提示+docs/creating-packs.md 回流节
- [ ] 3.1 提交→镜像滚（facet 面）→生产实证：跨实例拉推+配对+发布门+静默续登
- [ ] 3.2 归档+路线图 F3.2 ✅+记忆
