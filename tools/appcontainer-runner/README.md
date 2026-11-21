# Windows 蝶君工作区运行器

Windows 包将 `appcontainer-runner.exe` 放在 `core/bin`。运行器由 Windows SDK 编译，第一次建立工作区时，Core 把受信包中的 Node.js、便携 Python、uv、rg、fd 和 MinGit 布置到独立的只读工具目录。包来源标识改变时，Core 在提供工作区前先布置新副本，再替换旧副本。工作文件和 AppContainer profile 继续使用原来的位置和 ID。

默认使用标准工作区。遇到随包 Git 无法建库时，可在「蝶君沙箱」确认启用 Git 兼容工作区。新私有目录直接建在同一磁盘根下，程序先复制工作文件并测试随包 Git，再切换。原文件留在磁盘上。兼容目录与安装路径的归属记录留在本机，备份存放工作文件归档。按「数据位置」搬迁沙箱后，在新位置使用标准布局。

Core 只把启动程序、工作目录和参数交给 Windows AppContainer。带输入的文件、Python 和归档进程使用管道。关闭宿主控制管道或停止运行器会关闭 Job，回收其子进程。运行前检查子进程令牌和 Job 归属。Windows 设置中的联网开关默认关闭，启用后命令只获得 Internet 客户端能力。没有私网客户端服务端能力或本机环回豁免，文件和归档工作进程始终离线。

备份以归档传递工作文件。恢复为新工作区和新 profile，成功后再发布新路径，旧工作区保留。就绪标记与绝对目录绑定，复制数据库、目录或 ACL 不会使旧 profile 在新目录中就绪。详情见 [AppContainer 官方接口](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 和 [Job Object 启动属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。

## 本机复跑

```powershell
Set-Location E:\claude\DreamFlutter-2.0
$env:DREAMFLUTTER_APPCONTAINER_TEST_NODE = 'E:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$env:DREAMFLUTTER_APPCONTAINER_TEST_PACKAGE = 'E:\claude\DreamFlutter-2.0\dist\v1.1-local-check\DreamFlutter'
& $env:DREAMFLUTTER_APPCONTAINER_TEST_NODE --test core/test/appcontainer-runner.test.ts core/test/appcontainer-provider.test.ts
```

设置 `DREAMFLUTTER_APPCONTAINER_TEST_INTERNET=1` 会增加微软公开 Windows 连接探针的宿主、离线和联网对照。此检查发送固定 HTTP 请求，验证响应，未携带用户内容或密钥。默认复跑只访问临时本机监听器。 [微软连接探针说明](https://learn.microsoft.com/en-us/troubleshoot/windows-client/networking/internet-explorer-edge-open-connect-corporate-public-network)

下面的测试通过本机 WebSocket 把两份合成资料交给蝶君，执行 Python 排队模拟，再用 PowerShell 启动随包 Node，验证 CommonJS 和 ESM 的插件版本与启停矩阵。模型使用固定本地响应，程序和文件真实运行。设置产物目录会保存两个交办的报告、可复跑代码及明细。

```powershell
$env:DREAMFLUTTER_APPCONTAINER_TEST_EVIDENCE = 'E:\claude\DreamFlutter-2.0\dist\native-workload-evidence'
& $env:DREAMFLUTTER_APPCONTAINER_TEST_NODE --test core/test/dsh-appcontainer-workloads.test.ts
```

MinGit 的单独门禁调用同一份 Git，先在宿主侧控制目录建库，再在 AppContainer 中验证建库、状态、提交、分支和工作树。容器失败时测试返回失败。

```powershell
$env:DREAMFLUTTER_APPCONTAINER_TEST_REQUIRE_NATIVE_GIT = '1'
& $env:DREAMFLUTTER_APPCONTAINER_TEST_NODE --test --test-name-pattern MinGit core/test/dsh-appcontainer-workloads.test.ts
Remove-Item Env:DREAMFLUTTER_APPCONTAINER_TEST_REQUIRE_NATIVE_GIT
```

在运行门禁的 PowerShell 中额外设置 `$env:DREAMFLUTTER_APPCONTAINER_TEST_DRIVE_ROOT = 'C:\'`，可将本次随机的原生工作区直接建在 C 盘根下做对照。测试结束会回收该 profile 和已核对位置的随机目录。这个参数只用于测试。

## Windows 实测工具范围

- 原生运行器在容器进程内默认设置 `NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main`。随包 Node 24.21.0 可加载工作区的本地 CommonJS 和 ESM 文件。模块加载会保留链接路径，依赖 `fs.realpathSync.native` 的程序仍受 Windows 路径解析限制。 [Node 模块路径选项](https://nodejs.org/docs/latest-v24.x/api/cli.html#--preserve-symlinks)
- 本机 Windows 11 25H2 build 26200.9457 上，MinGit 在普通用户目录、`GetAppContainerFolderPath` 返回的 profile 数据目录、`C:\ProgramData` 和 `C:\Users\Public` 的测试布局均建库失败。直接在 `C:\` 和 `E:\` 下建立 `appcontainer-<随机 ID>\workspace` 后，建库、状态、暂存、提交、分支和工作树通过。MinGit 返回真实路径，工作树链接指向实际目录。盘根创建权限受其他电脑的本地策略影响。源码版 Core 已联动验证切换、备份、搬迁和卸载协作，最终安装器实装仍待验证。 [路径探针明细](../appcontainer-poc/results.md)
- 将同一个普通用户目录临时映射到盘符可运行 MinGit，工作树链接会持久写入临时盘符，撤回映射后链接失效。微软项目的 BaseContainer 在更新系统补丁后有路径查询通过记录，梦蝶 AppContainer 在该版本仍待复测。 [微软 MXC 复测记录](https://github.com/microsoft/mxc/issues/1464)
- Windows PowerShell 5.1 可能把容器内的 `.exe` 识别成文档。蝶君的 PowerShell 工具接管随包 `node`、`python`、`git`、`rg`、`fd`、`uv` 及同名 `.exe` 的启动，可直接按命令名运行。包装器在容器内直接创建进程并返回输出和退出码，复合命令可读 `$LASTEXITCODE`。便携 Python 3.13.18 实测内核两轮调用复用变量，rg、fd 和 uv 已完成基础操作验证。
- 浏览器渲染仍需独立的安全接入与验收。
