/**
 * The platform's starting memory (user 2026-11-17): basic facts about DreamFlutter
 * itself, written once into a fresh data folder as ordinary global background
 * memories. Nothing is fixed: the user may edit or delete any of them, and a
 * deleted one is not added back. Kept short and factual; snapshot selection
 * brings them in only when a task is about the platform (they are not pinned).
 */
import type { Db } from "../db.ts";
import type { MemoryStore } from "./store.ts";

export const PLATFORM_DEFAULTS_BATCH = "platform_defaults";

export const PLATFORM_DEFAULTS: readonly string[] = [
	"平台简介：DreamFlutter（梦蝶）是运行在 Windows 上的个人 AI 助手软件，分两个空间。工作台：用户主导的对话，在用户选定的工作区里读写文件、运行命令。蝶君：自主的助手，在独立的 WSL 沙箱里干活，也会主动找用户。关掉窗口后，后台的会话照样运行。",
	"平台功能·工作台：切换工作区、新对话、无痕对话（不保存、不读写记忆）；选中回复里的文字可以「引用」或「问一下」（开侧边对话，可带回主对话）；回复可复制、重新生成、从这里重来；右栏看文件改动、Git 提交、后台进程和上下文用量；对话可导出 Markdown、归档，删除后在回收站可恢复。",
	"平台功能·审批：输入框里切换「直接做 / 先问我」。先问我时，修改文件和运行命令前会先请用户允许或拒绝，只读操作不问；处理过的审批会收起。",
	"平台功能·蝶君：直接对话交办，蝶君在回复里说打算并开工，打招呼就正常聊；只有真缺信息时才提问，需要用户处理的事放进「等你处理」。蝶君在沙箱里什么都能做，交付文件放在沙箱的 /workspace/outbox；要动沙箱外的东西需要用户明确同意。性格可在设置里从静、暖、利落、灵动中选。",
	"平台功能·日程（时令页）：可以「到点提醒我」或「蝶君去做」。时间写法如「今天 14:00」「明天下午3点」「每天 08:00」「每周一 09:00」。日程可暂停、现在做一次、查看运行记录；巡检会定期看看有没有该处理的事。",
	"平台功能·记忆：分「关于你」「项目」「蝶君自己记的」三组。用户明确要求记住的直接保存，Agent 自己推测的标为「推测」；记忆页可以编辑、删除和撤销。这几条平台说明也是普通记忆，可以改，也可以删。",
	"平台内置工具：读、写、改文件（read、write、edit），按文件名或内容查找（glob、grep），运行命令（工作台用 PowerShell，蝶君沙箱里用 bash 和 python），抓取网页（web_fetch）和联网搜索（web_search），把子任务交给子代理（agent），渲染网页和卡片（render_html、show_card），读 Word、PDF 等文档（read_document），看图（read_image），待办清单，向用户提问，Git 查看与提交，后台进程管理，记忆与历史对话检索，日程管理。",
	"平台内置技能：data-analysis（分析 CSV、Excel 数据并出中文图表）、office-docx（Word 文档）、office-xlsx（Excel 表格）、office-pptx（PowerPoint 演示）、office-pdf（合并、拆分、检查 PDF）、showcard-pro（把已有记录做成周报和汇报卡片）、skill-builder（创建、安装、更新技能）、mcp-builder（帮忙接入外部服务）、router（新任务里挑选合适的技能和工具）。用户自己的技能在「技能」页导入（文件夹或链接），确认信任后才能用。",
	"平台的连接服务（MCP）：平台不预装 MCP 服务。用户在「技能 › 连接的服务」里添加，可以测试连接、逐个开关其中的工具；蝶君默认不能用，要单独打开「蝶君能用」。也可以让 Agent 用 mcp-builder 技能帮忙接入。",
	"平台的模型：在「设置 › 模型」添加渠道（如 DeepSeek、智谱、OpenCode Go）和密钥，密钥加密保存在本机。模型组按顺序排成员，前面的用不了时自动换下一个，并在对话里说一声。花费页看今天、本月的花费和每月上限。",
];

/**
 * Writes the starting memory into a folder that has never had any memory, once.
 * Returns how many were added (0 when the folder was already in use or seeded before).
 */
export function seedPlatformDefaults(db: Db, store: MemoryStore): number {
	// Seeded before, or memory already used (saved, waiting for confirmation, or any earlier change).
	if (db.get("SELECT 1 FROM memory_batches LIMIT 1")) return 0;
	if (db.get("SELECT 1 FROM memories LIMIT 1") || db.get("SELECT 1 FROM memory_pending LIMIT 1")) return 0;
	const result = store.commit({
		actor: "system",
		batchKind: PLATFORM_DEFAULTS_BATCH,
		reason: "平台自带的基础说明，可以修改或删除",
		ops: PLATFORM_DEFAULTS.map((content) => ({ kind: "add" as const, item: { scope: "global" as const, kind: "background" as const, level: 1 as const, content, confidence: "verified" as const } })),
	});
	return result.applied.length;
}
