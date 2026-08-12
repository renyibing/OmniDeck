# OmniDeck 需求分析文档

更新时间：2026-08-12
文档定位：基于产品需求与当前仓库实现状态整理的需求分析文档

## 1. 产品定义

### 1.1 产品名称

OmniDeck

### 1.2 产品定位

AI 多设备智能控制平台

### 1.3 目标平台

- 桌面平台：macOS / Windows
- 设备平台：Android / iOS

### 1.4 核心形态

OmniDeck 的目标不是单纯的 scrcpy GUI，也不是传统手机群控软件，而是统一的：

- 多设备监控墙
- Device Manager
- AI Agent
- 自动化执行
- 人工接管

长期方向是演进为统一的 `AI Device Agent Platform`。

## 2. 问题陈述

OmniDeck 要解决的不是“把手机画面显示出来”，而是多设备、AI、人工协作三者同时成立的问题：

- 多台真实 Android/iPhone 需要在同一个控制中心中稳定接入与查看。
- AI 任务必须基于每台设备当前真实 UI 状态独立决策，而不是依赖固定脚本坐标。
- 人工与 AI 需要能够在同一台设备上无缝切换控制权。
- 设备数量从 MVP 的 8 台逐步扩展到 16/32 台后，系统仍需可运行、可调度、可追踪。

## 3. 产品目标

### 3.1 多设备统一管理

用户应能在一台工作站上统一管理：

- Android 真机
- iPhone 真机
- 后续云手机
- 后续远程 Device Node

第一阶段目标规模：

- 8 台
- 16 台
- 32 台

### 3.2 多设备实时监控

系统应提供类似安防监控的 Device Wall，支持：

- 1 宫格
- 4 宫格
- 8 宫格
- 9 宫格
- 16 宫格
- 25 宫格
- 32 宫格

### 3.3 AI 自动操作

AI 应能围绕真实设备状态完成：

`观察 -> 理解 -> 决策 -> 操作 -> 验证`

并支持根据自然语言目标生成下一步动作，而不是一次性输出长链固定步骤。

### 3.4 Human-in-the-loop

用户应能在任意时刻执行：

`AI 运行 -> Pause -> Take Over -> 人工操作 -> Resume AI`

恢复后 Agent 必须基于人工操作后的真实页面重新观察并继续。

## 4. 当前阶段与范围

### 4.1 已纳入本阶段范围

- 多设备监控墙
- 稳定设备会话
- 批量任务独立展开
- 多设备 worker pool 与资源限制
- 人工接管与恢复
- 真机预览
- 预览点击操控
- Android/iOS 驱动抽象
- Device Group / Workspace
- Health Monitor 基础能力

### 4.2 暂未纳入本阶段范围

- WebRTC/MSE 真正实时视频网关
- 复杂 Workflow/RPA 设计器
- 组织权限与商业化计费
- 1000+ 设备调度
- Agent Marketplace / Skills Marketplace

## 5. 用户角色与典型场景

### 5.1 用户角色

- 运营人员：观察多台设备运行、查看任务进度、进行敏感动作确认。
- 测试人员：批量执行设备任务、分析异常、人工接管设备排查问题。
- 管理员：配置设备、管理真机接入、观察健康状态与 AI 成本。

### 5.2 典型场景

- 选择 4 台设备并批量检查登录状态。
- 打开单台设备全屏监控并进行人工点击接管。
- 设备掉线后恢复连接并继续原任务。
- 在发布评论、发送私信等敏感动作前等待人工确认。
- 用自定义 Group 和 Workspace 快速切换关注设备集合。

## 6. 功能性需求

### 6.1 Device Manager

系统应统一管理设备状态与元数据，包括但不限于：

- Device ID
- Device Name
- Platform
- Current App
- Agent Status
- Current Task
- Battery
- Temperature
- Network
- FPS
- Latency

系统中的设备状态至少应覆盖：

- ONLINE
- OFFLINE
- IDLE
- RUNNING
- PAUSED
- HUMAN_CONTROL
- ERROR
- DEGRADED

### 6.2 Device Wall

Device Wall 是产品核心界面，要求：

