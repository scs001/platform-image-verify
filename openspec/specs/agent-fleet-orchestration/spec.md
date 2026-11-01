# agent-fleet-orchestration Specification

## Purpose

编导代数第一波:舰队以显式 orchestration 声明段描述边(trigger/dispatch/handoff/report)与约束;dispatch 走既有 delegation 车道(异步送达+护栏),handoff 挂回合收口逐跳接棒;mode 预制图读时展开;执行真源仍是任务引擎+delegation 车道,不引入第二调度器。

## Requirements


### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为六种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,= 既有报数通道,行为不变)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)、`fanout`(上游岗回合完成后并行扇出至多岗并按聚合式汇流)、`event`(外部信号源唤醒某岗)。每条边 SHALL 显式引用本舰岗位 ref(event 边的 from SHALL 为 `bot:<botId>` 形式的外部信号源名,存在性由运行期如实判定);系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。event 边的 to SHALL 为 persona/a2a 岗(cluster 无 manual 车道、tool 的参数是逐跳 args,均结构化拒绝);event 边 SHALL NOT 参与 DAG 环检测。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

**编导随模板下发**：orchestration 段 SHALL 可作为 pack 舰队模板的组成部分下发——发布预校验与实例化建队 SHALL 复用与写面同一校验器（以模板成员集为岗位域）；由模板落地的编导与手写编导在运行时 SHALL 无差异，主人的后续改写走既有写面。模板编导不改变本条的任何护栏语义。

#### Scenario: 声明一条流水线

- **WHEN** 舰队声明 handoff 边 抓取→清洗→撰稿 与 trigger 边 cron(0 9 * * *)→抓取
- **THEN** 校验通过,三岗节奏物化照常(清洗/撰稿无节奏物化),每日 9 点抓取回合完成后自动接棒清洗

#### Scenario: 隐式推断被拒

- **WHEN** 声明段留空但期望按建队顺序成链
- **THEN** 不产生任何 handoff 行为;边只有显式声明一种来源

#### Scenario: 环拒绝

- **WHEN** handoff 边构成 A→B→A
- **THEN** 写面结构化拒绝并指名成环边

#### Scenario: 未声明逐字节等价

- **WHEN** 一支未声明 orchestration 的既有舰队在本 change 后运行
- **THEN** 节奏物化、报数、拍板、模型归位、事件流与现状逐字节一致(既有测试套件为等价证明)

#### Scenario: fanout 边校验

- **WHEN** 声明 fanout 边 targets 只有一个岗,或 targets 含 from 自身,或 judge 引用 targets 成员,或 rounds 为 5,或 targets 含 tool 岗
- **THEN** 写面结构化拒绝并逐项指名

#### Scenario: event 边校验

- **WHEN** 声明 event 边 from="bot:helper" to=客服岗(persona),或 to 为 cluster/tool 岗,或 from 非 bot: 形式
- **THEN** 前者通过;后两者结构化拒绝并指名原因

#### Scenario: 模板编导与手写无差异

- **WHEN** 两支结构相同的舰队，一支的 orchestration 来自模板下发、一支由主人手写
- **THEN** 二者的边展开、派发许可、接棒与唤醒行为完全一致
### Requirement: dispatch 边使能同舰队岗位间派活

持有 dispatch 许可(显式 dispatch 边或 supervisor/pipeline 模式展开)的岗位回合 SHALL 获得 `dispatch_post` 工具:按岗位 ref 派活给同舰队岗位,brief 为自包含任务说明;派发 SHALL 走既有 delegation 车道创建 manual 任务(证据 `origin.fleet` 指名目标岗、initiator 为派发岗会话),结果 SHALL 异步送达——派发立即返回,目标岗回合摘要经聚合器在派发岗下一回合注入,系统 SHALL NOT 挂起派发回合等待。护栏 SHALL 结构化拒绝:跨舰队目标、自派、目标岗回合深度已达 1、每岗每回合派发超上限(默认 3)、舰队每小时派发超上限(默认 30,均可 env 配置)。派发目标域 SHALL 为 persona、a2a 与 tool 岗(cluster 岗无 manual 车道,SHALL 结构化拒绝)。派发与被派发回合 SHALL 经既有回合收口自动产出 O1 事件,不新增记录路径。

#### Scenario: 主管派活闭环

- **WHEN** supervisor 模式下主管岗回合内 dispatch_post(执行岗 ref, brief)
- **THEN** 执行岗起 manual 回合,brief 含派发者身份;派发岗本回合继续收尾,下回合收到执行岗回合摘要

#### Scenario: 护栏拒绝面

- **WHEN** 派发目标在另一舰队、或目标为本岗、或目标回合深度已 1、或超频次上限
- **THEN** 工具以结构化错误拒绝并指明原因,不创建任务
### Requirement: handoff 边在上游回合完成后接棒下游

