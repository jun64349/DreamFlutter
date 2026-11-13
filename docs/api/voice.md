# 语音输入

工作台和蝶君共用后台的一路识别。默认使用本机 SenseVoice-Small int8 + Silero，识别结果开启数字规整，切句会补回 VAD 起点前的音频。只有设置为云端模式时，才会将本次音频和最多 64 个热词发给选定的服务。后台不保存录音或转写历史。窗口按需要保留 `voice.final` 的原文和校正稿。

现有本机 WebSocket 接收 JSON 请求。音频为小端有符号 16 位 PCM、16 kHz、单声道，每块 100–200 ms（3,200–6,400 字节），使用标准带填充 Base64。窗口可先连续录音，等 `voice.start` 返回再按录制顺序发送。每次等前一块确认后再送下一块。末块不足 100 ms 时用零补足。

## voice.start

- **用途**：为当前窗口开始一路识别并等待提供方就绪。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：`workspaceId?: string` 为可选工作区 ID。选择此工作区与全局记忆中的热词，省略时只选全局。
- **返回**：`{ sessionId: string }`，后续请求使用该编号。
- **错误**：`busy` 已有一路正在启动或识别，`invalid_params` 工作区 ID 不合法，`forbidden` 无窗口连接或云端拒绝鉴权，`model_unavailable` 本地模型文件缺失，`unavailable` 服务未配置、连接失败或超时，`cancelled` 启动期间窗口断开。
- **事件**：启动失败由本次响应返回。成功后只给所属窗口推送语音事件。窗口断开时取消会话并释放识别名额。
- **开放范围**：将来可开放给模块。

## voice.chunk

- **用途**：向当前会话追加一个音频块。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：必填 `sessionId: string`、`pcm: string`，格式见上。
- **返回**：`{ accepted: true }`。
- **错误**：`forbidden` 无窗口连接，`not_found` 会话不存在或属于其他窗口，`invalid_params` 编码或长度有误，`busy` 前一个音频请求尚未完成，`unavailable` 提供方失败，`cancelled` 识别已取消。
- **事件**：可产生零到多个 `voice.partial` 和 `voice.final`。本机识别可能先发事件再确认该块，云端的确认与识别事件各自到达。
- **开放范围**：将来可开放给模块。

## voice.end

- **用途**：结束输入，识别最后一段并释放会话。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：必填 `sessionId: string`。
- **返回**：`{ ended: true }`。
- **错误**：`forbidden` 无窗口连接，`not_found` 会话不存在或不属于当前窗口，`busy` 仍在处理音频，`invalid_params` 未收到麦克风音频，`unavailable` 提供方失败或超时，`cancelled` 识别已取消。
- **事件**：尾段结果在成功返回前发送。结束失败时先发送 `voice.error` 再返回错误。
- **开放范围**：将来可开放给模块。

## voice.cancel

- **用途**：立即取消识别并丢弃未输出的尾段。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：必填 `sessionId: string`。
- **返回**：`{ cancelled: true }`。
- **错误**：`forbidden` 无窗口连接，`not_found` 会话不存在或不属于当前窗口。
- **事件**：无。已经送达的文字由调用方处理。
- **开放范围**：将来可开放给模块。

## voice.partial

- **用途**：更新当前句的临时预览。本机模型按语音长度间隔产生预览，短句可能直接返回最终结果。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：无。
- **返回**：事件必有 `event: "voice.partial"`、`sessionId: string`、`text: string`。用新预览覆盖本句上一个预览。
- **错误**：无。
- **事件**：每句零到多次。收到 `voice.final` 后清空当前预览。
- **开放范围**：将来可开放给模块。

## voice.final

- **用途**：追加一句带标点的最终文字。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：无。
- **返回**：事件必有 `event: "voice.final"`、`sessionId: string`、`text: string`（热词校正及补句末标点后）、`rawText: string`（提供方原文）。
- **错误**：无。
- **事件**：每个被识别的语音分句一次，按音频顺序。
- **开放范围**：将来可开放给模块。

## voice.error

- **用途**：说明识别途中发生的终止错误。
- **调用方**：窗口，工作台和蝶君共用。
- **参数**：无。
- **返回**：事件必有 `event: "voice.error"`、`sessionId: string`、`code: string`、`message: string`。
- **错误**：`invalid_params` 未收到音频，`unavailable` 服务中断、长时间未收到下一块或超时，`forbidden` 提供方拒绝权限。连接或提供方失败的音频请求也会返回相应错误。
- **事件**：每路至多一次，发送后没有新的识别事件。下一次识别需要重新开始。
- **开放范围**：将来可开放给模块。

## voice.keyStatus

- **用途**：检查是否已存百炼语音 Key。
- **调用方**：窗口，工作台和蝶君共用设置。
- **参数**：无。
- **返回**：`{ configured: boolean }`，表示密钥文件是否存在。
- **错误**：`forbidden` 无窗口连接。
- **事件**：无。
- **开放范围**：仅内部。

## voice.setKey

- **用途**：保存或清除百炼语音 Key，使用现有 Windows DPAPI 密钥库。
- **调用方**：窗口，工作台和蝶君共用设置。
- **参数**：必填 `key: string | null`，1–512 个可见 ASCII 字符，传 `null` 清除。
- **返回**：`{ configured: boolean }`。
- **错误**：`forbidden` 无窗口连接，`invalid_params` 参数不合法，`unavailable` 系统密钥存储失败。
- **事件**：无。
- **开放范围**：仅内部。

## 设置和后台调用

| 设置键 | 类型与默认值 | 作用 |
| --- | --- | --- |
| `voiceMode` | `"local" \| "cloud"`，默认 `"local"` | 下次启动识别的模式。 |
| `voiceCloudProvider` | `string`，默认 `"bailian"` | 云端提供方标识，1–32 个小写字母、数字和连字符，首位为小写字母。 |
| `voiceIdleMinutes` | `number`，默认 `10` | 开发者选项，本机识别正常结束后保留进程的分钟数，1–120 整数。 |

后台以 `core.module(VoiceModule)` 获取模块。调用 `startRecognition(onEvent, workspaceId?)`，然后把同一个回调作为所有者传给 `chunk(owner, sessionId, pcm: Buffer)`、`end(owner, sessionId)` 或 `cancel(owner, sessionId)`。它与窗口共用会话名额。新增云端提供方可用 `VoiceProvider` 实现 `open`，返回支持 `chunk/end/cancel` 的会话，再注册一个提供方 ID。

## 开发机模型准备

在仓库根目录执行 `node scripts/prepare-bundled-runtime.mjs --voice-only --download`。可加 `--test-audio` 提取发布包自带的中文样音。正式 Windows 打包读取已校验缓存，复制模型和许可证，样音只用于本地验证。运行时模型位于 `core/bin/voice`。