- 支持 1/4/8/9/16/25/32 布局
- 32 路采用 8x4 或自适应 grid
- tile 仅渲染轻量摘要
- 单击选中设备并加载 inspector
- 双击进入 fullscreen
- ESC 返回原设备墙

### 6.3 Device Inspector

选中设备后，应在 inspector 中展示：

- Live View
- Device Control
- Agent 操作
- Timeline
- Device Information

### 6.4 设备驱动抽象

系统应通过统一 `DeviceDriver` 抽象屏蔽 Android/iOS 差异，避免在 Agent 层大量出现平台分支。

驱动能力应覆盖：

- connect / disconnect
- screenshot
- get UI hierarchy
- tap / swipe / long press / input text
- back / home
- launch app / stop app
- get device info / screen size

说明：

- 当前仓库已实现 screenshot、tap、launch/restart app、health、preview frame 等核心子集。
- swipe、input text、long press 等为后续扩展项。

### 6.5 AI Agent

AI Agent 需遵循：

- Goal + Current State -> Next Best Action
- 每执行一步都重新观察真实设备状态
- 优先使用 UI Tree 定位，其次使用 GUI grounding，再次才使用 VLM 坐标猜测

允许动作必须白名单化，至少包括：

- tap
- tap_element
- long_press
- swipe
- input_text
- back
- home
- launch_app
- wait
- request_human
- finish

### 6.6 Batch Task

当用户选择多个设备执行同一目标时，系统必须：

- 创建独立的 `TaskInstance`
- 每台设备独立维护 observation、action、state、result
- 严禁将同一坐标广播给全部设备作为 AI 自动化手段

### 6.7 Human Approval

对于敏感动作，系统应支持人工确认流程。典型动作包括：

- 发布评论
- 发送私信
- 点赞
- 关注
- 发布内容
- 删除
- 上传
- 下单
- 支付
- 修改账号资料

### 6.8 Human Takeover

系统应支持：

- Pause AI
- Take Over
- 人工操作
- Resume AI

恢复时要求：

- 重新截图
- 重新读取 UI Hierarchy
- 废弃旧上下文
- 从当前真实页面继续

### 6.9 Device Group

系统应支持：

- Android 组
- iPhone 组
- 测试设备组
- 业务设备组
- 自定义组

### 6.10 Workspace

系统应支持保存工作空间，至少持久化：

- Device Group
- Layout
- Tile 顺序
- Inspector 状态
- Stream 配置

### 6.11 Task Center

系统应有任务中心视图，展示：

- Running
- Waiting
- Completed
- Failed
- Paused

并查看：

- Task Name
- Target Devices
- Progress
- Success / Failed
- Duration
- AI Cost

### 6.12 Agent Timeline

系统应对单步 AI 行为进行可追踪记录，包括：

- Observation
- Decision
- Target
- Confidence
- Action
- Result
- Duration

理想情况下可进一步展开：

- Before Screenshot
- After Screenshot
- UI Tree
- Grounding
- Model Response
- Action
- Result
- Latency
- Token
- Cost

## 7. 平台需求

### 7.1 Android

第一阶段 Android 建议采用：

- ADB
- scrcpy
- UIAutomator

职责划分：

- scrcpy：实时画面、人工观察、人工接管
- ADB：tap / swipe / input / app control / screenshot / 设备状态
- UIAutomator：UI hierarchy 与 element 信息

当前仓库已实现：

- 显式 `adb -s <serial>` 作用域
- screenshot
- tap
- launch/restart app
- 可选 scrcpy 进程监督

### 7.2 iOS

iOS 第一阶段采用统一驱动抽象，建议基于：

- WebDriverAgent
- XCUITest
- Screen Capture

当前仓库已实现：

- 设备级 WDA URL 绑定
- screenshot
- monitor frame
- tap
- launch/restart app
- health check

## 8. 性能与可扩展需求

### 8.1 流策略

32 台设备下不能全部使用高帧率高分辨率流。

建议分层：

- Fullscreen：1080P / 30-60 FPS
- Selected：720P/1080P / 30 FPS
- 4 Wall：720P / 20-30 FPS
- 8 Wall：720P / 10-20 FPS
- 16 Wall：480P / 5-10 FPS
- 32 Wall：360P/480P / 3-5 FPS
- Background：Screenshot/Event / 0-1 FPS

