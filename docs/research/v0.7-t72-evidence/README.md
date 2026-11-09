# T-72 实测证据索引

2026-11-08（Asia/Taipei）。对应 [R3 办公库](../v0.7-r3-office-footprint.md)、[R4 Git](../v0.7-r4-git.md)、[汇总](../v0.7-decision-memo.md)。只保留小型文本证据，不把 wheels、venv、源码下载或派生镜像放进仓库。

| 文件 | 用途 |
| --- | --- |
| [windows-results.json](windows-results.json) | 正式 W 基线、固定根版本、各项/组合新增字节、ZIP 字节、完整依赖元数据、wheel SHA-256；11 cases |
| [linux-exact-results.json](linux-exact-results.json) | 正式 L：原始镜像临时 chroot、普通 uid，复用 system-site-packages；11 cases |
| [linux-preliminary-results.json](linux-preliminary-results.json) | 现有运行沙箱的 11 项预测，仅对照，不混入正式结果 |
| [linux-exact-dpkg.txt](linux-exact-dpkg.txt) | 临时原镜像 dpkg/status 中已安装 Package/Version，与随包清单 667/667 一致 |
| [sandbox-image-results.json](sandbox-image-results.json) | 原镜像 hash、同口径重压缩基线、11 个追加变体 gzip 差值、推荐派生 tar.gz 的 364 个成员回读与 hash |
| [mingit-results.json](mingit-results.json) | 官方 ZIP hash/文件数/解压字节、干净 PATH 下临时仓库所有命令与返回值 |
| [registry-probe.json](registry-probe.json) | 无鉴权服务名搜索与 URL 编码 latest 详情各 HTTP 200；没连接第三方服务 |
| [windows-install-smoke.txt](windows-install-smoke.txt)、[linux-exact-install-smoke.txt](linux-exact-install-smoke.txt) | 每案例真实离线安装与代表性任务输出；不是模型自报 |
| [windows-full-requirements.txt](windows-full-requirements.txt)、[linux-added-requirements.txt](linux-added-requirements.txt) | 固定版本复现辅助：W 全套闭包，L 仅覆盖层新增/升级包；L 原有 Debian 版本依赖固定镜像，不从 PyPI 重新装 |
| [run-context.json](run-context.json) | 基线、临时根、验证分母、失败重试与限制；模型/第三方 MCP 调用均为 0 |
| [manifest.json](manifest.json) | 本目录证据文件 bytes + SHA-256；不递归包含自己 |

## 实际实验步骤与可复现脚本

脚本以 `.txt` 保存为审阅快照，**没有在仓库执行**。复现前复制到新的临时目录、调整硬编码路径并按 JSON/requirements 固定版本及 wheel hash；它们不是产品打包脚本。

1. [measure-script.txt](measure-script.txt)：工作台便携 Python 创建 venv，官方 PyPI `pip download --only-binary=:all:` 取 wheelhouse，逐项/组合 `pip --isolated install --no-index --find-links ... --no-compile`。每案例测空 venv 前后差值、压缩新增负载，执行创建/重开与数据断言。原始脚本查询本日 latest；重跑须用本目录固定版本，不把未来 latest 变更算成不可复现。
2. [exact-image-driver.txt](exact-image-driver.txt)：hash 核对过的原镜像经 stdin 解到 WSL `/tmp/dreamflutter-t72-.../exact-image`；只在临时树准备 `/dev/null`、临时 wheelhouse 和 uid 1000 的实验目录；不注册新发行版、不改原系统包。随后 `chroot --userspec=1000:1000 <临时镜像> /usr/bin/python3 -B /tmp/t72-exact/t72_measure.py /tmp/t72-exact`。内层 [exact-measure-script.txt](exact-measure-script.txt) 用固定版本和已有 wheelhouse，不联网安装。
3. [image-overlay-script.txt](image-overlay-script.txt)：原始 tar 成员到有效末尾、同一 gzip level 6 压缩器状态复制、追加真实新增文件，再规范结束 tar；实际写出推荐派生压缩流并回读。最后包清单比对直接解析临时镜像 dpkg/status；最终 JSON 的基线校验按此补录，未改压缩实测值。
4. [mingit-script.txt](mingit-script.txt)：固定官方资产校验/解压，子进程 PATH 只保留 Windows System32、隔离 Git 配置；所有 init/add/commit/branch/diff/stash/recovery 都限临时仓库。提交作者明确为测试 fixture，与产品取用户 Git 配置的验收分开。

原始源代码只读。Windows 临时根为 `C:\Users\21669\AppData\Local\Temp\dreamflutter-t72-3ba9ad424fe14340a8cade0a4dbd8b7e`，Linux 临时根为 `/tmp/dreamflutter-t72-3ba9ad424fe14340a8cade0a4dbd8b7e`。临时资源收尾结果见 [任务记录](../../../Claude%20Codex%20Bridge/2026-11-08-02-T-72调研与实测.md)。

## 判定与未覆盖

- 正式 22/22 office cases 的 `smoke=passed` 且 `modifiedDeltaBytes=0`；3 个已存在库 L 增量为 0。比较组合结果，不相加独立依赖闭包。
- 沙箱压缩对照 `dpkgMatch=true`，原镜像 hash 与 sidecar 相同；派生流可读取不等于正式镜像已经可启动或 Python 路径已接线。
- Office 用例是结构/数据 smoke，不是美观、原生打开、保真转换或任意复杂输入验收。报告写清公式未计算、中文视觉未检查。
- MinGit 本地命令通过，不代表 T-74 产品 API/审批/冲突和网络鉴权已测。
- 本轮没有产品代码全量测试、真实模型、付费服务或第三方 MCP 连接；Registry 的两个无凭据 GET 不视为 MCP 连接测试。
