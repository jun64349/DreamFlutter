# 03｜蝶君内置轻量目录级隔离方案（替代 WSL2 虚拟机）

您在这轮对话里明确指出了当前 1.0 沙箱的体验痛点：
> 「能不能在工作目录里创造一个完全隔离的环境，不要另外装软件、不要建这么大的虚拟机沙箱，电脑里还会多显示一个虚拟机入口（`此电脑 › Linux`），安装和卸载都很麻烦；直接在我们软件内部做一块隔离的地方，给蝶君去自处理、自成长。」

本文从 Windows 操作系统安全内核机制出发，横向对比四条技术路线，给出 **主推方案（Windows 原生 `AppContainer` + `Job Object` + WFP 网络开关）** 的落地方案、坦诚边界与上线前必过的 POC 门禁。

---

## 一、现状痛点量化（WSL2 方案的真实代价）

根据 [`core/src/sandbox/sandbox.ts`](../../../core/src/sandbox/sandbox.ts)、[`v0.13.2-性能与包体回执.md`](../../releases/v0.13.2-性能与包体回执.md) 与 [`v1.0.0-preview.2.md`](../../releases/v1.0.0-preview.2.md) 记录，当前基于 Debian 13 WSL2 的沙箱存在五项硬成本：
1. **包体与磁盘膨胀**：压缩后的 Debian 13 根镜像约 **`653MB`**，解压导入后占用约 **`4.25GB`** 磁盘（`clean.vhdx` + `ext4.vhdx`）。
2. **安装链脆弱**：依赖宿主系统开启「适用于 Linux 的 Windows 子系统 / 虚拟机平台」可选功能，许多普通用户机器会卡在启用功能或重启提示上。
3. **系统侵入感强**：一旦注册发行版，Windows 文件资源管理器左侧导航栏就会常驻「**`此电脑 › Linux`**」虚拟图标，哪怕只想找个纯净桌面工具的用户也会看到这台多余的虚拟机。
4. **卸载与清理复杂**：安装包卸载时不得不专门处理 `unregisterSandbox`，稍有残留进程锁定就会导致卸载卡顿或失败（`1.0.0-preview.2` 刚专门修过一次相关清理流程）。
5. **跨边界工作流摩擦**：用户工作在 Windows 文件系统、前端是 Windows Flutter，蝶君却在 Linux 子系统里，路径映射、剪贴板/图形环境与字体差异带来了额外的适配复杂度。

---

## 二、蝶君自主沙箱真正需要守住哪 5 条安全边界？

蝶君定位是**免审批自主工作与自成长**。一旦去掉人工逐条确认，沙箱必须在「**操作系统内核层**」而非「软件约定层」死守以下五条线：
1. **写隔离（必守）**：蝶君及其拉起的任意 Python 脚本、Node 脚本、命令行子进程，**绝对写不坏**沙箱目录以外的用户桌面、文档、系统盘与 DreamFlutter 自己的安装目录/Core 配置/API 密钥。
2. **读隔离（强烈建议）**：蝶君运行任意不可信代码块或处理外部文档时，**默认看不见**用户桌面的敏感合同、`.ssh` 私钥、浏览器 Cookie/Profile、密码管理器库及其他磁盘分区（只读随包工具目录，读写仅限蝶君私有空间）。
3. **真网络开关（必守）**：当前 WSL2 的核心优势之一是能明确分出「离线运行」与「允许联网」两档。新方案必须由系统内核强制执行离线/联网切换，同时**绝对禁止蝶君里的不受控子进程直接连本机 `127.0.0.1` 探活 DreamFlutter Core WebSocket 或本地后台服务**。
4. **资源与进程防逃逸（必守）**：限制死循环 Fork 炸弹、内存暴涨；当任务点「停止」或主程序退出时，**连根杀净整棵子进程树**，不留后台游荡进程。
5. **无感知生命周期（体验底线）**：免管理员权限可开箱即用、0 独立安装向导、资源管理器不出现额外虚拟机/盘符、卸载就是删掉软件与数据目录。

---

## 三、Windows 上 4 条非虚拟机 / 替代方案横向对比

