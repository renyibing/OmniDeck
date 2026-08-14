# OmniDeck Architecture Audit

审计日期：2026-08-13  
审计范围：当前工作树（包括未提交的增量实现）  
阶段：Phase 0 — Audit，仅审计，不实施 Knowledge Foundation

## 0. 审计方法与状态定义

本审计基于 `README.md`、`docs/`、`package.json`、Vite/TypeScript/Tauri 配置、`src/app`、`src/components`、`src/domain`、`src/server`、`src-tauri`、脚本与测试的实际代码，而不是只依据产品文档判断。

验证基线：

- `npm run lint`：通过。
- `npm test`：23 个测试文件、150 项测试全部通过。
- `npm run build`：通过。
- `.agents/skills/omnideck-multi-device-control/scripts/validate_omnideck.sh`：通过。
- 本轮未连接或操作真实 Android/iOS 设备，不能据此声明真机验收通过。
- 本轮未进行浏览器 8/16/32 布局视觉回归；现有自动测试覆盖会话、调度、协议与部分 UI helper，不等于完整视觉验收。

状态定义：

| 状态 | 含义 |
| --- | --- |
| `IMPLEMENTED` | 已形成可运行实现，并有直接测试或可验证调用链 |
| `PARTIAL` | 已有真实骨架或部分闭环，但与目标能力仍有明显差距 |
| `MISSING` | 当前代码无对应实现 |
| `BROKEN` | 已有实现无法通过当前验证或关键链路不可用 |
| `REDUNDANT` | 存在职责重叠或可能形成重复事实源的实现 |
| `ARCHITECTURE_RISK` | 当前可运行，但继续演进会带来所有权、扩展性、安全性或数据一致性风险 |

当前没有经自动验证确认的整体 `BROKEN` 模块。真机链路的未验收项标为 `PARTIAL`，不误标为已完成。

## 1. Current Architecture

当前真实所有权与数据流如下：

```text
React Control Center
  App / Monitor Wall / Task Center / Device Inspector
  useControlCenter + ControlCenterClient
                │
       HTTP commands/snapshots
       SSE ordered events
       WS H.264 / MJPEG / PNG frame
                │
                ▼
Local ControlDaemon (single live-state owner)
  ├── DeviceManager -> stable DeviceSession[deviceId]
  ├── SessionManager -> view-driven stream policy
  ├── TaskScheduler -> per-device TaskInstance + resource limits
  ├── ControlPlane -> task/action/approval/offline lifecycle
  ├── DriverRegistry
  │     ├── SimulatedDeviceDriver
  │     ├── AndroidAdbScrcpyDriver
  │     └── IOSXCUITestDriver
  ├── EventStore -> bounded in-memory ordered replay
  ├── ArtifactStore -> bounded in-memory task evidence metadata
  └── RuntimeStateStore -> device configuration JSON persistence

Per-device Agent task
  ObservationBuilder
      screenshot metadata + UI hierarchy + task-local context
        -> AgentPlannerProvider
        -> Zod AgentAction whitelist
        -> approval gate
        -> device-scoped driver action
        -> post-action observation/verification
        -> AgentStepTrace + ArtifactStore
```

该架构已经满足关键不变量：React 不创建运行态 owner；设备会话以 `deviceId` 稳定持有；批量目标展开为独立任务；动作显式定向；AI 观察使用按需截图而不是连续视频。

与目标架构的主要差异在于：`Observation -> OVS -> Scene -> Rule/Skill -> Agent fallback` 尚不存在。当前是 `Observation -> Planner -> Action`，deterministic planner 或外部 planner 仍是每步决策入口。

## 2. Existing Capabilities

### 2.1 模块审计矩阵

