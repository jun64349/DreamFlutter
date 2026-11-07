# 工具软件源预设（6.13 / T-65 B）

入口：设置 → 工具与 MCP → 工具软件源。默认均为“跟随现有配置”，保存设置不会访问镜像或调用模型。

## 设置与作用范围

通过既有 `settings.update` 更新，错误枚举不覆盖持久值：

| 字段 | 默认 | 可选值与地址 |
| --- | --- | --- |
| `pythonPackageSource` | `inherit` | `pypi`：https://pypi.org/simple；`tuna`：https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple；`ustc`：https://mirrors.ustc.edu.cn/pypi/simple |
| `npmPackageSource` | `inherit` | `npm`：https://registry.npmjs.org；`npmmirror`：https://registry.npmmirror.com |

应用预设仅进入 DreamFlutter 创建的工具进程：Python 同时注入 `UV_DEFAULT_INDEX`、`PIP_INDEX_URL`；npm 注入 `npm_config_registry`。Windows 的普通/持久 PowerShell 和 WSL 内持久 Bash 均接线。WSL 的变量由 Linux Bash 显式 export，未把 Windows 的 spawn 环境误当成 Linux 已接收。

默认 inherit 不添加/删除源变量，保留既有代理、TLS 与配置。明确选择应用预设时，清除同工具继承的旧索引别名及额外索引变量，避免应用创建多索引组合。现有系统代理转发继续沿用；Git 不注入镜像，不改 remote。不会写系统环境、全局工具配置、项目配置、锁文件或 apt 配置，不增加 trusted-host、不关闭 TLS、不设置失败后的多源回退。

## 项目配置优先

每条命令开始前检查有效 cwd 至当前工作区根目录（最多 32 层）。只读普通配置文件，最大 64 KiB；链接、不可读/异常、过大文件均视为无法确认。WSL 使用发行版内 agent 身份读取元数据，不执行项目代码，不把文件正文写日志。

| 工具 | 项目优先判断 | 应用行为 |
| --- | --- | --- |
| uv | 存在 `uv.toml`，或 `pyproject.toml` 中有 `[tool.uv...]` 索引/来源配置 | 不注入 UV 索引，删除继承的 UV 索引覆盖，让工具读取项目配置 |
| pip | 工作区内 `pip.conf` / `pip.ini` 存在 | 不注入 pip 索引；清除继承的 pip 索引覆盖，进程内 `PIP_CONFIG_FILE` 指向该项目文件，因为 pip 不自动读取 cwd 的任意 pip.ini |
| npm | `.npmrc` 有 registry / scoped registry | 不注入 npm registry，清除继承的 registry 覆盖，让 npm 按项目配置读取 |

每种工具独立决定；例如项目只指定 uv 源时，pip 仍可用应用预设。无法确认配置，或一条命令内含无法预先确定的新目录切换时，保守地不注入应用源；来源显示“配置无法确认，未覆盖”。不声称覆盖 shell 内任意动态代码和工具自身命令行选项。锁文件存在本身不抑制预设，也不触发应用重写。

## 生效与状态 RPC

`packageSources.status {cwd?: string}` 返回：

- `nextHost`：该目录下一条工作台命令的预览，不覆盖最近实际运行记录。
- `recent.host` / `recent.sandbox`：最近一次工具环境构建；含 platform、cwd、workspace、时间、可选 distro，以及 uv/pip/npm 各自的 `layer`（application/project/existing）、preset、reason、锁文件存在标志。
- `python` / `npm`：固定预设表。

状态不返回代理、环境变量全文或项目配置内容。普通日志只记录平台、目录与各工具来源层，不记录任意源地址/凭据。状态接口只读，无网络请求。

环境上下文按后台实例和会话工作区隔离，经 `Core.openSlot` 捕获；Pi host 在每次harness扩展加载时绑定本实例provider，覆盖子任务、SDK重载和内部重绑定，未改harness文件。持久 shell 串行队列中的正在运行命令继续使用原环境；设置或有效源环境变化后，在下一条命令开始前只重建该 shell 子进程。cwd 保留，shell 内临时变量/函数随重建清空。默认 inherit 下普通 cd 保留持久状态，不因目录本身变化反复重建。WSL 重建仍先运行既有 ready/离线规则，选择镜像不改变 sandboxOnline。

## 真实验证（2026-11-07）

脚本：`core/scripts/live-package-sources-t65.ts`。最终完整证据：`Claude Codex Bridge/T65-B-live-tools-final.json` / `.log`。全部在临时目录和自建发行版运行；模型调用 0、模型费用 0。未测试 USTC 下载可用性，USTC 固定值由环境/枚举测试覆盖。

| 平台 | 工具版本 | 官方 uv/pip/npm | 清华 uv/pip、npmmirror npm |
| --- | --- | --- | --- |
| Windows | uv 0.13.6、pip 26.2.2、Python 3.13.18、npm 10.9.8 | 1841 / 2526 / 1785 ms，均 code0 | 1907 / 1725 / 1403 ms，均 code0 |
| WSL | uv 0.13.6（仅测试 venv 安装）、Python 3.13.5、npm 9.2.0 | 1782 / 3170 / 1149 ms，均 code0 | 2361 / 1552 / 1261 ms，均 code0 |

小包分别为 `idna==3.10` 的 uv target install、pip download，及 `is-number@7.0.0` 的 npm view。uv verbose 与 pip/npm 输出记录实际源：PyPI/清华、files.pythonhosted.org、registry.npmjs.org/registry.npmmirror.com；npm 锁定安装可由镜像跳转至 cdn.npmmirror.com。这是包源自身的响应，不是应用增加回退。Linux 实际打印并校验三个源变量；项目配置独立优先也在 Windows/WSL 实读验证。

Windows/WSL 各自生成官方源锁文件，再切镜像：`uv sync --locked` 均 code1，说明锁需要更新，锁 SHA-256 不变；`npm ci --ignore-scripts` 均 code0，实际从 npmmirror/CDN 下载，锁 SHA-256 不变。记录日志中的官方旧锁地址不表示发生了自动源回退。应用不替工具修改锁；用户自行运行会更新锁的工具命令仍由工具决定。

离线复验：设置 sandboxOnline=false 后，清华请求 curl code28，3765ms；镜像变量仍在 Linux 中，但网络不通。WSL 跨发行版共享网络，因此测试为临时 agent 分配唯一 uid，并仅在测试注入 runner 中替换 bootScript 的 uid/表名，执行同一既有规则逻辑；未改生产规则代码，未改其他发行版的 `dreamflutter` 表。独立测试表、临时发行版和目录已清理，清理结果 true。

自动化还用本地 HTTPS CONNECT 代理实际拦截 uv/pip/npm 的官方/镜像/项目三种来源（9 个组合），不访问上游，不禁 TLS；覆盖默认继承、无凭据日志、设置校验、持久 shell 刷新、运行中设置切换、跨 Core 隔离、Core.openSlot 接线和浅/深色 150% 保存失败回滚。完整检查结果见 T-65 回执。

## 配置语义依据

[uv 配置文件及优先级](https://docs.astral.sh/uv/configuration/files/)、[uv 环境变量](https://docs.astral.sh/uv/reference/environment/)、[pip 配置与 PIP_CONFIG_FILE](https://pip.pypa.io/en/stable/topics/configuration/)、[npmrc](https://docs.npmjs.com/files/npmrc/)；镜像固定地址沿用 T-65 M1 和 R5 调研。客户端行为以本次实际版本及隔离证据为准。
