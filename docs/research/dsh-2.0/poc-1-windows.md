# POC-1 · Windows 上的 DSH 底座

2026-11-20，2.0 从含 Windows 和 macOS 预览实现的 `11d6a4d` 建立独立工作树。这个验证回答一个问题：DreamFlutter 能否用官方 DSH 启动会话，退出后台后恢复同一段对话。入口在 [独立测试工程](../../../tools/dsh-poc/package.json)，不会随 1.0 后台加载。

## 核对的上游版本

| 对象 | 本轮依据 |
| --- | --- |
| DeepSeek Harness | 拉取官方 `master` 的 [2e39e70](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e)。CLI 要求 Node ≥24.9。官方 SDK 和 CLI 需要同版。[源码启动逻辑](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/sdk/client/src/launch.ts) |
| npm 验证版本 | 测试工程固定 `@deepseek-ai/dsh-sdk-client@0.2.2-rc.5`，它依赖同版 CLI，启动官方 `sdk-minimal`。这个版本的[发布标签](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb)与上行 master 是不同提交，npm 包元数据没有提供 `gitHead`。[发布包元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh-sdk-client/0.2.2-rc.5) |
| SuperAgent | 拉取官方 `main` 的 [8c32a9d](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。它从源码构建，部署说明选用 DSH `0.2.1-rc.3`。本轮只核对源码与版本，接入新底座仍须另行验证。[上游部署说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md) |

## 实测方法

1. 在临时目录启动官方 `sdk-minimal`。工作区路径包含中文和空格。子进程使用独立的数据目录与用户目录。用只监听本机回环地址的测试端点返回两段约定的中文，传入的 API 密钥也是测试值。
2. 从 SDK 发送第一轮消息，核对回复，关闭后台。直接解析官方会话目录下的 JSONL，检查第一轮用户消息已写入磁盘。
3. 启动第二个后台，按会话 ID 恢复并发第二条消息。检查模型端点实际收到首轮的用户原文、助手原文以及第二轮输入。关闭后检查日志保留原有记录并追加第二轮。

脚本只替换模型端点，SDK、Cordis 插件组合、会话存储与恢复均使用上游实现。[验收脚本](../../../tools/dsh-poc/session.test.mjs)

## 验证结果

- Windows x64，Node 24.21.0，DSH SDK 与 CLI 均为 `0.2.2-rc.5`，Cordis `4.1.0`。两个独立后台完成两轮对话，总共两次回环模型请求。第一轮关闭后 JSONL 共 15 行，第二轮关闭后共 26 行，前 15 行解析出的记录全部一致。恢复后的请求同时包含第一轮提问与回答。
- 从锁文件重新安装 606 个依赖后，用 Node 24.22.3 复跑，同一测试通过，回环请求数和两次落盘行数均一致。606 是独立验证工程的安装数，应用发版时需要的依赖与包体尚待单独评估。
- 另在本机已安装的 DSH 桌面版 `0.2.2-rc.3` 运行了较低层的验证。完整 `sdk-minimal` 组合在一个进程里直接写入合成消息，再在另一个进程中从官方会话存储读回原文。两个进程都正常退出。
- 这些结果覆盖 Windows 上的 DSH 原生会话。1.0 的 Pi 历史会话迁移、DreamFlutter 前端协议兼容、macOS 上的 DSH 运行和真实渠道调用仍待后续验证。

按原调研顺序，下一项是 POC-2：用本地测试渠道接入 DreamFlutter 的模型路由和 Ledger，检查调用前能否拦住超预算请求，以及调用后能否按用量正确记账。

## 本机复跑

本机默认的 Node 为 22。以下 PowerShell 命令显式使用本机 DSH 随附的 Node 24，不需要更改系统 PATH。其他机器使用符合版本要求的 Node 和 npm，可以直接在此目录运行 `npm ci --ignore-scripts` 和 `node --test session.test.mjs`。要同时运行会话与模型预算验证，请使用 [POC-2 的复跑命令](poc-2-model.md)。

```powershell
cd E:\claude\DreamFlutter-2.0\tools\dsh-poc
$pocNode = 'E:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$npmCli = Join-Path (Split-Path (Get-Command npm.cmd).Source) 'node_modules\npm\bin\npm-cli.js'
& $pocNode $npmCli ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -eq 0) { & $pocNode --test session.test.mjs }
```

两次 SDK 测试创建的临时会话目录均已清理。工具的自动审查拦下了最后的批量递归清理，本机暂留 `tools/dsh-poc/node_modules`（743.9 MiB，可直接复跑测试）与 `E:\claude\df2-poc1-upstream`（15.7 MiB，含两份上游检出和 SDK 源包，可核对上述版本）。前者由 Git 忽略，后者在工作树外。