AI 截图与监控流必须分离。

### 8.2 Worker Pool

32 台在线不意味着 32 个模型同时运行。

系统应支持：

- Agent Worker Pool
- VLM 并发限制
- 任务排队

当前仓库默认配置体现为：

- `maxConcurrentAI = 8`
- `maxConcurrentVLM = 4`

### 8.3 Health Monitor

系统应持续检测：

- Device connection
- ADB / WDA
- Screen stream
- App status
- Agent
- Battery
- Temperature
- Network

## 9. 安全与审计需求

系统必须记录：

- Who
- When
- Device
- Agent
- Action
- Result

高风险动作必须具备独立审计记录。

此外：

- AI 不得拥有无限制 Shell 权限
- API Key 不允许硬编码
- 单设备故障不得影响其他设备

## 10. 非功能性需求

### 10.1 稳定性

- 单设备异常不得影响其他设备
- 掉线设备要可恢复

### 10.2 性能

- 32 路监控墙不能因 timeline / UI tree 等重组件明显卡顿

### 10.3 可恢复性

- Device / WDA / ADB / Stream 异常后可检测并尝试恢复

### 10.4 扩展性

- 架构不能被 32 台规模锁死
- 后续应能演进到 Device Node 模式

### 10.5 可观测性

- 每个 AI Action 必须可追踪、可复现

## 11. 路线规划

### 11.1 P0

优先完成：

- Android device discovery
- Device Manager
- screenshot
- UIAutomator
- tap / swipe / input text
- app launch
- scrcpy
- 1/4/8 布局
- Agent loop
- VLM + planner + action + verify
- timeline
- human approval
- human takeover

目标：

- 8 台 Android 真机稳定运行

### 11.2 P1

增强：

- 16/32 Device Wall
- Worker Pool
- Task Queue
- Batch Task
- Device Group
- Workspace
- Health Monitor
- AI Cost
- Stream Optimization

目标：

- 32 台设备稳定在线

### 11.3 P2

增加 iOS：

- device discovery
- environment / pairing / WDA
- XCUITest
- iOS driver
- iOS health monitor

目标：

- Android + iOS 混合设备墙

### 11.4 P3

演进到 Device Node：

- Central Console
- Node A / B / C
- 16+16+16 设备分布接入

## 12. 核心指标

研发阶段应重点关注：

- Device Online Rate
- Task Success Rate
- Action Success Rate
- Recovery Rate
- Average Task Duration
- Human Intervention Rate
- AI Cost / Task
- VLM Calls / Task

## 13. 当前实现对照结论

截至 2026-08-12，当前仓库与上述需求的对应关系如下：

### 13.1 已有基础能力

- 多设备稳定 `DeviceSession`
- 1/4/8/9/16/25/32 布局
- Stream 分级策略
- BatchTask 独立展开
- AI worker / VLM / ADB / iOS 独立资源限制
- Human takeover / release
- 基于预览点击的单设备人工操控
- Android + iOS 混合真机绑定
- Device Group / Workspace 基础支持

### 13.2 尚未完整落地

- 真正实时视频网关
- UIAutomator / UI hierarchy 全链路
- Swipe / input text / long press 等完整人工动作集
- Human Approval 完整策略中心
- AI Provider 与 AI Cost 管理面
- Task Center 独立主界面
- Device Node 分布式模式

## 14. MVP 验收口径

从产品角度，V1 MVP 不应仅以“页面完成”或“AI 接口接通”为验收标准，而应至少验证：

- 至少 8 台 Android 同时连接
- 8 宫格持续稳定运行
- 多台设备能独立执行 Agent Task
- 单任务连续执行 10 个动态 UI Action
- UI 状态变化后 Agent 能重新判断
- 支持稳定文本输入
- Action 后可验证结果
- 错误后具备恢复能力
- 敏感动作可等待人工确认
- 用户接管后 Agent 能继续

说明：

- 当前仓库在代码与模拟验收层面已具备较强基础。
- 但根据该产品标准，尚不能声明 `V1 MVP Ready`，因为真实 8 台 Android 闭环验收尚未完成。
