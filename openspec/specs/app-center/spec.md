# app-center Specification

## Purpose

壹座 web 的发现面（`/apps`）：以单一网格呈现运行在平台上的全部生态产品——每个产品一张卡，职责一句话、可用性如实标注、连接状态与设置「连接」分节同源，「打开」看产品本体、「去连接」直达对应连接卡。项目联邦而非融合：各产品保持自己的站点与身份，这里只聚合入口与状态。

## Requirements

### Requirement: 应用中心导航与路由

登录用户可从主导航进入应用中心页（`/apps`），与既有页面同级。

#### Scenario: 导航项可达

- WHEN 登录用户打开壹座 web
- THEN 侧边栏主导航含「应用」项（testid `nav-apps`）
- WHEN 点击该导航项
- THEN 路由到 `/apps`，应用中心页渲染（testid `app-center-page`）

### Requirement: 五线产品线卡片

应用中心呈现寻数五线（壹座/谦面/萬星/识律/柏讯）卡片，每张含名称、一句话定位、
状态徽标与直达链接。条目单源于 `web/src/lib/appCatalog.ts`。

#### Scenario: 五线齐列

- WHEN 应用中心页加载
- THEN 五张产品线卡片渲染（testid `app-card-{id}`），壹座卡片标注平台自身

#### Scenario: 直达外链

- WHEN 用户点击任一产品线卡片的「打开」
- THEN 在新标签打开该线自有域名（`https://<line>.finddatatech.cloud`）

#### Scenario: 早期状态如实降级

- WHEN 某产品线官网尚为占位/骨架（识律、柏讯现状）
- THEN 该卡片状态徽标如实标注「建设早期」，链接仍直达（不隐藏、不虚构可用性）

### Requirement: 文案与质量线

五语文案齐全（check-locales 门），e2e 哨兵覆盖导航可达+页面渲染+卡片直达行为。

#### Scenario: 五语齐

- WHEN 运行 locales 校验
- THEN `nav.apps` 与 `appCenter.*` 词条在 en/es/fr/ja/zh-CN 五语言文件中键集一致

#### Scenario: e2e 哨兵

- WHEN 运行 app-center e2e spec
- THEN 导航项存在、页面渲染五线卡片、点击卡片触发预期外链导航——全绿