| 评价维度 | 方案 A：仅软件层路径/命令拦截 | 方案 B：DSH/Codex 路线（`WRITE_RESTRICTED` 受限令牌 + ACL + Low Integrity） | **方案 C：Windows 原生 `AppContainer` + 属主 ACE + `Job Object`（主推）** | 方案 D：Docker / Windows Sandbox (`.wsb`) / Hyper-V |
| :--- | :--- | :--- | :--- | :--- |
| **额外安装包 / 体积** | `0 MB` | `0 MB` | **`0 MB`（复用已随包工具链）** | 数百 MB ~ 数 GB（重度依赖系统版与虚拟化） |
| **Explorer 多出虚拟机** | 无 | 无 | **无（纯私有目录）** | 有虚拟网卡/服务/独立窗口 |
| **启动耗时** | 毫秒级 | 毫秒级 | **毫秒级** | 秒级 ~ 数十秒 |
| **防写越界强度** | **脆弱**（Python/PowerShell 一行代码轻松绕过字符串校验） | 强（系统内核拦写，但需注意 NTFS 硬链接旁路与旧工具兼容性） | **极强（Win32 内核级拒绝无能力 SID 一切外部写入）** | 极强（VM 级） |
| **防读偷窥（桌面/SSH/隐私）** | **无** | **弱 / 无（DSH 官方标注为 `partial` 级别：默认防写不防读）** | **强（默认全盘不可读，仅白名单目录可进）** | 极强（VM 级） |
| **注册表与命名对象隔离** | **无** | 仅靠 Low Integrity，仍可读大量主机共享信息 | **强（独立注册表虚拟视图与命名管道/互斥量命名空间）** | 强 |
| **离线 / 联网硬件级开关** | **无**（子进程随便 `curl`/`urllib`） | **无**（Codex/DSH Windows ACL 默认无内核网络阻断） | **原生支持（WFP Capability 位：不授 `internetClient` 即内核断网，且默认隔离 `localhost`）** | 支持 |
| **非管理员日常可用性** | 高 | 中（对他人/系统目录改 ACL 常报 `ERROR_ACCESS_DENIED (5)` 或需 `SeSecurityPrivilege`） | **高（DreamFlutter 私有新建目录属主是当前用户自己，可直接给 SID 赋权，无需管理员）** | 低（多需管理员启用虚拟化/服务） |
| **最大缺点 / 限制** | 不安全，不能免审批 | 读不隔离、无断网、DSH 自承仅算 `partial` | **只跑 Win32 原生工具，不能直接跑 Linux ELF / `apt`；科学栈依赖需 POC 验证** | 比当前 WSL2 更笨重，直接否定 |

> **关键对比结论**：
> - `@deepseek-ai/dsh-sandbox-windows-acl`（以及同类开源实现如 OpenAI Codex Windows Sandbox）主要解决「代码仓库助手写不坏仓库外文件」的问题，但没有解决**读隐私目录偷窥、断网控制、非管理员打标**三个问题，因此连 DSH 自己都只把它归为 **`partial` 级别隔离**，不足以承接蝶君「完全免审批、自处理、自成长」的安全定位。
> - **`AppContainer` 补齐了上述所有安全短板**，却长期较少被通用终端工具用作任意目录沙箱——原因不是它不安全，而是**通用 CLI 如果直接面向用户的 `C:\Users\Alice\Desktop` 跑，逐文件给任意大目录挂 `AppContainer` SID ACE 会极慢且常撞权限**。而**蝶君工作在 DreamFlutter 自己新建和持有的私有工作目录下，正好完美避开了通用工具的短板，同时吃满 `AppContainer` 的全部内核安全红利！**

---

## 四、主推方案详细设计：软件内置 `AppContainer` 工作空间