| 模块 | 状态 | 当前实际实现 | 闭环判断 |
| --- | --- | --- | --- |
| Desktop / Tauri | `PARTIAL` | Tauri 2 shell、Control Daemon/ADB/scrcpy/iproxy 进程监督、端口分配、日志读取 | macOS 开发链路存在；Windows 打包、签名、升级与发布未验证 |
| Monitor Wall | `IMPLEMENTED` | 1/4/8/9/16/25/32 布局、选择、多选、拖拽排序、全屏、monitor-only、轻量 tile | 前端视图与 stream-policy API 闭环 |
| Device Inspector | `IMPLEMENTED` | selected-device detail、预览控制、UI tree、WDA/native diagnostics、Agent trace、approval、timeline/log | 只加载单设备重数据，符合 DTO 边界 |
| Task Center | `IMPLEMENTED` | 全局轻量任务索引、过滤、selected-task audit、artifact/trace、审批入口 | UI -> API -> ControlPlane 闭环 |
| Device Manager | `IMPLEMENTED` | 32 个稳定 `DeviceSession`、配置、掉线、恢复、状态就地更新 | 会话身份隔离有测试 |
| Device Session | `IMPLEMENTED` | task/context/history/memory/health/stream/driver state 均为设备本地对象 | 布局/全屏不重建 session |
| Scheduler / Worker Pool | `IMPLEMENTED` | batch per-device expansion、优先级队列、AI/VLM/ADB/iOS 独立限制、rate limit、retry metadata | 8/16/32 模拟与资源限制有测试 |
| Control Plane | `IMPLEMENTED` | pause/resume/stop/retry、offline/recover、human takeover、手工与 Agent 动作 | device-scoped 生命周期闭环 |
| Android ADB | `IMPLEMENTED` | 所有命令使用显式 `adb -s <serial>`；截图、UIAutomator、动作、app lifecycle、health | 代码和单元测试可用；本轮未做真机验收 |
| Android scrcpy | `PARTIAL` | scrcpy-server packet/parser/registry、WS H.264、WebCodecs 解码、PNG fallback、进程监督 | 本地视频通路已实现；32 路真机性能和跨平台分发未验收 |
| iOS WDA/XCUITest | `PARTIAL` | device-local WDA URL/session、`/source` hierarchy、截图、动作、app lifecycle、MJPEG/fallback、诊断 | 单元测试可用；签名、provisioning、多机端口和真实设备稳定性未验收 |
| UI Hierarchy | `IMPLEMENTED` | Android UIAutomator XML 与 iOS WDA source 均解析为统一 hierarchy | Observation 和 selected-device API 已接入 |
| Agent Observation | `PARTIAL` | 按需截图 metadata、UI summary、task context、action history、approval state | 无 OCR、current app version、previous scene、scene transition context |
| Agent Planner | `IMPLEMENTED` | deterministic provider + DeepSeek-compatible provider；输出经 Zod 白名单校验 | Observation -> Plan -> Execute -> Verify 已闭环 |
| Agent Step Engine | `IMPLEMENTED` | 多步运行、执行、验证、超时、token/cost/latency、step trace | device/task local，测试覆盖完整 |
| Playbooks | `PARTIAL` | feed scroll 等确定性 playbook/catalog | 是 Rule/Skill 的可复用雏形，但没有声明式 schema、scene entry/success/recovery |
| Human Approval | `PARTIAL` | 敏感关键词/动作 gate、WAITING_APPROVAL、approve/reject API 与 UI | 策略散落于 action/planner/control plane，尚无统一 `ApprovalPolicy` 实体 |
| Human Takeover | `IMPLEMENTED` | take/release control、设备本地手工动作串行、恢复后重新观察 | 前后台闭环且显式 deviceId |
| Health Monitor | `PARTIAL` | 基础 health 分类、定时检查、offline isolation/recovery | 没有独立 recovery policy、连续失败预算、趋势/告警 |
| Observation Recording | `PARTIAL` | step trace 与 ArtifactStore 保存有价值的 metadata，输入文本脱敏 | 默认不持久化截图/UI tree/OCR before-after 数据集，不能 replay OVS |
| Runtime Persistence | `PARTIAL` | JSON 保存设备配置和 auto-connect；artifacts/events/live tasks 主要在内存 | 不具备知识、指标、候选、transition 的事务查询能力 |
| API | `IMPLEMENTED` | versioned DTO、HTTP commands、explicit IDs、idempotency、detail routes、SSE replay | 当前设备/任务控制 API 闭环 |
| Realtime Events | `IMPLEMENTED` | bounded `EventStore`、严格 sequence、SSE replay/resync、atomic subscription | 事件只覆盖现有 device/task/health/control 域 |
| Database | `MISSING` | 无 SQLite/PostgreSQL/ORM/迁移体系 | 只有 JSON runtime state 与内存 stores |
| Knowledge Base | `MISSING` | 无 `knowledge/`、Markdown loader、frontmatter/wiki-link parser | 无运行时知识读取能力 |
| Knowledge Schema Validator | `MISSING` | 无 Scene/Element/Skill/Rule/Recovery schema | 非法知识尚无隔离机制 |
| Knowledge Compiler | `MISSING` | 无 validate/normalize/compile/runtime cache | 当前无可编译输入和数据库 |
| OVS Engine | `MISSING` | 无 scene recognition、confidence、variant、alternatives | tile/inspector 无 scene DTO |
| OCR / Visual Recognition | `MISSING` | 无 OCR adapter、layout/visual feature matcher、VLM scene fallback | screenshot 目前用于 observation，不用于 scene classifier |
| Global Scene Library | `MISSING` | 无 CAPTCHA/LOGIN_EXPIRED/NETWORK_ERROR 等全局 scene | CAPTCHA 只能靠 planner/审批间接处理，非统一优先级规则 |
| Element Library / Grounding | `PARTIAL` | `tap_element` 支持 resourceId/text/contentDesc selector，并临时转换坐标 | 无稳定 element ID、scene binding、visual/semantic selector 或 confidence |
| Scene Graph | `MISSING` | 无 transition 统计、known path 或 expected next scenes | action history 不是 scene graph |
| Skill / Rule Engine | `PARTIAL` | deterministic planner/playbooks 提供硬编码规则 | 无知识驱动、声明式、可编译的 rule engine |
| Recovery Engine | `PARTIAL` | device offline recovery、driver command/session retry 分散存在 | 无统一 maxRecoveryDepth、scene-aware recovery 和 RecoveryRecord |
| Knowledge Candidate | `MISSING` | 无 PENDING/APPROVED/REJECTED/MERGED 工作流 | Agent 不会写正式知识，也不会生成候选 |
| Knowledge Search | `MISSING` | 无 app/scene/skill/recovery/historical-case retrieval | 无 embedding table 或结构化检索 |
| Knowledge Analytics | `MISSING` | task token/cost/latency 已统计，但无知识对象指标 | 无 stale/need-review、reuse/hit/fallback 指标 |
| OVS/Knowledge UI | `MISSING` | 导航中无 Knowledge 页面，tile/inspector 无 scene 状态 | 不是“只有 UI”；当前连 DTO/API 都不存在 |
| Replay Dataset/Test | `MISSING` | 有 hierarchy/parser/agent tests，无 scene fixture replay | `tests/fixtures/scenes` 不存在 |
| Real-device scale test | `MISSING` | guarded driver 与 smoke scripts 存在 | 未有 8 台授权真机的性能/故障注入证据 |

