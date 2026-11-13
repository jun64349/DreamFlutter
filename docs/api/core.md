# 后台、设置与首次运行

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## app.exitState
<!-- api:method -->

- **用途** 读取窗口退出时需要提示的后台活动。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ busy: boolean; conversations: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [update/module.ts:105](../../core/src/update/module.ts#L105)

## app.setStartup
<!-- api:method -->

- **用途** 修改 Windows 登录启动注册。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `enabled?: boolean`（启用开关）
- **返回** `UpdateStatus`，包括 startOnLogin 与 canStartup。
- **错误** 开发运行或系统启动项修改失败会抛 UpdateError，WebSocket 编码为 `internal`。
- **事件** 成功保存启停偏好且值变化时发 `settings.changed`。
- **开放范围** 仅内部。
- **源码** [update/module.ts:106](../../core/src/update/module.ts#L106)

## core.activity
<!-- api:method -->

- **用途** 列出打开中、运行中或正在压缩的会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ running: SlotInfo[]; count: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:743](../../core/src/core.ts#L743)

## core.hello
<!-- api:method -->

- **用途** 读取后台、当前会话、设置和恢复提示。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ version: string; piVersion: string | null; pid: number; port: number; dataDir: string; butterflyHome: string; agentDir: string; sessionDir: string; slots: SlotInfo[]; settings: CoreSettings; interruptedRuns: Run[]; pendingConfirmations: Confirmation[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。 返回本次连接时的快照。连接后用 slot.attach 获取会话内待答交互与实时状态。
- **开放范围** 仅内部。
- **源码** [core.ts:714](../../core/src/core.ts#L714)

## core.notify
<!-- api:method -->

- **用途** 按通知策略异步提交一条手动提醒。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `title: string`（显示标题）；`body?: string`
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 无专属窗口推送。返回表示已交给通知中心，后续按通知策略异步进行系统投递。
- **开放范围** 仅内部。
- **源码** [core.ts:733](../../core/src/core.ts#L733)

## core.shutdown
<!-- api:method -->

- **用途** 应答后安排后台退出。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。 约 50 毫秒后调度退出。调用成功表示已安排退出。
- **开放范围** 仅内部。
- **源码** [core.ts:728](../../core/src/core.ts#L728)

## core.startup
<!-- api:method -->

- **用途** 读取启动进度。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `StartupState`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:742](../../core/src/core.ts#L742)

## notifications.presence
<!-- api:method -->

- **用途** 登记当前连接是否在前台以及正在看的 slot。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `foreground?: boolean`（窗口在前台）；`slotId?: string`（活动会话槽 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（需要窗口连接和前台状态）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:744](../../core/src/core.ts#L744)

## packageSources.status
<!-- api:method -->

- **用途** 查看包源选择、预设和最近使用记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）
- **返回** `{ nextHost: SourceSnapshot; recent: Partial<Record<"host" | "sandbox", SourceSnapshot>>; python: { readonly inherit: null; readonly pypi: "https://pypi.org/simple"; readonly tuna: "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"; readonly ustc: "https://mirrors.ustc.edu.cn/pypi/simple"; }; npm: { readonly inherit: null; readonly npm: "https://registry.npmjs.org"; readonly npmmirror: "https://registry.npmmirror.com"; }; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/package-sources.ts:12](../../core/src/modules/package-sources.ts#L12)

## settings.get
<!-- api:method -->

- **用途** 读取完整设置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `CoreSettings`，见数据结构。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:741](../../core/src/core.ts#L741)

## settings.update
<!-- api:method -->

- **用途** 校验并合并设置补丁。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** CoreSettings 的部分字段，可省略所有键；仅保存校验通过的值
- **返回** `CoreSettings`（完整的合并结果）。
- **错误** 未知或无效值忽略；写入异常经 WebSocket 返回 `internal`。
- **事件** [`settings.changed`](events.md#settingschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 只合并合法且确实变化的字段，未知或无效键静默略过。提交后同步推送 settings.changed。
- **开放范围** 仅内部。
- **源码** [core.ts:749](../../core/src/core.ts#L749)

## setup.complete
<!-- api:method -->

- **用途** 保存初次设置并给出重启要求。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** SetupInput，字段见数据结构
- **返回** `{ alreadyCompleted: boolean; restartRequired: boolean; completed: boolean; dataRoot: string; userName: string; defaultWorkspace: string | null; models: { conversation: string | null; small: string | null; large: string | null; vision: string | null; }; sandbox: "now" | "later"; locations: unknown; } | { channelId: string | null; restartRequired: boolean; sandboxStatus: unknown; completed: boolean; dataRoot: string; userName: string; defaultWorkspace: string | null; models: { conversation: string | null; small: string | null; large: string | null; vision: string | null; }; sandbox: "now" | "later"; locations: unknown; }`。
- **错误** `bad_request`（数据位置、称呼、模型等输入不合法），`busy`（首次设置正在保存或后台正在维护），`not_found`（引用的渠道不存在），`unavailable`（请求立即准备沙箱但当前系统没有沙箱模块）。
- **事件** 设置值有变化时发 `settings.changed`。选择立即准备沙箱时，准备过程还会推送 `sandbox.changed`。
- **开放范围** 仅内部。
- **源码** [modules/setup.ts:27](../../core/src/modules/setup.ts#L27)

## setup.recommendModels
<!-- api:method -->

- **用途** 推荐该渠道的对话及辅助模型。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `channel: string`（渠道 ID）
- **返回** `SetupModels`。
- **错误** `bad_request`（缺渠道 ID）；`not_found`（渠道不存在或没有可用于对话的模型）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/setup.ts:29](../../core/src/modules/setup.ts#L29)

## setup.status
<!-- api:method -->

- **用途** 读取初次设置进度及所选模型。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ completed: boolean; dataRoot: string; userName: string; defaultWorkspace: string | null; models: { conversation: string | null; small: string | null; large: string | null; vision: string | null; }; sandbox: "now" | "later"; locations: unknown; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/setup.ts:26](../../core/src/modules/setup.ts#L26)

## setup.testChannel
<!-- api:method -->

- **用途** 按模型选择测试渠道。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `channel: string`（必填，渠道 ID）；`model?: string`（模型 ID）。
- **返回** 与 gateway.testChannel 相同，`{ok:boolean,latencyMs:number,model:string|null,reply?:string,error?:string}`。
- **错误** `bad_request`（缺渠道 ID）；`not_found`（找不到渠道）；模型测试失败按 `gateway.testChannel` 的业务结果报告。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/setup.ts:28](../../core/src/modules/setup.ts#L28)

## setup.validateDataRoot
<!-- api:method -->

- **用途** 检查数据目录及可用空间并给出启动参数。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `path: string`（文件或目录路径）
- **返回** `{ path: string; exists: boolean; freeBytes: number; launchArgs: string[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/setup.ts:30](../../core/src/modules/setup.ts#L30)