### 4.1 为什么「软件内置私有目录 + `AppContainer`」天作之合？
1. **目录属主（Owner）干净**：DreamFlutter 首次在本地集中数据目录下创建 `data/butterfly-space/`（及蝶君自成长区域如 `skills/`、`workspace/`、`temp/`）时，目录的 Windows Owner 就是当前运行桌面端的普通用户。非管理员权限即可通过 `CreateAppContainerProfile` 创建专属 AppContainer SID（如 `DreamFlutter.Butterfly.Sandbox.<instanceId>`），并调用 `SetEntriesInAclW` 一次性给该根目录挂上可继承（`OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`）的 `GENERIC_READ | GENERIC_WRITE | DELETE` ACE。一次授权，永久生效。
2. **双向文件边界一目了然**：
   - `data/butterfly-space/`：蝶君有**读写删全权限**（自由建项目、写测试、攒脚本、做实验报告）；
   - DreamFlutter 随包静态工具目录（如 `core\python`、`runtime`、`core\bin`）：只授予 **Read & Execute** 只读权限，蝶君**能调用工具但改不了工具二进制**；
   - 宿主其它一切位置（`桌面`、`我的文档`、`C:\Users\...\.ssh`、Chrome 资料、`DreamFlutter` 存放激活码/API Key/主配置的目录）：**未出现在白名单即全部 `ACCESS_DENIED`**，连列目录都进不去。
   - 当用户明确在界面把某个外部文件夹「挂载/拷贝导入给蝶君」时，有两条安全选择：默认拷贝进入隔离工作区，或仅针对显式选择的单个目录按用户授意挂「只读引用 ACE」，用完回收。

### 4.2 原生离线 / 联网切换与本地环回防越狱
这是 `AppContainer` 相对 ACL 方案最大的安全加分项：
- **安全启动进程**：构造 `STARTUPINFOEXW`，通过 `UpdateProcThreadAttribute` 写入 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，把蝶君 AppContainer SID 与能力数组传给 `CreateProcessW`。
- **离线档（严格隔离模式）**：Capabilities 数组留空 `[]`！Windows WFP（Windows Filtering Platform）直接在内核网络栈拦截该进程树所有外联与本机回环流量——蝶君里跑的任何脚本连 `localhost` 都不通，彻底堵死恶意/出错脚本绕道攻击本机 DreamFlutter Core WS 接口的可能。
- **联网档（受控外网模式）**：按策略只追加 `WinCapabilityInternetClientSid`（如后续需细化域名白名单，再配合本机轻量只读代理或 Core 提供的受控网络工具），且**依然不授予 `WinCapabilityPrivateNetworkClientServerSid` 与 Localhost Loopback 豁免**——意味着蝶君能查公网资料，但依然摸不到你局域网 NAS 和本机内网服务端口。

### 4.3 进程树防逃逸：`Job Object` 托底
在拉起 `AppContainer` 子进程时同步把它绑进一个新建的 Windows **`Job Object`**：
- 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：不管用户点界面「停止」、Core 异常退出还是升级，只要句柄关闭，整个 `AppContainer` 内的 Python / Node / git / 孙子进程毫秒级全部一起连根销毁，彻底消灭僵尸进程；
- 设置 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 与 CPU 速率上限：防止蝶君在无人值守做测试时写出内存泄漏或死循环 Fork 把宿主电脑拖死。

### 4.4 工具链「零额外膨胀」复用方案
> **名词直白说明（什么是「Win32 原生工具栈」？）**：以前在 WSL2 虚拟机里跑的是 **Linux 版**的 Python、Node、bash 和 `sudo apt install`。取消虚拟机、改用软件内置的 `AppContainer` 目录隔离后，里面不再装着一套 Linux 系统，而是直接运行标准的 **Windows 原生格式（`.exe`）程序**（Windows 版 Python、`uv`、Node.js、Git、PowerShell 等——技术术语叫 Win32 工具链）。对日常写文档、做数据分析、跑脚本来说，体验几乎没有区别（包管理从 `apt` 换成 `pip`/`uv`/`npm` 装 Windows 轮子即可）。

去掉 WSL2 后，蝶君不再需要一套 650MB+ 的 Linux rootfs，而是直接复用 DreamFlutter 安装包内原本就携带的 **Windows 原生便携工具链**：
- 便携版 **Python + `uv`**（科学计算、数据分析、脚本、自动化）
- 内置 **Node.js**（升级至 `>=24.9` 后同样可只读共享给沙箱）
- 随包便携工具：**`rg`（ripgrep）、`fd`、MinGit（`git` / 轻量 Shell 工具子集）**
- 所有运行产生的缓存/包安装（`TMP`、`TEMP`、`APPDATA`、`LOCALAPPDATA`、`UV_CACHE_DIR`、`PIP_CACHE_DIR`、`NPM_CONFIG_CACHE`）在拉起子进程前统一通过环境变量**重定向到 `data/butterfly-space/.env/` 内部**，确保既不污染用户 Windows 系统目录，也不会因为读不到外部 AppData 而报错。