### 2.2 真正形成前后台闭环的能力

- Monitor Wall snapshot/SSE 更新、stream policy 和 selected-device detail。
- 设备发现、配置、显式连接与 driver 注册。
- 批量目标到独立 per-device task，再到 worker/resource queue。
- Agent 的 observation、plan、白名单校验、审批、execute、verify、trace/artifact。
- 人工接管后的 tap/swipe/long-press/text/key/back/home 与审计。
- 设备掉线只中断本机任务，恢复后显式 resume。
- Android H.264/MJPEG/PNG 与 iOS MJPEG/PNG 的预览 fallback 策略。
- Task Center 的查询、审计与 approval 操作。

### 2.3 仅为 UI 或展示数据的能力

- 初始 32 台设备名称、型号、app、telemetry、部分运行任务来自 `DeviceManager` seed；模拟模式下这些是演示数据，不是硬件遥测。
- Dashboard/StatusBar 的 CPU、memory、battery、temperature 等在模拟会话中是 seed 值；真机驱动尚未形成完整遥测采集闭环。
- 当前不存在 Scene、confidence、variant、knowledge analytics UI，因此不能将这些能力描述为“UI 已有、后端待接”。

## 3. Architecture Problems

### 3.1 P0：目标决策链尚未建立

`OVS -> Scene -> Known Rule / Unknown Agent` 完全缺失。当前 deterministic/external planner 直接消费 observation。若直接在 ControlPlane 中继续堆 scene 判断、知识解析和 recovery 分支，会把设备生命周期 owner 变成全能类，并使每步测试难以隔离。

### 3.2 P0：无受验证的知识运行时

