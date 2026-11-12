import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_MODEL = "deepseek-v4.1-flash";

export function copyOpenCodeGoChannel(source: string, target: string, expectedChannel?: string): string {
	let copied: { channel: string; models: string[] }[];
	try {
		copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning",
			fileURLToPath(new URL("../copy-channels.ts", import.meta.url)), resolve(source), target, "opencode-go"],
			{ encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
	} catch { throw new Error("复制隔离的 OpenCode Go 渠道配置失败，未发请求"); }
	const channel = copied.find(candidate => candidate.models.includes(LIVE_MODEL)
		&& (expectedChannel === undefined || candidate.channel === expectedChannel))?.channel;
	if (!channel) throw new Error("已配置的 OpenCode Go 渠道没有指定模型，未发请求");
	return channel;
}