---

## 五、DSH 底座集成：作为标准 `dsh-sandbox-appcontainer` 插件（并面向 macOS / 多端预留替换）

在切到 DSH + Cordis 架构后，蝶君新沙箱完全遵守 DSH 的**三元能力缝（Capability Seam）**：
1. 直接实现 DSH `sandbox` 服务契约（导出等价能力，如 `exec`、`spawn`、`capabilityMode: 'strict'`），挂为 DreamFlutter 自研插件 `@dreamflutter/dsh-sandbox-windows-appcontainer`；
2. 进程桥接层面：Node.js 主进程可通过 **`koffi` FFI** 或随包一个极轻量的 **Win32/Rust/C++ 辅助原生桥（`< 1MB`）** 调用上述 Win32 API（注意 Win32 安全 API 调用及子进程管理保持异步，不阻塞 Node 事件循环）；
3. **跨端演进与生态回馈**：正是因为走了 DSH 标准化 `sandbox` 契约，上层蝶君和记忆/任务插件**完全不写死 Windows API**——将来做 macOS 版时，只需在同一契约缝下面换成 macOS 原生沙箱提供者（如 `sandbox-exec` / App Sandbox）；而这套补齐了读隔离与断网开关的 Windows `AppContainer` 提供者本身也能反哺 DSH 社区！

---

## 六、坦诚局限与上线前必测的 4 项 POC 验证门禁

本着不做盲目乐观假设的原则，在**两周后 1.0 正式版发布并启动 2.0**时，把 WSL2 正式撤掉之前，**必须实测验证以下局限与兼容性风险**：

### 必须接受的能力边界
- **只跑 Windows 原生工具（不直接跑 Linux 专用程序与 `apt`）**：如果极少数专业开发任务硬要运行仅支持 Linux 的底层二进制，Windows 本地目录级隔离无法直接运行；不过对个人桌面与通用工程任务，Windows 原生 Python/Node/Git 覆盖度已经足够，真有极少数 Linux 需求时未来也可通过外接可选扩展处理，不绑死默认主安装包。

### 必跑的 4 项实体 POC（POC-3）
只有这 4 项在真实普通用户（**非管理员账户**）的 Windows 10 / Windows 11 实体机上全部通过，才拍板替换 WSL2：
1. **POC-3A（权限隔离验证）**：在 `AppContainer` 内分别跑 `python`、`node`、`rg`、`git`：
   - 读写 `data/butterfly-space/test.txt` 必须成功；
   - 读取 `%USERPROFILE%\Desktop`、`%USERPROFILE%\.ssh`、`C:\Windows\System32\drivers\etc\hosts` 或向随包 `core\python` 目录写文件必须全部报权限拒绝；
   - 离线档下执行 TCP 连接外网与连接 `127.0.0.1` 上测试端口必须被内核直接拦截拒绝。
2. **POC-3B（便携 Python 与包管理验证）**：检查随包便携版 `python` + `uv` 在只读工具目录 + 可写私有 `venv`/缓存目录下，安装运行常见数据处理与出图库（如 `numpy`、`pandas`、`matplotlib` 输出 PNG 到私有目录）是否顺畅，会不会在 `msvcrt`/临时文件/Windows 字体目录权限上踩坑。
3. **POC-3C（前端资产 / 无头浏览 / 子进程树回收验证）**：验证 `git`（HTTPS 联网档凭据与 CA 根证书访问）、以及如果在内部跑 Node 构建工具或无头浏览器渲染，是否存在 AppContainer 默认缺少字体/GPU/COM 权限导致的闪退，并验证 `Job Object` 强杀时子进程零残留。
4. **POC-3D（真实启动与卸载洁净度验证）**：验证冷启动拉起耗时 `< 100ms`，验证完全卸载时只需常规删除 Profile（`DeleteAppContainerProfile`）与目录，彻底告别「`此电脑 › Linux`」图标与卸载卡死。
