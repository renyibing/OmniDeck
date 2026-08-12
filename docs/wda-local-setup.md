# 本地 WDA 环境说明

本文档记录 OmniDeck 在本机的 iOS WebDriverAgent 启动方式，用于恢复 iPhone 投屏与操控能力。

## 前提条件

- Xcode 已安装且命令行工具可用。
- 本机已安装 `appium` 与 `iproxy`。
- `~/.appium/node_modules/appium-xcuitest-driver` 已存在。
- 本机 Apple 开发证书与开发型 provisioning profile 可用于目标 iPhone。
- 目标 iPhone 已开启开发者模式，并完成 USB 信任。

## 已验证的本机事实

- 2026-08-12 已验证两台 iPhone 可成功启动 WDA 并返回 `/status`。
- 当前项目使用 Appium 自带 WDA 工程：
  `~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj`
- 本地端口推荐：
  - 第一台 iPhone 使用 `8100`
  - 第二台 iPhone 使用 `8101`

## 启动单台设备

先用下面命令确认 UDID：

```bash
xcrun xcdevice list | rg -n '"platform" : "com.apple.platform.iphoneos"|identifier|name'
```

启动命令：

```bash
./scripts/start-wda-device.sh \
  --udid <iphone-udid> \
  --local-port 8100 \
  --bundle-id com.omnideck.WebDriverAgentRunner.device1
```

如果第二台设备要并行运行，改成另一个端口和 bundle id：

```bash
./scripts/start-wda-device.sh \
  --udid <iphone-udid> \
  --local-port 8101 \
  --bundle-id com.omnideck.WebDriverAgentRunner.device2
```

成功后会返回：

```json
{
  "value": {
    "ready": true,
    "message": "WebDriverAgent is ready to accept commands"
  }
}
```

## 停止单台设备

```bash
./scripts/stop-wda-device.sh --udid <iphone-udid> --local-port 8100
```

## OmniDeck 配置方式

在 OmniDeck 的 iOS 设备配置面板中：

- `Driver mode` 选择 `IOS_XCUITEST`
- `Identifier` 填设备 UDID
- `WDA URL` 填本地地址
  - 第一台 iPhone: `http://127.0.0.1:8100`
  - 第二台 iPhone: `http://127.0.0.1:8101`

保存后执行 `Connect`。如果 `WDA URL` 可访问，状态会进入 `CONNECTED`。

## 常见问题

- `fetch failed`
  - 通常表示本地 `WDA URL` 没有服务监听。先执行 `curl http://127.0.0.1:8100/status`。
- `No signing certificate` 或 `No profiles`
  - 说明 Xcode 本地签名链不完整，先检查开发证书、profile、目标设备 UDID 是否包含在开发 profile 中。
- `Connection reset by peer`
  - 常见于 WDA 刚完成安装、Runner 尚未完全启动时，重试几秒通常可恢复。
- 页面显示 `disconnect`
  - 先看 `curl http://127.0.0.1:<port>/status` 是否返回 `ready: true`，再检查 OmniDeck 中该设备的 `identifier` 与 `WDA URL` 是否一一对应。
