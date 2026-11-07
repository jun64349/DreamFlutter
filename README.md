# DreamFlutter

当前最新为 [v0.6.0 源码里程碑](docs/releases/v0.6.0.md)：v0.6 功能和隔离验证已完成；正式安装包等 V1.0 发布，部分需要真实账号或亲自操作的测试延后到正式版前。接手先读 [HANDOFF](docs/HANDOFF.md)、[开发规范](docs/dev-guide.md)、[V1.0 收敛说明](docs/v1.0-convergence.md) 和 [roadmap](docs/roadmap.md)。

## 当前入口与运行方式

Flutter 窗口通过本地 WebSocket 连接 Node 后台，后台在进程内托管多个 Pi 会话。工作台工具在 Windows 执行，蝶君工具通过 WSL 沙箱执行。数据默认集中在软件根目录的 `data/`。生产路径不再是「每会话启动一个 Pi 子进程」。

- `core/`：后台、记忆、上下文、任务、网关、沙箱和备份；入口 `src/main.ts`、装配 `src/app.ts`。
- `app/`：Flutter Windows 窗口；`packages/pi_rpc/`：当前 Core/Slot 通道、消息折叠及旧 RPC 支持。
- `packages/desktop_drop/`：带 Windows 拖图修补的插件。
- `runtime/`：旧 RPC 冒烟与 fixtures 仍有测试用途。分发包里的 `runtime/node.exe` 则是后台所需的 Node。
- `scripts/package-windows.ps1`：打包至 `dist/DreamFlutter`，随附 Node、搜索工具、便携 Python、离线沙箱镜像。所需资产的准备方式见脚本。

在仓库根目录的 PowerShell 中执行：

```powershell
cd core
npm ci
npm test
npm run typecheck
cd ../app
flutter pub get
flutter test test
flutter analyze
flutter run -d windows
```

协议层：进入 `packages/pi_rpc`，先 `dart pub get`，再 `dart test -x integration`。真实窗口及发布验证见 [testing/scenarios.md](docs/testing/scenarios.md)。SDK 和依赖版本以包清单、lock 文件为准。

本轮候选变更见 [审查记录](docs/REVIEW-2026-11-06.md)，未经 Claude/用户复核不替换正在使用的测试版。

## 历史说明：V0.1.0（以下原文保留，不代表当前架构）

基于 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 原生运行时的个人 AI Agent 桌面客户端（Flutter Desktop + `pi --mode rpc`）。设计说明见 [docs/architecture.md](docs/architecture.md)。

## 功能

- 流式对话：思考过程、工具调用卡片、停止、运行中插话、图片输入
- 多会话并行：运行中新建或切换会话，原会话在后台继续跑
- 会话管理：历史列表、恢复、从某条消息分叉、复制、重命名、删除（回收站）
- 工作区：切换、最近使用列表、工作区项目配置的信任确认
- 安全：工具调用审批（全部放行 / 修改和命令需确认 / 全部需确认）
- 上下文：占用详情、手动压缩、自动压缩开关
- Skills 与命令：面板浏览，输入框里 `/` 自动补全
- 设置：默认模型与思考级别、Pi 配置重新加载、主题、文字大小、运行环境诊断

## 目录

| 目录 | 内容 |
|---|---|
| `app/` | Flutter Windows 应用 |
| `packages/pi_rpc/` | Pi RPC 协议的 Dart 客户端（纯 Dart，可单独测试） |
| `runtime/` | 锁定版本的 Pi 运行时、审批扩展、冒烟脚本和录制的协议样例 |
| `docs/` | 架构与设计文档 |

## 环境要求

- Node.js ≥ 22.19（Pi 的要求）
- Flutter 3.47+，Visual Studio 2022 生成工具（C++ 桌面工作负载）
- Windows 开启「开发人员模式」（Flutter 插件需要符号链接）
- 已在 `~/.pi/agent/models.json` 或 `auth.json` 里配置好模型凭证

## 常用命令

```bash
# 安装锁定版本的 Pi
cd runtime && npm install

# 协议冒烟 / 审批扩展冒烟（后者会调用一次模型）
npm run smoke
node scripts/approval-smoke.mjs --model cc-switch-deep-seek/deepseek-flash

# 协议层单元测试 / 连接真实 Pi 的集成测试
cd packages/pi_rpc && dart test -x integration
PI_RPC_LIVE_MODEL=cc-switch-deep-seek/deepseek-flash dart test -t integration

# 应用测试 / 端到端验收（会打开真实窗口，别最小化它）/ 运行 / 构建
cd app && flutter test test
flutter test integration_test/e2e_test.dart -d windows
flutter run -d windows
flutter build windows --release
```

应用启动时从可执行文件所在目录和当前目录向上查找 `runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，也可以用环境变量 `DREAMFLUTTER_PI_CLI` 指定。