上游岗回合结束(成功或失败均如实)时,系统 SHALL 在回合收口处检查该岗出边:每条 handoff 边 SHALL 为下游岗创建 manual 回合(persona、a2a 与 tool 岗可达;cluster 岗无 manual 车道,跳过),证据 `origin.fleet` 指名下游岗,深度按链位递增且不超过声明链长,每跳时长上限取 budgetPerEdgeMin;整链 SHALL 逐跳产出 O1 事件,链上各跳花费合计记入发起回合的证据链。上游失败时下游 SHALL 照常接棒并收到失败上下文(如实转述,不自动重试)。

#### Scenario: 链式接棒

- **WHEN** 抓取岗回合成功结束且有 handoff 边至清洗岗
- **THEN** 清洗岗自动起回合,brief 含上游产出引用与链位;两跳各产一条 O1 事件

#### Scenario: 上游失败如实接棒

- **WHEN** 抓取岗回合失败(errorKind=model_upstream)
- **THEN** 清洗岗照常接棒,brief 含上游失败摘要;不重试、不吞错

#### Scenario: 链深守界

- **WHEN** 递增后的链位将超过声明 maxChainDepth
- **THEN** 不创建下游回合,以结构化事件记录越界拒绝

### Requirement: fanout 边以并行波执行且有界轮次成环

上游岗回合结束后,系统 SHALL 对其每条 fanout 出边执行一个并行波:为每个目标岗创建 manual 回合(深度按链位递增受 maxChainDepth 硬界,brief 含上游产出或失败的如实转述与轮次标注,与 handoff 同式;深度超界时 SHALL 不建任务并落结构化 O1 事件如实留痕)。聚合 SHALL 二式分流:无 judge 时,波内任务的 initiator SHALL 为上游回合会话——delegation 聚合器在全部终态后把全组结果注入上游岗的下一回合;声明 judge 时,initiator SHALL 为 `fleet:<舰队标识>:<judge 岗位标识>` 且 initiatorPreset 为 judge 岗 persona——聚合器 SHALL 自动以裁决者身份起一回合,其输入为全组目标产出。多轮辩论 SHALL 由裁决者在裁决回合内显式派发下一波(既有派发许可与护栏,深度界为硬防线);边的 rounds 声明 SHALL 为草稿呈现层的上界提示,系统 SHALL NOT 依其自动重入。

#### Scenario: 并行波与默认聚合

- **WHEN** 主编岗回合结束,有 fanout 边 targets=[撰稿A,撰稿B] aggregate=all
- **THEN** 两 manual 回合并行创建;两回合全部终态后,聚合器把两份产出注入主编会话的下一回合

#### Scenario: 裁决回合

- **WHEN** 同上但 aggregate={kind:"judge", judge:评审岗}
- **THEN** 波内任务 initiator 指向评审岗;全组终态后评审岗自动起回合,brief 含两份产出摘要

#### Scenario: 深度界拒绝波

- **WHEN** 链位递增后超过舰队声明 maxChainDepth 的扇出目标
- **THEN** 该目标不建任务,落 O1 事件留痕拒绝

#### Scenario: 多轮辩论为显式派发

- **WHEN** 裁决回合认为需要第二轮且舰队声明了相应派发许可
- **THEN** 第二波由裁决岗 dispatch_post 显式发起,护栏与深度界照常生效;系统不依 rounds 自动重入

#### Scenario: 上游失败如实入波

- **WHEN** 上游回合失败,fanout 出边照常触发
- **THEN** 波内 brief 含失败转述,不重试不吞错

### Requirement: bot 入站消息唤醒绑定的岗位

社聊 bot 的入站消息在既有守卫(尺寸/频次)全部通过后,系统 SHALL 额外扫描舰队的 event 边:存在 `from:"bot:<该 bot>"` 的边时,SHALL 为每条边的 to 岗位创建 manual 回合——brief 含发送者与消息原文、`origin.fleet {memberId, depth:0}` 与 `origin.event {botId, chatKey}`,该回合 SHALL 经既有收口产出 source=event 的 O1 事件。bot 自身的会话回合 SHALL 照常执行(bot 答聊天,岗位异步做舰队事)。护栏:每岗每小时唤醒次数 SHALL 有上限(默认 30,环境可配),超限 SHALL 不建任务并落结构化 O1 事件如实留痕。无命中边的入站消息 SHALL 零扰动。

#### Scenario: 命中唤醒

- **WHEN** 客服 bot 收到一条消息,且某舰队声明了 event 边 bot:客服bot→客服岗
- **THEN** 客服岗起 manual 回合(prompt 含消息原文与发送者),O1 事件 source=event;bot 照常回答聊天

#### Scenario: 护栏超限

- **WHEN** 一小时内该岗被唤醒已达上限又来一条命中消息
- **THEN** 不建任务,落 O1 事件留痕拒绝

#### Scenario: 无命中零扰

- **WHEN** 一条入站消息没有任何 event 边引用该 bot
- **THEN** 不产生任何舰队任务与事件,bot 行为与现状逐字节一致