仓库没有知识目录、schema、loader、validator、compiler 或数据库。Markdown 不能被直接当运行时配置，更不能允许 Agent 写正式规则。Phase 1 必须先建立 validator/compiler 边界，OVS 才有稳定输入。

### 3.3 P0：全局安全 Scene 不存在

CAPTCHA、ACCOUNT_RISK、SYSTEM_PERMISSION、DEVICE_LOCKED 等没有高于普通业务 scene 的统一识别和处理优先级。现有敏感动作审批只覆盖 goal/action，不等价于“识别验证码后强制 HUMAN_REQUIRED”。

### 3.4 P1：ControlPlane 体积与职责持续增长

`ControlPlane` 同时承担 task lifecycle、Agent loop、approval、manual control、artifact、health、recovery 和 task query aggregation。它仍是正确的 device action owner，但后续 OVS/Skill/Knowledge 不应直接内嵌其中；应以清晰接口注入并保持 device-scoped orchestration。

### 3.5 P1：持久化事实源不足

`RuntimeStateStore` 只保存设备配置，`EventStore` 与 `ArtifactStore` 主要在内存。进程重启后无法可靠保留候选、知识指标、transition 成功率、observation replay index 或审批历史。引入数据库时必须区分 live runtime owner 与 durable records，不能让数据库替代 DeviceSession 的运行态所有权。

### 3.6 P1：文档与实现发生漂移

部分文档仍声称 iOS `/source` UI hierarchy 未接入、Human Approval panel 待补，但当前代码已经实现。这会导致重复开发。后续每个 Phase 应同步更新 capability matrix，并以测试和代码为准。

### 3.7 P1：策略分散

- Approval 由关键词检测、planner 与 ControlPlane 分担。
- Recovery 分散在 DeviceManager、ControlPlane 和具体 driver。
- 确定性规则分散在 planner 与 playbooks。

这些不是当前重复实现错误，但若不在 Phase 3 收敛为统一策略接口，会形成多套互相绕过的规则。

### 3.8 P2：事件与协议扩展压力

当前 EventType 是静态枚举且映射集中在 daemon。加入 observation/scene/knowledge 事件后，需保持 versioned DTO、bounded payload 和 selected-device detail 原则；不能把截图、完整 UI tree 或候选 assets 放进 wall SSE。

## 4. Missing Capabilities

按依赖顺序，缺口是：

1. Knowledge schema：Scene、SceneVariant、Element、Skill、SkillRule、Recovery、Candidate 的版本化定义。
2. Markdown loader/validator：YAML frontmatter、正文结构、wiki links、路径安全、cross-reference 校验和 diagnostics。
3. Knowledge compiler/runtime repository：结构化持久化、原子版本切换、cache，不在每次 action 扫 Markdown。
4. OVS：UI tree/OCR/layout/visual/history/transition/app context 的分层 matcher，只有低置信度才升级 VLM。
5. Global Scene 优先级和 Scene Variant resolution。
6. Stable Element library 与 grounding result；坐标只作为本次执行结果。
7. Scene Graph 与 transition metrics。
8. 声明式 Skill/Rule Engine，以及统一 ApprovalPolicy/RecoveryPolicy。
9. Known -> Rule、Unknown -> Agent 的路由集成。
10. Knowledge Candidate 审批、merge、compile、rollback 与审计。
11. Knowledge Search 与结构化/embedding table 检索；首阶段不需要独立 Vector DB。
12. Scene Inspector、Knowledge 管理页、tile scene summary。
13. Observation replay fixture、OVS regression test、8-device learn-once/reuse integration test。
14. 知识命中率、fallback、reuse、stale 和 cost 指标。

## 5. Reusable Existing Modules

