# 2026-11-20 Windows 实测回执

在本机 Windows 11 家庭版 25H2 x64（build 26200）使用未提升权限的令牌运行。工具来自现有 `1.0.0-preview.2` Windows 产物的临时副本。办公用例复用仓库的 `scripts/t75-office-smoke.py`。完整命令见 [复跑说明](README.md)。

| 项目 | 实测结果 |
| --- | --- |
| 令牌 | `TokenIsAppContainer=1`，profile SID 匹配，能力数量为 0。 |
| 文件权限 | 宿主能读写同级合成样本。容器能在私有目录创建、读回、删除文件。同级样本读写和工具样本写入均返回 `ERROR_ACCESS_DENIED`（5）。工具样本读取成功。 |
| 本机环回 | `127.0.0.1` 合成监听端口在前后两次宿主对照中均连通。容器连接在 2 秒内未建立，返回 `WSAETIMEDOUT`（10060），监听端没有收到容器连接。 |
| Job 回收 | 原生探针父子进程在关闭句柄前都还活着，子进程确认属于该 Job，关闭唯一 Job 句柄后两个进程均退出。 |
| 启动及清理 | 多次 Win32 启动到进程恢复运行耗时 46–94 ms。这一时间不含 profile 创建、权限设置、工具复制、用户可用性检查。各次完成的对照中 `DeleteAppContainerProfile` 返回 0，临时目录已删除。 |
| Node.js v22.23.2 | 可以运行，能向私有目录写文件。读取合成文件的 `fs.realpathSync.native` 返回 `EPERM`，相关兼容性门禁未过。 |
| Python 与 uv | 便携 Python 3.13.18 能向私有目录写文件。uv 在工作区离线建成 venv，生成了 `pyvenv.cfg`。 |
| rg 与 fd | 对私有目录内的合成样本进行内容和文件名查找，均返回 0。 |
| MinGit | `git init` 返回 128，stderr 为 `fatal: unable to get current working directory: Permission denied`，没有生成 `.git/HEAD`。 |
| 随包办公工具 | 6 项通过。中文 DOCX、XLSX 内容和公式字符串、PPTX、PDF 元数据及拆页、10 万行 CSV/pandas 聚合、中文柱图。图表使用随包的文泉驿微米黑。办公脚本记录网络调用为 0。 |

宿主和容器都能打开同一个新建工作区的目录句柄。宿主的 `GetFinalPathNameByHandleW` DOS/NT 两种查询及 `GetLongPathNameW` 都返回成功。在普通用户临时目录，容器的 NT 查询成功，DOS 查询和 `GetLongPathNameW` 均报 Windows 错误 5。E 盘下的随机目录中，容器的 DOS 查询仍报 5，`GetLongPathNameW` 成功，MinGit 也能初始化仓库。这与 MinGit 工作目录解析的两条路径相符。 [MinGit 当前目录解析源码](https://github.com/git-for-windows/git/blob/v2.56.0.windows.4/compat/mingw.c)、[Microsoft STL 的 AppContainer 同类问题](https://github.com/microsoft/STL/issues/6286)

| 工作区布局 | 随包 Node.js `realpathSync.native` | 同一 MinGit `init` |
| --- | --- | --- |
| 普通用户临时目录内的随机子目录 | 退出 1，`EPERM` | 退出 128，当前目录权限拒绝。 |
| 本次 profile 的官方 `AC` 数据目录内的新建子目录 | 退出 1，`EPERM`。直接读同一合成文件成功。 | 退出 128，当前目录权限拒绝。 |
| `E:\` 根下随机子目录 | 退出 1，`EPERM` | 退出 0，生成 `.git/HEAD`。 |

E 盘对照只在单个 PowerShell 进程中覆盖 `TEMP` 和 `TMP`。只设置随机临时目录及其子目录的权限。官方 `AC` 数据目录对照沿用该 profile 创建时的权限。两次布局对照均确认新建的 profile 数据子目录、profile 和外侧临时目录已删除。 [GetAppContainerFolderPath 官方接口](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-getappcontainerfolderpath)

纯原生探针退出 0。带包模式和两次布局对照各退出 1，保留确实复现的工具兼容性门禁失败。普通 AppContainer 仍可读取系统授予应用包的部分资源，本次结果只覆盖合成样本的读写边界。独立标准用户账户和不同 Windows 版本、安装及卸载流程仍需单独验收。 [Microsoft 的 AppContainer 访问控制说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

## Node 24.21.0 与其他合法 Windows 路径复跑

在同样隔离条件下，用本机 DSH 运行时 Node 24.21.0 替换临时副本。在用户 TEMP、官方 AC 目录和 E 盘短目录中，`realpathSync.native` 仍为 `EPERM`。对同一个合成文件，在 TEMP 和 E 盘内也分别验证了带扩展前缀的 DOS 路径和卷 GUID 路径。两种路径都能直接读取文件，交给 `realpathSync.native` 仍报 `EPERM`。在普通 TEMP 工作区，显式指定 MinGit 的 `--git-dir` 和 `--work-tree` 仍返回 128。 [Windows 支持的卷名称](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-volume)

普通 TEMP 中用 Node 24.21.0 执行两个常规 CommonJS 文件，默认模块加载在 `lstat` 盘符根时失败。同样两个文件在显式加 `--preserve-symlinks --preserve-symlinks-main` 后执行成功，ACL 和令牌保持一致。完整 Node 工具链与默认数据位置的 MinGit 仍有兼容门禁。 [生产运行器和验证命令](../appcontainer-runner/README.md)
