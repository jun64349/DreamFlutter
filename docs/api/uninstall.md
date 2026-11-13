# Windows 卸载

Velopack 安装版使用安装根目录下的 `data`。预演和钩子读取该安装的存储配置。正常卸载依次停后台、核对并停止已登记的沙箱、注销沙箱、删除虚拟磁盘和干净副本，再清理其余应用数据。系统 WSL、其他发行版和用户工作区文件保留。

## uninstall.preview

- **用途**：预演当前 Windows 安装的卸载目标，供 0.12 的确认界面使用。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：无。预演读取当前的保留数据标记。
- **返回**：`dataDir: string` 为安装数据根目录，`sandboxDir: string` 为沙箱目录，`distro?: string` 为记录中的发行版名，`preserveTo?: string` 为保留位置。`remove: {path: string, tree: boolean, kind: string}[]` 为当前存在的清理目标，`tree` 为真表示整个目录。`review: {path: string, reason: string}[]` 为需要核对的遗留项目。
- **错误**：`forbidden` 无已连接窗口，`unavailable` 当前后台不属于支持预演的 Windows 安装，`bad_config` 存储配置、标记或路径无法核实。
- **事件**：无。读取清单时不停止进程、不访问 WSL、不删除数据。执行时重新读取计划，并核对 WSL 注册磁盘。
- **开放范围**：仅内部。

## 保留数据标记

0.12 在需要保留数据时，以 UTF-8 写入 `<安装根>/data/uninstall-keep-data`，内容是 `1`，末尾允许换行。选择全部清除时移除标记。写完标记后可以再次调用 `uninstall.preview`。其他内容会报配置错误。

保留模式仍会注销沙箱并删除磁盘和干净副本。因为 Velopack 会删除整个安装根，钩子把数据移到与安装根同级的 `<安装根名>.preserved-data`，遇到现有同名目录加数字后缀。钩子消费标记，重写存储配置中原先位于 `data` 内的路径。搬到安装根之外的数据仍在原处。 [Velopack 保留文件说明](https://docs.velopack.io/integrating/preserved-files)

## uninstall.preservedData
<!-- api:method -->

- **用途**：查询当前安装旁可供恢复的保留数据。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：无。
- **返回**：`{ candidates: { path: string, bytes: number, savedAt: number }[] }`。大小是保留目录内文件字节总数，保存时间是 Unix 毫秒时间戳，最新优先。没有候选、不是安装版、当前已有数据或正在恢复时返回空数组。
- **错误**：`forbidden` 无已连接窗口，`unavailable` 无法读取候选目录。
- **事件**：无。
- **开放范围**：仅内部。

## uninstall.restorePreservedData
<!-- api:method -->

- **用途**：准备恢复指定候选并请求后台重启。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：`path: string`，必填，使用查询返回的候选路径。
- **返回**：`{ restarting: true }`，表示已提交重启切换，最终结果通过 `backup.restoreResult` 查询。
- **错误**：`forbidden` 无已连接窗口，`bad_request` 缺路径，`unavailable` 当前不是支持恢复的安装或准备失败，`busy` 后台有工作或恢复已在进行，`conflict` 当前已有数据，`not_found` 候选不可用，`bad_config` 布局不兼容、候选含外移目录或含未核对的更新或切换记录。
- **事件**：无专属推送。后台关闭，窗口按正常流程重新连接。
- **开放范围**：仅内部。

恢复只接受新安装的空白数据状态，允许后台启动生成的数据库和初始设置。先校验数据库，再在重启前准备副本，原保留目录留在原位。用户放弃恢复时无需调用任何接口。

## 清理范围和日志

- 搬迁后的目录由 `storage-locations.json` 决定。数据库、日志的外部目录只清理产品自己的文件。工作区路径和其他文件不作为清理目标。
- v0.3.1 数据仅在本安装的迁移记录成功、记录中的来源与旧路径一致，且旧目录的迁移标记反向指向本安装时清理。旧沙箱磁盘仍在时保留旧目录并记入核对项。共享 Pi 目录仅清除旧 DreamFlutter 数据库明确引用、位于其 `sessions` 树中的 JSONL 文件。
- 沙箱名只取 `distro.txt`，注销前比对 WSL 记录指向的磁盘与计划中的 `disk/ext4.vhdx`。注销失败会记录残留。磁盘删除尝试三次，仍被占用时日志记录具体路径，不登记重启删除。
- 日志为 `%TEMP%/dreamflutter-uninstall-*/uninstall.jsonl`，记录操作、状态、路径及失败原因。大目录先移出安装目录，再由系统 PowerShell 清理。按日志中的 `bulk.queue` 和 `bulk.remove` 核对计划与结果。
- Velopack 触发 `--veloapp-uninstall` 后调用本机钩子。钩子等待清理入口最多 25 秒，超时会返回失败，Velopack 仍会继续移除安装目录。 [Velopack 钩子](https://docs.velopack.io/integrating/hooks) · [Velopack 卸载顺序](https://docs.velopack.io/integrating/uninstalling)

