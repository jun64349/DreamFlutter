import { createHash } from "node:crypto";
import { scanSecrets } from "../cards/document.ts";

/**
 * What memory must never hold (docs/memory-design.md §10, 17.2 item 3):
 * memory goes into every request, so text written into it keeps acting.
 * Checked when an item is written and again when a snapshot is put
 * together (old data, a hand-edited database).
 */

/** Characters that do not show but can carry instructions (zero-width, bidi overrides, tag characters). ZWJ is left alone: emoji use it. */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;

/** Text that talks to the model instead of saying something about the user. Narrow on purpose: 「回复时忽略格式要求」 is a fine preference. */
const INJECTION: RegExp[] = [
	/\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions?|prompts?|messages?|rules)/i,
	/(忽略|无视|忘掉|不要理会)(掉)?(之前|以上|前面|上面|先前|此前|所有|系统)(的|所有的)?(所有)?(指令|指示|提示词|系统提示)/,
	/(reveal|print|show|output|repeat|leak)\s+(your|the)\s+(system\s+prompt|instructions)/i,
	/(泄露|输出|打印|复述|告诉我)(你的)?(系统提示|提示词|系统指令)/,
	/\b(send|upload|post|exfiltrate|forward)\b.{0,40}\b(files?|keys?|tokens?|passwords?|credentials?|secrets?|data|conversations?|history)\b.{0,40}\bto\s+https?:\/\//i,
	/(把|将).{0,20}(文件|密钥|密码|令牌|聊天记录|对话|数据|记忆).{0,20}(发送|上传|发到|传到|转发)(到|给)?.{0,20}https?:\/\//,
	/<\/?\s*(system|assistant|tool_result|记忆快照)(?=[\s>/])[^>]*>/i,
	/\b(curl|wget|iwr|invoke-webrequest)\b.{0,120}\|\s*(sh|bash|zsh|pwsh|powershell|iex)\b/i,
];

/** A password written out (the key shapes come from the cards' scanner). 「密码要定期换」 is fine; 「密码是 xxxx」 is not. */
const PASSWORD = /(密码|口令|password|passwd|passcode|pin\s*码?)\s*(是|为|:|：|=)\s*["'“]?[^\s"'”，。,]{4,}/i;

export type Hazard = { kind: "secret" | "injection" | "invisible"; detail: string };

export function scanMemoryText(text: string): Hazard | undefined {
	if (INVISIBLE.test(text)) return { kind: "invisible", detail: "含有看不见的控制字符" };
	const secrets = scanSecrets(text);
	if (PASSWORD.test(text)) secrets.push("密码");
	if (secrets.length) return { kind: "secret", detail: `像是密钥、密码或令牌（${secrets.join("，")}）` };
	for (const re of INJECTION) if (re.test(text)) return { kind: "injection", detail: "像是在给 Agent 下指令（提示注入），不是关于用户的信息" };
	return undefined;
}

/** Why [text] may not be written to memory, for the gate's reply. */
export function hazardReason(hazard: Hazard): string {
	return `这段内容不能进记忆：${hazard.detail}`;
}

/** Text with case, spaces and punctuation taken away: what a suppression compares. */
export function normalized(text: string): string {
	return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** The fingerprint a hard delete keeps instead of the text (§12 item 8: 「不含正文的抑制记录」). */
export function suppressionHash(text: string): string {
	return createHash("sha256").update(normalized(text)).digest("hex");
}