| 现有模块 | 后续复用方式 |
| --- | --- |
| `ObservationBuilder` | 扩展为 OVS 输入，不创建第二套截图/UI tree 抓取链 |
| Android/iOS `UiHierarchy` parser | 作为 deterministic selector/evidence 的第一优先级来源 |
| `AgentAction` + Zod schema | 继续作为 Rule 与 Agent 的统一动作白名单 |
| `tap_element` grounding | 演进为 stable Element ID -> selector -> temporary bounds，不重做 driver action |
| `AgentRunOrchestrator` | 在 plan 前插入 Scene/Skill route，保留逐步执行和 task-local metrics |
| deterministic planner/playbooks | 迁移为内建 Skill/Rule adapter；避免长期维护平行硬编码策略 |
| `ArtifactStore` / StepTrace | 演进为 Observation/Candidate evidence recorder；保留脱敏和 device/task 索引原则 |
| `TaskScheduler` / limiters | OVS/VLM/embedding/compile 工作沿用独立并发限制，不绕过现有 worker policy |
| `DeviceManager` / DeviceSession | 只增加轻量 current scene snapshot/ref；知识本身按 app/platform/version 共享，不能塞进 device mutable state |
| `EventStore` / SSE | 扩展 scene/knowledge 事件；仍保持 bounded、ordered 和 snapshot resync |
| `RuntimeStateStore` | 继续只负责本地设备配置；知识 durable store 使用独立 repository |
| `ControlCenterClient` | 延续 HTTP command/query + SSE event 风格添加 Knowledge API |
| Task Center approval UI | 可复用审核交互模式，但 Candidate approval 必须是独立实体和权限语义 |
| Tauri native host | 复用 open-folder/open-in-editor 能力；Obsidian 只能是可选外部编辑器 |

## 6. Proposed Architecture Changes

建议保持 ControlDaemon 为唯一 live-state owner，在其旁增加知识域服务，而不是新增微服务：

```text
ControlDaemon
  ├── existing Device/Task/Driver owners
  ├── KnowledgeSourceRepository   (Markdown + assets, read/write via reviewed operations)
  ├── KnowledgeValidator         (schema + references + diagnostics)
  ├── KnowledgeCompiler          (normalized immutable revision)
  ├── RuntimeKnowledgeRepository (SQLite first)
  ├── OVSEngine                  (deterministic-first recognition)
  ├── SkillEngine                (known scene rules)
  ├── RecoveryEngine             (bounded policy)
  └── KnowledgeCandidateService  (human-reviewed learning loop)

AgentRunOrchestrator step
  observation
    -> global scene guard
    -> OVS match
    -> SkillEngine if known
    -> AgentPlanner if unknown/no applicable rule
    -> ApprovalPolicy
    -> existing Action Engine / DeviceDriver
    -> verify + transition/metric/candidate record
```

关键约束：

- `SceneId` 稳定，variant 随 platform/version/theme/A-B/resolution 变化。
- Runtime 使用不可变 compiled revision；compile 失败时继续使用上一个有效 revision。
- Candidate 不直接写正式知识。Approve/Edit 后通过 validator 和 compiler，成功才发布新 revision。
- Knowledge 是 app/platform/version/variant 范围共享数据；当前 scene 和 observation 仍严格 device-local。
- Rule 与 Agent 统一输出 `AgentAction`，统一经过 ApprovalPolicy 和 ControlPlane，不增加旁路执行器。
- Global Scene guard 优先于业务 Skill；CAPTCHA/ACCOUNT_RISK 必须 `request_human` 或 abort，禁止自动绕过。
- AI screenshot 与 monitor video 继续分离。

## 7. Database Changes

当前没有数据库。Phase 1 建议使用进程内 SQLite repository，并保留接口以便未来替换 PostgreSQL；第一阶段不引入独立 Vector DB。

建议最小表：

| 表 | 用途 |
| --- | --- |
| `knowledge_revision` | compiled revision、source hash、schema version、status、diagnostics |
| `scene` | stable scene identity、app scope、threshold、priority |
| `scene_variant` | platform/version/theme/A-B/resolution 条件和 normalized evidence |
| `element` | stable element identity、scene relation、selectors、semantic/asset refs |
| `scene_transition` | from/action/to、success/failure、duration、last verified |
| `skill` / `skill_rule` | goal、entry/success/failure、deterministic conditions/actions |
| `recovery_policy` | trigger、bounded attempts/depth/timeout、action sequence |
| `knowledge_candidate` | status、source device/task/step、suggestion、review audit |
| `observation_record` | only valuable step references and redacted structured evidence |
| `action_record` / `recovery_record` | outcome and bounded operational audit |
| `knowledge_metric` | match/success/failure/reuse/confidence/last used/verified |

数据库不保存 live `DeviceSession` 对象，也不作为坐标广播或跨设备 mutable task context。Assets 放文件目录，数据库只保存 content-addressed ref、metadata 与 retention state。

