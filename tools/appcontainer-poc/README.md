# 蝶君 Windows 原生工作区验证

本机验证结果见 [2026-11-20 实测回执](results.md)。

用普通权限在 Windows 10 或 11 的 x64 PowerShell 中运行。脚本使用本机已有的 Visual Studio C++ Build Tools 和 Windows SDK 编译 Win32 探针。Windows 的 AppContainer 启动接口见 [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。

```powershell
Set-Location E:\claude\DreamFlutter-2.0
.\tools\appcontainer-poc\run.ps1
```

带上 Windows 包的根目录，可以同时验证原包中的 Node.js、Python、uv、rg、fd、MinGit 和现有办公样本。

```powershell
Set-Location E:\claude\DreamFlutter-2.0
.\tools\appcontainer-poc\run.ps1 -PackageRoot 'E:\claude\DreamFlutter\dist\v1.0.0-preview.2\v1.0.0-preview.2\DreamFlutter'
```

加上 `-ProfileDataControl`，只复跑原生探针和两项路径兼容性测试。分别在系统临时目录、由 `GetAppContainerFolderPath` 返回的本次 profile 自带数据目录中测试随包 Node.js 和 MinGit。

如需复跑 E 盘短路径对照，可在单独启动的 PowerShell 进程内把 `TEMP` 和 `TMP` 都设为 `E:\`，再执行带 `-ProfileDataControl` 的命令。该进程退出后恢复常规临时目录。

每次运行在系统临时目录中新建带随机标识的目录和同名 AppContainer profile。探针只在新建目录中设置权限，随包程序在临时副本中执行。正常清理完成时输出 `profile_delete_hresult=0` 和 `fixture_removed=1`。附带工具的 stderr/stdout 收在各自的临时日志中，失败时输出开头最多 4 KiB。可用 `-VsInstallPath` 指定本机已有的 Build Tools 路径。

| 检查 | 通过条件 |
| --- | --- |
| AppContainer 身份 | `TokenIsAppContainer=1`，令牌的 profile SID 匹配，capability 数量为 0。 |
| 私有目录 | Win32 进程创建合成文件、读回一致内容并删除。 |
| 同级目录 | 宿主可打开合成文件读写，容器打开同一文件读或写均返回 Win32 5。 |
| 工具目录 | 容器可读合成文件和启动工具，写打开返回 Win32 5。 |
| IPv4 本机环回 | 宿主在容器尝试前后都能连接本次临时 `127.0.0.1` 监听端口。容器连接返回拒绝或超时，监听端没有收到容器连接。 |
| 回收子进程 | 父进程和子进程均处于存活状态，子进程属于该 Job，关闭唯一 Job 句柄后两个进程句柄均收到退出信号。 |
| 随包工具 | Node.js、Python 写入私有目录。Node.js 取得样本的原生真实路径。uv 离线创建 venv。rg 和 fd 在私有目录内查找样本。MinGit 初始化新仓库。办公脚本在私有目录下生成并检查各格式文件。 |

结果仅覆盖当前 Windows 机器、明确列出的合成目录、测试端口和工具操作。系统默认授予普通 AppContainer 的共享资源仍可能可读，见 [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。公网及局域网、联网能力切换、安装和卸载、跨 Windows 版本以及实际蝶君调用都需要另行验证。子进程测试覆盖 Job 正常持有后关闭句柄的情况，进程创建与加入 Job 之间的异常退出另待验证。
