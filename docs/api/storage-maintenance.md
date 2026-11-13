# 沙箱、存储、备份、更新与 Git

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## backup.ackResult
<!-- api:method -->

- **用途** 确认已看过恢复结果。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:297](../../core/src/backup/backup.ts#L297)

## backup.apply
<!-- api:method -->

- **用途** 请求应用已暂存的恢复。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `prefs?: object`（界面偏好）
- **返回** `Job`。
- **错误** `not_staged`（请先检查备份包）。
- **事件** [`backup.job`](events.md#backupjob)、[`backup.restarting`](events.md#backuprestarting)；按实际状态变化推送，次数与顺序见事件和本节说明。 恢复应用作业完成准备后发 backup.restarting，重启后通过 backup.restoreResult 读取结果。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:280](../../core/src/backup/backup.ts#L280)

## backup.cancel
<!-- api:method -->

- **用途** 请求取消当前备份作业。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:232](../../core/src/backup/backup.ts#L232)

## backup.delete
<!-- api:method -->

- **用途** 删除一个备份文件并重读历史。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** path: string（必填，历史中的备份文件）
- **返回** `HistoryEntry[]`。
- **错误** `not_found`（没有这个备份）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:319](../../core/src/backup/backup.ts#L319)

## backup.discardStaged
<!-- api:method -->

- **用途** 丢弃暂存的恢复。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:285](../../core/src/backup/backup.ts#L285)

## backup.export
<!-- api:method -->

- **用途** 创建备份导出作业。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `path?: string`（文件或目录路径）；`includeKeys?: boolean`；`password?: string`（备份密码）；`includeMaterials?: boolean`；`includeSandbox?: boolean`；`prefs?: Record<string, unknown>`（界面偏好）
- **返回** `Job`。
- **错误** `bad_request`（包含 API Key 时要设置至少 6 位的迁移密码）。
- **事件** [`backup.job`](events.md#backupjob)；按实际状态变化推送，次数与顺序见事件和本节说明。 返回作业快照。后续通过 backup.job 接收阶段和终态。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:236](../../core/src/backup/backup.ts#L236)

## backup.history
<!-- api:method -->

- **用途** 列出备份历史。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `HistoryEntry[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:318](../../core/src/backup/backup.ts#L318)

## backup.inspect
<!-- api:method -->

- **用途** 检查备份包并返回可恢复内容。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** path: string（必填，备份文件）
- **返回** 预览对象包含 `appVersion`、`dbVersion`、`kind`、`createdAt`、`host`、`user`、`credentials`、`needsPassword`、`sameUser`、`counts`、`includes`、`size`、`paths`、`replaces`、`warnings`。
- **错误** `bad_request`（请选择备份文件）；`bad_backup`。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:256](../../core/src/backup/backup.ts#L256)

## backup.job
<!-- api:method -->

- **用途** 读取当前备份作业和进度。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `Job | null`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:231](../../core/src/backup/backup.ts#L231)

## backup.overview
<!-- api:method -->

- **用途** 读取备份目录、内容概况与恢复信息。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** 对象包含 `busy`、`estimate`、`estimateText`、`materialsCount`、`materialsWarning`、`sandbox`、`sandboxDiskBytes`、`backupsDir`、`autoBytes`、`freeBytes`、`job`、`history`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:230](../../core/src/backup/backup.ts#L230)

## backup.restoreResult
<!-- api:method -->

- **用途** 读取上次恢复结果。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `RestoreOutcome | null`。结果含 ok、at、可选 error，以及回退和界面偏好等恢复元数据。无可读结果时返回 null。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:290](../../core/src/backup/backup.ts#L290)

## backup.stage
<!-- api:method -->

- **用途** 校验并暂存一次恢复。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** path: string（必填）；workspaces?: {from: string, to: string}[]；password?: string
- **返回** `Job`。
- **错误** `bad_request`（请选择备份文件）。
- **事件** [`backup.job`](events.md#backupjob)；按实际状态变化推送，次数与顺序见事件和本节说明。 返回作业，需等暂存成功后调用 backup.apply。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:267](../../core/src/backup/backup.ts#L267)

## backup.undo
<!-- api:method -->

- **用途** 以恢复前的回退点启动撤销。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `prefs?: object`（界面偏好）
- **返回** `Job`。
- **错误** `not_found`（找不到导入前的自动备份，无法撤销）。
- **事件** [`backup.job`](events.md#backupjob)、[`backup.restarting`](events.md#backuprestarting)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:306](../../core/src/backup/backup.ts#L306)

## git.commit
<!-- api:method -->

- **用途** 验证预览并提交选中的改动。
- **调用方** 窗口，工作台。
- **参数** cwd、message: string（必填）；paths: string[]（选中路径）；expectedHead?: string 或 null；expectedFingerprint?: string；expectedPaths?: string[]
- **返回** Git 结果信封，成功附提交信息，失败附 code、reason 和可选 recoveryPoint。
- **错误** 参数和 Git 执行失败通常在 result 中返回 `ok:false`、`code` 与 `reason`，例如预览已过期。
- **事件** 没有专属于本方法的推送。 重新校验预览与所选文件；提交只包含选中改动。失败用 result.ok:false、code、reason 及可选恢复点。
- **开放范围** 仅内部。
- **源码** [git/window.ts:45](../../core/src/git/window.ts#L45)

## git.diff
<!-- api:method -->

- **用途** 读取选定路径的 Git 差异。
- **调用方** 窗口，工作台。
- **参数** cwd: string（必填）；paths?: string[]（指定路径）
- **返回** 成功时为 `{ ok: true; root: string; diff: string; paths: string[]; fingerprint: string; head: string | null }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [git/window.ts:24](../../core/src/git/window.ts#L24)

## git.prepareCommit
<!-- api:method -->

- **用途** 准备所选路径的提交预览与文案。
- **调用方** 窗口，工作台。
- **参数** cwd: string（必填）；paths?: string[]（指定路径）
- **返回** 成功时返回 `git.diff` 的字段以及 `suggestedMessage: string` 和 `draftReason: string | null`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。 返回预览、预览指纹和建议提交文案；小任务模型不可用时文案可为空并附 draftReason。
- **开放范围** 仅内部。
- **源码** [git/window.ts:25](../../core/src/git/window.ts#L25)

## git.status
<!-- api:method -->

- **用途** 读取工作区 Git 状态。
- **调用方** 窗口，工作台。
- **参数** cwd: string（必填，绝对工作区路径）
- **返回** 成功时含 `ok`、`available`、`isRepository`、`branch`、`files`、`dirty`、`conflicts`、`operation` 等；输入或 Git 失败通过结果信封报告。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [git/window.ts:20](../../core/src/git/window.ts#L20)

## sandbox.provision
<!-- api:method -->

- **用途** 开始准备蝶君沙箱。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `SandboxStatus`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`sandbox.changed`](events.md#sandboxchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:259](../../core/src/sandbox/sandbox.ts#L259)

## sandbox.remove
<!-- api:method -->

- **用途** 移除蝶君沙箱。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `SandboxStatus`。
- **错误** `unavailable`，WSL 注销未成功，沙箱目录保留。删除目录失败按通用 `internal` 返回。
- **事件** [`sandbox.changed`](events.md#sandboxchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:273](../../core/src/sandbox/sandbox.ts#L273)

## sandbox.reset
<!-- api:method -->

- **用途** 重置蝶君沙箱。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `SandboxStatus`。恢复干净快照并注册成功后清除上一次准备失败的错误、步骤和进度。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`sandbox.changed`](events.md#sandboxchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:263](../../core/src/sandbox/sandbox.ts#L263)

## sandbox.selfTest
<!-- api:method -->

- **用途** 运行沙箱自检并返回逐项结果。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ items: SelfTestItem[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:267](../../core/src/sandbox/sandbox.ts#L267)

## sandbox.setOnline
<!-- api:method -->

- **用途** 切换沙箱联网开关。
- **调用方** 窗口或后台，蝶君。
- **参数** `online?: boolean`（联网开关）
- **返回** `SandboxStatus`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 联网偏好改变时发 `settings.changed`。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:268](../../core/src/sandbox/sandbox.ts#L268)

## sandbox.status
<!-- api:method -->

- **用途** 读取蝶君沙箱状态。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `SandboxStatus`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:258](../../core/src/sandbox/sandbox.ts#L258)

## security.addException
<!-- api:method -->

- **用途** 登记一条路径安全例外。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）；`path?: string`（文件或目录路径）
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 路径例外设置变化时发 `settings.changed`。
- **开放范围** 仅内部。
- **源码** [security/service.ts:37](../../core/src/security/service.ts#L37)

## security.audit
<!-- api:method -->

- **用途** 分页读取安全审计记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `before?: number`（向更早的数据翻页）；`limit?: number`（最多返回条数）；`kind?: string`（类别）
- **返回** `{ events: AuditEvent[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [security/service.ts:47](../../core/src/security/service.ts#L47)

## security.exceptions
<!-- api:method -->

- **用途** 列出工作区已有的安全例外路径。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）
- **返回** `{ paths: string[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [security/service.ts:36](../../core/src/security/service.ts#L36)

## security.export
<!-- api:method -->

- **用途** 导出经过遮蔽的安全审计文本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ name: string; text: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [security/service.ts:48](../../core/src/security/service.ts#L48)

## security.removeException
<!-- api:method -->

- **用途** 撤销指定路径安全例外。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）；`path?: string`（文件或目录路径）
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 路径例外设置变化时发 `settings.changed`。
- **开放范围** 仅内部。
- **源码** [security/service.ts:41](../../core/src/security/service.ts#L41)

## storage.compactMemory
<!-- api:method -->

- **用途** 清理记忆历史并压缩数据库。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ databaseBytes: number; space: { paused: boolean; freeBytes: number | null; minimumBytes: number; reason: string | null; }; logicalBytes: number; versions: number; path: string; deleted: number; backup: string; }`。
- **错误** `busy`（请等对话和记忆后台任务结束后再压缩历史）；`storage_paused`。
- **事件** 压缩成功后发一次 `memory.changed`，其中 `batchId` 为 null。
- **开放范围** 仅内部。
- **源码** [storage/storage.ts:42](../../core/src/storage/storage.ts#L42)

## storage.locations
<!-- api:method -->

- **用途** 列出数据位置、移动能力和现有作业状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ rows: { id: "sessions" | "sandbox" | "database" | "configuration" | "secrets" | "logs" | "skills" | "templates" | "cards" | "cache"; label: string; path: string; movable: boolean; bytes: number; layer: string; }[]; artifacts: { path: string; bytes: number | null; movable: boolean; }[]; memory: { path: string; moveKind: string; logicalBytes: number; versions: number; }; lastMove: unknown; note: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [storage/storage.ts:27](../../core/src/storage/storage.ts#L27)

## storage.memory
<!-- api:method -->

- **用途** 读取记忆占用和存储暂停状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ databaseBytes: number; space: { paused: boolean; freeBytes: number | null; minimumBytes: number; reason: string | null; }; logicalBytes: number; versions: number; path: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [storage/storage.ts:41](../../core/src/storage/storage.ts#L41)

## storage.move
<!-- api:method -->

- **用途** 移动可迁移的数据位置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `kind?: StorageKind`（类别）；`target?: string`（目标位置）
- **返回** `{ id: string; restarting: boolean; restartRequired: boolean; }`。
- **错误** `busy`（沙箱正在准备，请完成后再搬迁）；`bad_request`（需要数据类别和目标目录）。
- **事件** [`storage.restarting`](events.md#storagerestarting)；按实际状态变化推送，次数与顺序见事件和本节说明。 数据可能移动后要求重启。确需重启时发 storage.restarting。
- **开放范围** 仅内部。
- **源码** [storage/storage.ts:28](../../core/src/storage/storage.ts#L28)

## updates.cancel
<!-- api:method -->

- **用途** 取消可中止的更新操作。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `UpdateStatus`，见数据结构。
- **错误** 更新已准备退出且不可取消时经 WebSocket 返回 `internal`。
- **事件** [`updates.changed`](events.md#updateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [update/module.ts:93](../../core/src/update/module.ts#L93)

## updates.check
<!-- api:method -->

- **用途** 检查可用更新。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `UpdateStatus`，见数据结构。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`updates.changed`](events.md#updateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [update/module.ts:80](../../core/src/update/module.ts#L80)

## updates.diagnostics
<!-- api:method -->

- **用途** 生成更新诊断包。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ path: string; files: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:102](../../core/src/update/module.ts#L102)

## updates.download
<!-- api:method -->

- **用途** 下载更新候选。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `UpdateStatus`，见数据结构。
- **错误** 未检查到更新、下载已在进行或磁盘空间不足等前置条件失败经 WebSocket 返回 `internal`；下载过程错误见返回的 `state`。
- **事件** [`updates.changed`](events.md#updateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [update/module.ts:81](../../core/src/update/module.ts#L81)

## updates.install
<!-- api:method -->

- **用途** 启动更新安装、窗口关闭和数据保护流程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `windowPid: number`（必填，合法的整数进程标识）；`approveUnsigned?: boolean`；`prefs?: object`。
- **返回** `UpdateStatus`，准备动作会异步继续。
- **错误** 维护、准备重复、未下载、窗口 PID 无效或签名确认缺失会抛 UpdateError，WebSocket 编码为 `internal`。
- **事件** [`updates.changed`](events.md#updateschanged)、[`updates.closeWindow`](events.md#updatesclosewindow)；按实际状态变化推送，次数与顺序见事件和本节说明。 等待运行中的任务并通知窗口关闭。updates.changed 通知阶段，updates.closeWindow 请求关闭，安装继续异步运行。
- **开放范围** 仅内部。
- **源码** [update/module.ts:82](../../core/src/update/module.ts#L82)

## updates.licenses
<!-- api:method -->

- **用途** 读取随包许可证清单。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ generated: boolean; entries: unknown[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:103](../../core/src/update/module.ts#L103)

## updates.licenseText
<!-- api:method -->

- **用途** 读取指定许可证正文。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id?: string`（对象标识）
- **返回** `{ text: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:104](../../core/src/update/module.ts#L104)

## updates.status
<!-- api:method -->

- **用途** 读取更新状态与进度。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `UpdateStatus`，见数据结构。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:79](../../core/src/update/module.ts#L79)

## updates.uiReady
<!-- api:method -->

- **用途** 报告候选窗口就绪。
- **调用方** 更新后的候选窗口，内部。
- **参数** `nonce: string`、`version: string`、`pid: number`，均必填。
- **返回** `{ready:true}`。
- **错误** 窗口进程或版本未通过检查时抛 `UpdateError('validation_failed')`，WebSocket 编码为 `internal`。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:95](../../core/src/update/module.ts#L95)

## updates.validateReady
<!-- api:method -->

- **用途** 验证候选后台启动并写就绪标记。
- **调用方** 更新验证流程，内部。
- **参数** `nonce: string`（当前更新日志中的握手标识）。
- **返回** `{verified:true,version:string}`。
- **错误** `waiting_window`（候选窗口尚未完成首帧确认）；`validation_failed`（版本、数据位置、完整性或验证阶段不匹配）。
- **事件** 完成验证后发 `updates.changed`，状态为 verified。恢复记忆暂停偏好时也可发 `settings.changed`。
- **开放范围** 仅内部。
- **源码** [update/module.ts:94](../../core/src/update/module.ts#L94)