## 8. API Changes

延续当前 `/api`、Zod、HTTP query/command、SSE event 方式，建议按 Phase 增量添加：

```text
GET  /api/knowledge/scenes
GET  /api/knowledge/scenes/:sceneId
GET  /api/knowledge/elements
GET  /api/knowledge/skills
POST /api/knowledge/search

GET  /api/knowledge/candidates
GET  /api/knowledge/candidates/:candidateId
POST /api/knowledge/candidates/:candidateId/approve
POST /api/knowledge/candidates/:candidateId/reject
POST /api/knowledge/compile

GET  /api/devices/:deviceId/scene
POST /api/devices/:deviceId/scene/correct
POST /api/devices/:deviceId/scene/candidates
GET  /api/tasks/:taskId/timeline
```

要求：

- mutation 保持 `commandId`、timestamp、幂等签名；device mutation 必须显式 `deviceId`。
- Candidate approval 需要 reviewer identity/audit metadata，不能复用 task approval 的语义对象。
- `DeviceSummaryDTO` 只增加 `sceneId/confidence/agentState/task` 等轻量字段。
- Evidence、detected elements、alternatives、previous/expected scenes 只从 selected-device scene detail 获取。
- 新事件采用 `device.observation`、`scene.changed`、`scene.unknown`、`action.executed`、`action.failed`、`knowledge.candidate_created`、`knowledge.updated`，payload 仅放 ID 和轻量摘要。

## 9. Frontend Changes

Phase 2 以后再实施：

- Device Tile：增加 current scene、confidence、agent/task state；保持固定高度和轻量 DTO。
- Device Inspector：新增 Scene section，展示 scene、variant、confidence、evidence、elements、previous/expected；提供 Correct/Teach/Save Candidate。
- Knowledge 页面：Apps/Scenes/Elements/Skills/Rules/Recovery 导航，内容、metadata、relations、variants、usage 三栏；不在前端自行解析运行时 Markdown。
- Candidate review：Approve/Edit/Reject，明确 source observation 与 compile diagnostics。
- Analytics：scene recognition、rule/OVS hit、unknown/fallback/reuse/human intervention/task success；不把 32 台 detail 数据一次加载到 wall。
- Open Folder/Open in Obsidian 通过 Tauri optional action；未安装 Obsidian 时 Knowledge 功能仍完整可用。

## 10. Risk Analysis

| 风险 | 严重度 | 控制措施 |
| --- | --- | --- |
| Markdown 任意内容进入运行时 | P0 | versioned schema、strict validator、compile quarantine、last-known-good revision |
| Agent 绕过规则/审批 | P0 | Rule/Agent 都输出同一白名单 action，并统一经过 ApprovalPolicy/ControlPlane |
| CAPTCHA/安全验证被自动处理 | P0 | global scene priority + mandatory HUMAN_REQUIRED，测试禁止绕过 |
| 跨设备 scene/action 状态污染 | P0 | observation/current scene/task context device-local；共享知识 immutable |
| 一次知识更新破坏所有设备 | P0 | revisioned atomic publish、rollback、canary/replay validation |
| 所有 scene 都调用 VLM 导致成本失控 | P1 | deterministic evidence cascade、threshold、cache、fallback metrics |
| Scene variant 爆炸 | P1 | stable scene ID、constraint-based variant、evidence inheritance、usage cleanup |
| ControlPlane 继续膨胀 | P1 | OVS/Skill/Knowledge 以接口和 repository 分离，ControlPlane 只 orchestrate/action-own |
| SQLite 与 live runtime 混为一体 | P1 | durable record 和 DeviceSession ownership 明确分离 |
| artifacts 泄露截图/账号信息 | P1 | opt-in valuable observations、redaction/encryption/retention、metadata by default |
| 文档再次落后代码 | P2 | capability matrix + phase acceptance tests 同步更新 |
| 真机规模被模拟测试替代 | P2 | 报告明确 simulated/real，8 台授权设备后才声明硬件规模验收 |

## 11. P0 / P1 / P2 TODO

### P0

