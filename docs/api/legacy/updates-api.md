# 版本更新与关于页

打包：`scripts/package-windows.ps1 -UpdatePackage -PackageVersion <semver> -VelopackSdkDir <temporary-sdk> -VelopackToolsDir <temporary-tools>`。原有 Flutter、Node、Python/uv、rg/fd、沙箱镜像均保留；SDK/vpk/.NET 只属于临时构建工具，不随应用分发。生成 Velopack 可更新免安装 ZIP、完整 nupkg；本任务不发布或上传。可更新包从根目录 `DreamFlutter.exe` 启动，`current/` 可替换，`data/` 位于根目录（或显式数据路径）。普通开发构建无需 SDK。

正式检查固定为公开仓库 `jun64349/DreamFlutter` 的 `releases/latest`，不带凭据；按 `DreamFlutter-<version>-<platform>-<arch>-full.nupkg` 精确选择。只有本机命令行 `--update-test-source http://127.0.0.1:<port>` 或开发环境 `DREAMFLUTTER_UPDATE_TEST_SOURCE` 可以指定同源 loopback 测试源；设置界面和 RPC 不接收源地址。自动检查默认开启，每24小时最多一次，缓存结果；界面读取状态不会触发网络，不收集使用数据。

| RPC | 输入 / 行为 |
| --- | --- |
| `updates.status` | 版本/构建、后台/Pi、平台架构、更新状态、下载进度、备份和恢复阶段；不联网 |
| `updates.check` | 手动检查最新发布，区分 current/no_release/offline/rate_limited/no_asset/invalid_version 等 |
| `updates.download` | 下载已选附件；校验大小和 SHA-256，失败删除临时文件；返回签名状态 |
| `updates.install` | `windowPid`、`approveUnsigned`、`prefs`；后台准备、等待在途任务、窗口正常退出、一致性备份、守护进程更新 |
| `updates.cancel` | 取消检查/下载/安装前准备；开始程序替换后拒绝取消 |
| `updates.uiReady` | 私有 nonce、版本、真实窗口 PID；只供首次启动首帧验证 |
| `updates.validateReady` | 私有 nonce；核对窗口握手、SQLite 完整性/外键及数据库/配置/会话路径 |
| `updates.diagnostics` | 返回本地 ZIP 路径；日志和设置摘要调用既有 T-63 脱敏，不上传 |
| `updates.licenses` / `updates.licenseText` | 生成的实际依赖清单；文本只接受清单条目 `id`，不接受任意路径 |
| `app.exitState` | 在途对话和记忆工作的忙状态 |
| `app.setStartup` | `enabled`；仅当前用户 Run 启动项，不覆盖/删除其他安装的同名项 |

设置新增 `autoCheckUpdates=true`、`startOnLogin=false`、`closeBehavior=tray|quit`（默认 tray）。选择退出且有在途任务时先确认。反馈仅打开 GitHub Issues 新建页并预填版本/平台，诊断由用户自行分享。许可证由打包时的真实依赖、SDK 和上游对应版本声明生成。

下载签名是 `<nupkg>.signature.json`，结构 `{algorithm:"RSA-SHA256",certificate:"PEM X509",signature:"base64"}`，签名内容是小写 SHA-256 的 ASCII 字节。临时测试证书仅在显式开发测试源下按命令行指纹信任；不导入证书存储。正式证书本版未购买。缺失/不受信任签名要求明确确认，密码学签名错误直接阻止；关于页显示“测试版未签名”。

阶段记录位于数据根 `updates/journal.json`，原生守护进程、已校验新旧包和本地 feed 位于私有 `updates/runs/<id>`，不在可替换程序目录。所有程序替换与降级由 Velopack 执行，不自行覆盖程序文件。准备阶段停止新任务，等待已有写入者结束，再关闭窗口、创建/读取验证既有备份（含 SQLite WAL 一致性快照）。SDK启动异步Update.exe后，守护进程只读等待本安装的替换进程退出，才启动独立后台与窗口；不能仅根据提前写出的版本文件判定替换完成。新程序只显示启动验证页，验证窗口首帧、后台、数据库和路径后才开放用户写入。

新版本失败且尚未接受用户写入：用保留的旧 nupkg 离线回滚，再复用既有 stageBackup/applyPendingRestore 恢复更新前备份。恢复切换中断可以重入；守护进程在替换/验证阶段被杀后，下次启动只重启一个守护进程。已经接受写入时永久禁止自动恢复旧备份。无法安全恢复时保留现场和备份，记录 manual-recovery，不循环覆盖。验证完成后再清理旧程序缓存/临时守护目录，备份按原有保留规则处理，保留紧凑阶段和守护日志。

本机完整测试夹具见 `scripts/t67-velopack-probe/product-pack.ps1`、`product-live.mjs`；不访问用户测试版目录，不运行模型、不创建 Release、不上传。
