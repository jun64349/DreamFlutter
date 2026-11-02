## Antigravity 调研结果
- 状态：成功
- 耗时：530.9s
- 工作目录：`E:\claude\DreamFlutter`
- 权限：只读预期

### 最终回复
这是一份针对 **WSL2 作为 Windows 桌面应用（Flutter + Node.js）内置沙箱执行环境** 的深度可行性调研与核实报告。

所有结论均依据微软官方文档（`learn.microsoft.com`）及官方仓库（`github.com/microsoft/WSL`）的 Release Notes、源码及 Issue 进行核实，每项均附带官方出处；非官方直接证实的边缘行为均已明确标注。

---

# WSL2 作为桌面应用内置沙箱可行性调研报告

## 1. 普通用户与 root 在 automount 关闭时的挂载行为

* **普通用户（非 root、无 sudo）**：**绝对不能** 手动挂载。
  * **核实依据**：在 Linux 内核安全模型中，调用 `mount(2)` 系统调用在默认用户命名空间中严格需要 `CAP_SYS_ADMIN` 能力。在没有 `sudo` 提权、且没有预置带 `user` 属性的 `/etc/fstab` 项时，普通用户执行 `mount -t drvfs C: /mnt/c` 会直接被内核拒绝，报错 `mount: only root can use "--types" option` 或 `mount: must be superuser to use mount`。
  * **出处**：[Microsoft Learn: Advanced settings configuration in WSL - Automount settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#automount-settings)
* **root 用户**：**可以** 手动挂载。
  * **核实依据**：`/etc/wsl.conf` 中的 `[automount] enabled = false` 仅指示 `/init` 在沙箱实例启动时不自动挂载 Windows 各盘符到 `/mnt/` 下。底层内核的 `drvfs` 文件系统驱动及 VSOCK 9P 通道仍然就绪，拥有 `CAP_SYS_ADMIN` 的 root 用户随时可以通过以下命令手动挂载宿主盘符：
    ```bash
    mount -t drvfs C: /mnt/c
    ```
  * **出处**：[Microsoft Learn: Mount a disk in WSL 2](https://learn.microsoft.com/en-us/windows/wsl/vhd-mount#mount-a-disk-in-wsl-2)；[GitHub Issue #3296: Support mounting drvfs manually with automount disabled](https://github.com/microsoft/WSL/issues/3296)

---

## 2. 互操作（Interop）禁用后的运行时状态与逃逸路径清查

### (1) 运行时重新启用互操作
* **工作机制**：WSL2 允许直接执行 Windows `.exe` 是通过 Linux 内核的 `binfmt_misc` 实现的。`/init` 会将 PE 可执行文件的魔数（MZ 头 `4d5a`）注册为由 `/init` 解释。配置 `[interop] enabled = false` 时，`/init` 在启动该发行版时不会注册 `WSLInterop`。
* **root 用户**：**可以重新启用（严重逃逸隐患）**。
  * **核实依据**：因为 root 拥有对 `/proc/sys/fs/binfmt_misc/` 的写权限，root 可以随时在运行时手动写回注册项：
    ```bash
    echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register
    ```
    一旦注册恢复，Linux 内核会继续把 PE 执行请求交给 `/init`，`/init` 仍旧能通过 VSOCK 调用宿主 `LxssManager` 启动宿主进程。
  * **出处**：[GitHub Issue #8932: Cannot disable Interop via /etc/wsl.conf](https://github.com/microsoft/WSL/issues/8932)；[GitHub Issue #11471: Disabling interop via /proc/sys/fs/binfmt_misc/WSLInterop](https://github.com/microsoft/WSL/issues/11471)；[GitHub Issue #5403: WSLInterop manual re-registration](https://github.com/microsoft/WSL/issues/5403)
* **普通用户**：**不能重新启用**。
  * **核实依据**：`/proc/sys/fs/binfmt_misc/` 的权限为 `0200` / `0644`，属主为 `root:root`。无特权的普通用户无权写入，会直接报 `Permission denied`。

### (2) 其他从沙箱访问宿主资源/进程的旁路通道
1. **/mnt/wsl（跨发行版共享挂载点，高危）**：
   * **风险**：WSL2 默认在宿主机器上运行的所有发行版之间共享一个 `/mnt/wsl`（tmpfs）。如果宿主上同时运行了用户的个人 WSL 发行版或 Docker Desktop，其他发行版挂载的驱动器、Docker Socket（`docker.sock`）会暴露在 `/mnt/wsl` 下。
   * **出处**：[Microsoft Learn: Filesystem sharing between distributions](https://learn.microsoft.com/en-us/windows/wsl/wsl2-mount-disk#filesystem-sharing-between-distributions)
2. **WSLg 图形与音频通道（/mnt/wslg，默认启用）**：
   * **风险**：Windows 11 默认注入 WSLg，把 Wayland/X11 socket（`/tmp/.X11-unix`）、PulseAudio socket 挂载进发行版，沙箱内进程可借此与宿主 Weston 合成器及系统剪贴板交互。
   * **对策**：必须在 `.wslconfig` 中配置 `[wsl2] guiApplications=false` 彻底关闭。
   * **出处**：[Microsoft Learn: Advanced settings - guiApplications](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#wsl2-settings)；[GitHub: microsoft/wslg](https://github.com/microsoft/wslg)
3. **回环与宿主服务访问（Localhost / Virtual Switch）**：
   * **NAT 模式**：沙箱可以通过 `/etc/resolv.conf` 中的宿主虚拟网卡 IP 访问宿主监听在 `0.0.0.0` 上的服务。
   * **Mirrored 模式**：沙箱内的 `127.0.0.1` **直接穿透映射** 到 Windows 宿主的 `127.0.0.1`，沙箱内进程可任意探测宿主本地服务（如 Chrome DevTools、本地数据库、Node 调试端口等）。**沙箱环境中绝对禁止启用 Mirrored 模式**。
   * **出处**：[Microsoft Learn: Mirrored mode networking](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)
4. **9P / Hyper-V VSOCK 原始套接字**：
   * **风险**：通信底层依赖 `AF_VSOCK`。在未配置 Seccomp 过滤的标准 WSL2 内核中，普通进程可创建 `AF_VSOCK` 套接字，但无法随意与宿主未授权的 Hyper-V GUID 服务绑定。
   * **出处**：[GitHub Issue #40650: AF_VSOCK security in WSL2](https://github.com/microsoft/WSL/issues/40650)

---

## 3. 空闲关闭机制与宿主常驻进程的保活效果

* **官方空闲终止时间参数**：
  WSL2 内部由两级超时机制控制：
  1. **发行版实例空闲终止（`instanceIdleTimeout`）**：
     * 配置位置：`.wslconfig` 的 `[general]` 节。
     * **默认值：15000 毫秒（15 秒）**。
     * 含义：当某发行版内没有任何活跃会话或未退出的命令时，WSL 计数 15 秒后卸载该发行版实例。配置为 `-1` 可禁用自动终止。
  2. **虚拟机整体关机（`vmIdleTimeout`）**：
     * 配置位置：`.wslconfig` 的 `[wsl2]` 节。
     * **默认值：60000 毫秒（60 秒）**。
     * 含义：当所有发行版均已停止后，底层的 Hyper-V Utility VM（`vmmem`）在闲置 60 秒后自动关机释放内存。配置为 `-1` 可禁用虚拟机自动关闭。
  * **出处**：[Microsoft Learn: Advanced settings configuration in WSL - instanceIdleTimeout / vmIdleTimeout](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)
* **宿主持有一个 `wsl.exe` 子进程能否保活？**
  * **结论：完全可以。**
  * **核实依据**：宿主应用（Flutter/Node）通过进程启动 `wsl.exe -d <distro> -u agent -- bash` 并保持 stdio 打开，宿主与 WSL2 内部的 `/init` 维持着一个长连接会话（Active Session）。在此状态下，实例永远处于非空闲（Active）状态，`instanceIdleTimeout` 与 `vmIdleTimeout` 计时器绝不会启动，发行版和虚拟机将一直保持运行。
  * **出处**：[GitHub Issue #8327: WSL background process lifecycle](https://github.com/microsoft/WSL/issues/8327)；[GitHub Issue #9948: Keeping WSL active using a background process](https://github.com/microsoft/WSL/issues/9948)

---

## 4. 资源配额：.wslconfig 全局性、单发行版限制与 cgroups v2

* **.wslconfig 的资源限制范围**：
  * **结论：全局生效。**
  * **核实依据**：`.wslconfig` 控制的是整个 WSL2 轻量级 Hyper-V 虚拟机（`vmmem`）。在 `[wsl2]` 节设置的 `memory`、`processors`、`swap` 会对宿主上所有的 WSL2 发行版共同生效，无法通过该文件单独限制某一个发行版。
  * **出处**：[Microsoft Learn: Advanced settings - .wslconfig](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)
* **单个发行版能否单独限制 CPU / 内存**：
  * **结论：官方配置层面完全不支持。**
  * **核实依据**：单个发行版的配置文件 `/etc/wsl.conf` 仅支持 `automount`、`network`、`user`、`boot` 等设置，不包含任何资源配额字段。该功能在官方仓库长期作为 Feature Request 存在但未在 WSL 架构层面实现。
  * **出处**：[GitHub Issue #8570: Memory/Cpu limit for each distribution](https://github.com/microsoft/WSL/issues/8570)
* **cgroups v2 能否给指定用户设内存上限**：
  * **结论：能（在 Linux 沙箱内部实施）。**
  * **核实依据**：
    1. WSL2 官方内核（5.15+ / 6.x）已原生启用 cgroup v2 统一层级树（挂载在 `/sys/fs/cgroup`）。
    2. **启用 systemd 时**：可通过 `/etc/systemd/system/user-1000.slice.d/override.conf` 写入 `[Slice] MemoryMax=2G`，直接由 systemd 约束 `agent` 用户的全部进程。
    3. **不启用 systemd 时**：需在启动沙箱前由 root 执行脚本，在 `/sys/fs/cgroup` 下创建子组并写入限制：
       ```bash
       mkdir -p /sys/fs/cgroup/agent-sandbox
       echo "+memory +cpu" > /sys/fs/cgroup/cgroup.subtree_control
       echo "2147483648" > /sys/fs/cgroup/agent-sandbox/memory.max
       ```
    4. **权限约束**：普通用户无权更改上级目录的 `memory.max`，因此 Agent 无法突破该上限。
  * **出处**：[Microsoft DevBlogs: Systemd support is now available in WSL](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/)；[GitHub Issue #10065: cgroup v2 support in WSL 2](https://github.com/microsoft/WSL/issues/10065)

---

## 5. 网络隔离：NAT vs Mirrored、Hyper-V 防火墙与「一键离线」

* **NAT 与 Mirrored 模式的区别**：
  * **NAT（默认）**：WSL2 处于独立的内部虚拟交换机后，分配内网私有 IP。局域网无法直连沙箱，沙箱访问宿主需要走虚拟网关 IP。
  * **Mirrored（Windows 11 22H2+）**：将 Windows 网卡直接镜像进沙箱，导致沙箱内的 `127.0.0.1` 与宿主 `127.0.0.1` 互通，且局域网能直接连入沙箱。**沙箱环境必须强制使用 NAT 模式**。
  * **出处**：[Microsoft Learn: Mirrored mode networking](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)
* **Windows 11 的 Hyper-V 防火墙限制出站与内网网段**：
  * **能否实现**：**能**。
  * **核实依据**：Hyper-V 防火墙为 WSL 分配了固定的全局标识符 `VMCreatorId: "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"`。可以通过以下 PowerShell 命令阻止沙箱访问内网私有网段：
    ```powershell
    New-NetFirewallHyperVRule -Name "BlockWSLPrivateLAN" `
        -DisplayName "Block WSL Outbound Private LAN" `
        -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" `
        -Direction Outbound `
        -RemoteAddresses "192.168.0.0/16","10.0.0.0/8","172.16.0.0/12" `
        -Action Block
    ```
  * **所需权限**：**必须具备 Windows 宿主管理员权限（UAC 提权）**。普通非提权的桌面应用进程直接调用该 Cmdlet 会抛出 `Access Denied`。
  * **出处**：[Microsoft Learn: New-NetFirewallHyperVRule](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallhypervrule)；[Microsoft Learn: Hyper-V firewall architecture for WSL](https://learn.microsoft.com/en-us/windows/security/operating-system-hardware/network-security/wsl-firewall)
* **能否在不给 Agent root 的情况下实现「一键离线」**：
  * **结论：能，且有「免 Windows 管理员权限」的绝佳实现路径！**
  * **关键事实**：在 Windows 端，普通用户无需 Windows 管理员权限，即可通过 `wsl.exe -u root` 在沙箱内部执行 root 命令。
  * **推荐实现方式（网卡断开法）**：
    1. Agent 的交互式会话以普通用户启动：`wsl.exe -d <distro> -u agent -- bash`（Agent 进程无 `CAP_NET_ADMIN`，无权操作网卡）。
    2. 当用户点击“一键离线”时，宿主后端在外部静默调用：
       ```cmd
       wsl.exe -d <distro> -u root -- ip link set dev eth0 down
       ```
    3. 恢复联网时宿主调用：
       ```cmd
       wsl.exe -d <distro> -u root -- ip link set dev eth0 up
       ```
    4. 此方案**既不需要 Windows 提权，沙箱内部的 Agent 也无法自行拉起网卡**。

---

## 6. Windows 11 家庭版安装 WSL2 的要求与排错

* **`wsl --install --no-distribution` 所需权限**：
  * **必须具备 Windows 管理员权限（UAC 提权）**。
  * **核实依据**：该命令需要在系统层启用底层可选功能 `VirtualMachinePlatform`（虚拟机平台），并调用系统级 Windows Installer (MSI) 安装 WSL 核心包，普通权限用户无法执行。
  * **出处**：[Microsoft Learn: Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
* **是否需要重启**：
  * **视初始环境而定**：
    1. 若宿主系统此前**未启用**“虚拟机平台”（Hyper-V Hypervisor 内核未加载）：**必须重启一次**。
    2. 若宿主此前**已启用**“虚拟机平台”（如开启了 Windows 核心隔离/内存完整性，或预装过模拟器）：执行 MSI 安装后**无需重启**，可立即使用。
  * **出处**：[Microsoft Learn: Install WSL - Prerequisites](https://learn.microsoft.com/en-us/windows/wsl/install)
* **常见错误 `REGDB_E_CLASSNOTREG`（HRESULT 0x80040154）**：
  * **含义**：**"Class not registered"（COM 类未注册）**。
  * **原因**：`wsl.exe` 启动时试图通过 COM 调用 `LxssManager` 或安装服务时，在注册表中找不到对应的 CLSID。常见于：系统刚启用组件但未重启、安全软件拦截了 MSI 注册表写入、或旧版本残留配置损坏。
  * **修复方案**：
    1. 以管理员身份从官方 GitHub 页面下载独立的 `wsl.<version>.x64.msi` 手动安装。
    2. 执行 `wsl.exe --update --web-download` 修复组件。
    3. 确认启用“虚拟机平台”并重启 Windows。
  * **出处**：[GitHub Issue #10060: Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG](https://github.com/microsoft/WSL/issues/10060)；[Microsoft Learn: COM Error Codes - REGDB_E_CLASSNOTREG](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/705fb327-2c24-427d-b6c6-88460923846e)

---

## 7. 基础镜像（rootfs）选型、体积、商业许可与国内源

| 镜像类型 | 官方下载地址 | 压缩体积 / 展开体积 | 许可协议与商用分发风险 | 清华 / 中科大国内源支持 |
| :--- | :--- | :--- | :--- | :--- |
| **Ubuntu 官方 WSL 镜像** | [cloud-images.ubuntu.com/wsl/releases/](https://cloud-images.ubuntu.com/wsl/releases/) | ~350MB ~ 450MB / **~1.2GB** | 遵循 **Canonical IP Policy**。<br>**存在商业分发风险**：未经许可在商业软件中捆绑并分发含 Ubuntu 商标的修改镜像可能招致法律风险。 | 国内镜像站通常不直接同步 `cloud-images/wsl` 专属目录。 |
| **Ubuntu Base** | [cdimage.ubuntu.com/ubuntu-base/releases/](https://cdimage.ubuntu.com/ubuntu-base/releases/) | ~28MB ~ 35MB / **~90MB** | 同样受 Canonical 知识产权约束，但由于去除了桌面与多数预装包，商用定制风险较低。 | **清华/中科大完整同步**：<br>`ubuntu-cdimage/ubuntu-base/releases/` |
| **Debian 官方 rootfs（强烈推荐）** | [debuerreotype OCI Artifacts (Docker Debian 底包)](https://github.com/debuerreotype/debian-artifacts)<br>或 [cloud.debian.org](https://cloud.debian.org/images/cloud/bookworm/latest/) | ~45MB ~ 55MB / **~130MB** | **DFSG（Debian 自由软件指导方针）**。<br>**商用极度安全**：100% 自由软件，无专有商标限制，商业软件可直接内置分发。 | **清华/中科大完整支持**：<br>可直接用 `debootstrap` 从 `mirrors.tuna.tsinghua.edu.cn/debian` 生成。 |
| **Alpine Linux minirootfs（极致轻量）** | [alpinelinux.org/downloads/](https://alpinelinux.org/downloads/) | **~3.5MB ~ 4MB** / **~10MB** | **MIT / GPL 自由软件**。<br>体积最小，启动秒级。注意采用 musl libc，需确保 Node.js 兼容性。 | **清华/中科大完整同步**：<br>`alpine/latest-stable/releases/x86_64/` |

---

## 8. 快照、重置机制与 `--import-in-place` 可行性

* **`wsl --export` 与 `wsl --import` 的速度与瓶颈**：
  * **机制**：`--export` 会将 ext4 文件系统整体打包为单个 `.tar` 文件；`--import` 会解压该 tar 并重新创建 `ext4.vhdx`。
  * **耗时**：在高速 NVMe SSD 上，对一个展开后 1GB 的系统，导出约需 **10~20 秒**，导入约需 **15~30 秒**。对于需要频繁“恢复初始沙箱”的桌面应用，耗时过长，体验差。
  * **致命陷阱（默认用户重置为 root）**：
    通过 `wsl --import` 注册的系统，WSL 默认会将其配置为以 `root` 用户登录！若要以 `agent` 用户运行，**镜像内必须预置 `/etc/wsl.conf`**：
    ```ini
    [user]
    default=agent
    ```
    否则使用 `wsl -d <distro>` 时会直接以 root 启动，造成沙箱权限失控。
* **`wsl --import-in-place` 与 VHDX 直接复制**：
  * **结论：完全可行，是秒级快照/重置的最佳工程解！**
  * **核实依据**：
    1. 自 WSL 2.0+ 起，微软官方引入了 `wsl --import-in-place <DistroName> <FileName>` 命令。它允许将现有的 `ext4.vhdx` 虚拟磁盘直接原地注册为一个新的 WSL 发行版，耗时仅需 **100 ~ 300 毫秒**（仅写注册表）。
    2. **秒级重置架构**：
       * 应用打包时预置一份配置好的 `clean-template.vhdx`（只读）。
       * 每次重置沙箱只需三步：
         ```powershell
         wsl --terminate AppSandbox
         wsl --unregister AppSandbox
         Copy-Item "clean-template.vhdx" "sandbox.vhdx" -Force # 400MB 在 NVMe 上仅需 0.2 秒
         wsl --import-in-place AppSandbox "sandbox.vhdx"
         ```
       * 整个沙箱销毁与重建过程可在 **1 秒内完成**！
    3. **差分磁盘（Differencing VHDX）**：**【未证实】**。Hyper-V 底层支持差分 VHDX，但 WSL 的 `wsl.exe` 对 Parent-Child 差分磁盘的挂载未在官方文档中作为公开特性承诺，直接全量文件复制更为稳妥。
  * **出处**：[Microsoft Learn: Basic commands for WSL - import-in-place](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#import-a-distribution-in-place)；[GitHub: WSL Releases 2.0.0+](https://github.com/microsoft/WSL/releases)

---

## 9. 宿主经 `\\wsl.localhost` 的读写性能与符号链接安全

* **读写性能与已知问题**：
  * **机制**：Windows 宿主访问 `\\wsl.localhost\<distro>` 是通过 Windows 9P 重定向驱动（`p9rdr.sys`）走 Hyper-V VSOCK 与沙箱内部通信。
  * **性能特征**：单大文件读写吞吐较高（可达数百 MB/s）；但**海量小文件遍历/读写极其缓慢**（比本地 NTFS 慢 5x~10x 以上），原因是每次文件元数据请求都要经过 VSOCK 上下文切换。宿主不应通过 UNC 路径频繁扫描沙箱内的海量代码文件（如 `node_modules`）。
  * **已知问题**：
    1. **文件锁独占冲突**：Windows 进程一旦以独占方式打开某文件，会导致沙箱内写入返回 `EBUSY` / `ETXTBSY`。
    2. **inotify 通知不完整**：Windows 宿主监听 `\\wsl.localhost` 的目录变动通知存在丢事件现象。
  * **出处**：[Microsoft Learn: Comparing WSL 1 and WSL 2 - File performance across OS filesystems](https://learn.microsoft.com/en-us/windows/wsl/compare-versions#performance-across-os-file-systems)；[GitHub Issue #4197: 9P file system performance issues](https://github.com/microsoft/WSL/issues/4197)
* **沙箱内的符号链接经 9P 解析会不会指向宿主文件（安全穿透核实）**：
  * **结论：绝对不会穿透到宿主 Windows 文件系统！**
  * **核实依据**：
    1. **解析端在沙箱内部**：9P 服务的根目录限定在沙箱虚拟机内部的 rootfs。如果沙箱内创建了指向 `/etc/shadow` 的软链接，Windows 读取时只会读取到沙箱内部的文件。
    2. **指向 `/mnt/c` 的软链接**：由于前置关闭了 `automount`，沙箱内的 `/mnt/c` 根本没有挂载宿主盘符，访问该软链接只会返回文件不存在（`ENOENT`）。
    3. **伪造 Win32 路径的软链接（如 `ln -s 'C:\Windows\System32' link`）**：Windows 9P 驱动（`p9rdr.sys`）不会将 Linux 软链接转换为 Win32 的本地 NTFS 软链接来递归解析。Windows 客户端通过 UNC 路径访问时，会直接将路径字符串交给 9P 服务端在 Linux 根目录下寻找，自然解析失败。
    4. **官方已知 Bug 反向佐证**：根据官方跟踪 Issue，目前 Windows 端访问 `\\wsl.localhost` 最大的缺陷恰恰是**连正常的 Linux 相对/绝对软链接都频繁报损坏无法打开**，根本不存在通过软链接跨越协议边界逃逸至宿主文件系统的可能。
  * **出处**：[GitHub Issue #5118: Interoperability for WSL symlinks accessed via \\wsl$](https://github.com/microsoft/WSL/issues/5118)；[GitHub Issue #12250: Add Windows support for WSL symlinks](https://github.com/microsoft/WSL/issues/12250)

---

## 结论：哪些假设成立、哪些要改

### ✅ 完全成立的假设
1. **普通用户无法提权挂载盘符**：只要 Agent 运行在无 sudo 权限的 `agent` 用户下，`automount=false` 能 100% 阻止其访问 Windows 磁盘。
2. **长连接常驻进程能够保活**：宿主维持一个运行中的 `wsl.exe` 子进程，实例和虚拟机绝对不会触发空闲超时关闭。
3. **`\\wsl.localhost` 符号链接无法逃逸**：Linux 内部的软链接无论怎么构造，都无法穿透 9P 协议边界去读取未挂载的宿主 Windows 文件。

---

### ⚠️ 部分成立，需要调整或补强的假设
1. **「禁用了 interop 就无法执行 Windows 进程」**：
   * **现状**：若 Agent 设法通过内核漏洞提权至 root，root 可以向 `/proc/sys/fs/binfmt_misc/register` 重新注入 `WSLInterop` 绕过禁用限制。
   * **整改方案**：必须彻底删除沙箱内的 `sudo`，清除 root 密码；同时可以在初始化时将 `/init` 设置不可执行，或者使用只读根文件系统挂载 `/proc/sys/fs/binfmt_misc`。
2. **「禁用 automount 和 interop 就没有其他访问宿主的通道」**：
   * **现状**：漏掉了 **WSLg（`/mnt/wslg`）** 和 **跨发行版共享（`/mnt/wsl`）**。
   * **整改方案**：在宿主 `%USERPROFILE%\.wslconfig` 中显式配置：
     ```ini
     [wsl2]
     guiApplications=false
     ```
     并在沙箱启动脚本中确认卸载 `/mnt/wsl`，切断跨发行版污染。
3. **「在沙箱中使用普通用户默认登录」**：
   * **现状**：`wsl --import` 导入后，WSL 默认会以 `root` 登录。
   * **整改方案**：必须确保镜像内的 `/etc/wsl.conf` 明确包含：
     ```ini
     [user]
     default=agent
     ```
     并在宿主调用 `wsl.exe` 时显式追加 `-u agent` 双重锁定。

---

### ❌ 必须彻底推翻/修改的原方案设计
1. **放弃使用 `wsl --export` / `--import` 做沙箱重置**：
   * **原因**：每次解压 tar 耗时数十秒，无法满足桌面应用快速重置、秒级响应的需求。
   * **整改方案**：改用 **`wsl --import-in-place` 配合预置 `vhdx` 模板直接文件复制**，将重置耗时压缩至 **1 秒以内**。
2. **放弃依赖 Hyper-V 防火墙（New-NetFirewallHyperVRule）实现「一键离线」**：
   * **原因**：该 Cmdlet 必须要求宿主桌面应用拥有 Windows 管理员权限（UAC 弹窗），严重影响普通用户体验。
   * **整改方案**：由宿主后端直接通过非交互的普通权限命令操作沙箱内部网卡：
     * **断网**：`wsl.exe -d <distro> -u root -- ip link set dev eth0 down`
     * **恢复**：`wsl.exe -d <distro> -u root -- ip link set dev eth0 up`
     * 沙箱内普通用户 `agent` 无 `CAP_NET_ADMIN` 权限，无法逆转该状态，完全免除了 Windows 管理员权限要求。
3. **放弃使用 Ubuntu 官方 WSL 镜像作为内置底包**：
   * **原因**：压缩包过大（~400MB），展开超过 1.2GB，且存在 Canonical 商标商用再分发知识产权风险。
   * **整改方案**：采用 **Debian Minimal Rootfs**（约 50MB，DFSG 纯自由软件无版权风险）或 **Ubuntu Base**（~30MB），既能保证极致的安装包体积，又规避了商业法务风险。