- Phase 1：定义 Knowledge schema/version、目录约束和全局安全 scene 基线。
- 实现 Markdown loader、validator、reference diagnostics 与 last-known-good compiler。
- 建立 SQLite runtime repository 和 migration；不引入 Vector DB。
- 为 validator/compiler 增加非法输入、重复 ID、broken link、path traversal、atomic publish 测试。
- 明确统一 ApprovalPolicy，保证 CAPTCHA/ACCOUNT_RISK 不可被 Agent 绕过。

### P1

- Phase 2：OVS deterministic matcher、variant、global scene priority、Element library、replay fixtures。
- 扩展 ObservationBuilder 输入，但保持截图触发式和 device-local。
- DeviceSummary/Detail、SSE 和 Scene Inspector 增量接入。
- Phase 3：把 playbooks/deterministic rules 迁入 Skill Engine，建立 Scene Graph 和 bounded RecoveryEngine。
- Phase 4/5：Known -> Rule、Unknown -> Agent、Candidate review/compile/reuse。
- 持久化有价值 observations 与知识指标，并落实 retention/redaction。

### P2

- Knowledge 管理与 analytics UI 完整化。
- embedding table 相似搜索；数据规模证明有必要后再评估 pgvector/Qdrant/Milvus。
- 8-device learn-once/reuse simulation、故障注入和性能基线。
- 8 台授权真机 Android/iOS 混合规模验收、Windows desktop 打包与升级验证。
- 知识 stale/need-review 自动标记和 revision canary rollout。

## 12. Files To Modify

以下是后续 Phase 的建议增量文件，不是本审计已修改的运行代码。

### Phase 1 — Knowledge Foundation

```text
package.json                              # 仅添加经过选择的 YAML/Markdown/SQLite 依赖
knowledge/                                # Obsidian-compatible source tree
src/knowledge/schema.ts                   # versioned Zod schemas
src/knowledge/markdownLoader.ts           # frontmatter/body/wiki-link loader
src/knowledge/validator.ts                # schema/reference/path diagnostics
src/knowledge/compiler.ts                 # normalize + atomic compiled revision
src/knowledge/repository.ts               # repository contracts
src/knowledge/sqliteKnowledgeRepository.ts
src/knowledge/migrations/*
src/knowledge/*.test.ts
tests/fixtures/knowledge/*
src/server/controlDaemon.ts               # compose services only
src/server/protocol.ts                    # knowledge DTO/command schemas
docs/knowledge-schema.md
README.md
docs/detailed-design.md
```

### Phase 2 — OVS

```text
src/domain/observationBuilder.ts          # add app/version/OCR/previous-scene evidence
src/ovs/types.ts
src/ovs/engine.ts
src/ovs/matchers/*
src/ovs/globalSceneGuard.ts
src/ovs/sceneGraph.ts
src/ovs/*.test.ts
tests/fixtures/scenes/*
src/domain/types.ts                       # lightweight current scene state
src/server/protocol.ts
src/server/controlDaemon.ts
src/components/DeviceTile.tsx
src/components/DeviceInspector.tsx
src/app/controlCenterClient.ts
src/app/useControlCenter.ts
src/styles.css
```

### Phase 3–5 — Skill, Agent Integration, Learning Loop

```text
src/skills/skillEngine.ts
src/skills/ruleEngine.ts
src/skills/recoveryEngine.ts
src/skills/approvalPolicy.ts
src/domain/agentRunOrchestrator.ts         # route known/unknown; keep action owner unchanged
src/domain/agentPlanner.ts                 # fallback adapter, not default known-scene path
src/domain/playbooks/*                     # migrate/adapt existing deterministic playbooks
src/knowledge/candidateService.ts
src/knowledge/searchService.ts
src/server/protocol.ts
src/server/controlDaemon.ts
src/components/KnowledgeCenter.tsx
src/components/KnowledgeCandidateReview.tsx
src/App.tsx
src/styles.css
```

## Audit Conclusion

OmniDeck 当前不是空壳：多设备会话、daemon ownership、调度隔离、Android/iOS driver boundary、逐步 Agent、审批、人工接管、审计和 monitor/task UI 已形成可运行基础，并通过当前自动验证。新增方向不应重写这些模块。

最重要的缺口是知识与场景层完全缺失。下一步应严格从 Phase 1 开始，先交付可验证、可编译、可回滚的 Knowledge Foundation；在获得确认前，不应直接开发 OVS、Scene UI 或 Learning Loop。
