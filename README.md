# DreamFlutter v0.1.0

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
