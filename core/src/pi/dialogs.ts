/**
 * Titles and option labels shared with the UI, which keys special layouts
 * off these prefixes. Keep in sync with app/lib/ui/extension_dialogs.dart.
 */
export const APPROVAL_TITLE = "Agent 请求执行操作";
export const TRUST_TITLE = "信任此工作区？";
export const INFO_TITLE = "Agent 需要你补充信息";

export const ALLOW = "允许";
export const DENY = "拒绝";
export const alwaysAllowLabel = (tool: string) => `本会话内总是允许「${tool}」`;
export const workspaceAllowLabel = (tool: string) => `在此工作区总是允许「${tool}」`;

export const TRUST_REMEMBER = "信任并记住";
export const TRUST_ONCE = "仅这次信任";
export const DISTRUST_ONCE = "这次不信任";
export const DISTRUST_REMEMBER = "不信任并记住";

export type DialogKind = "approval" | "trust" | "input";

export function dialogKind(title: unknown): DialogKind {
	const text = typeof title === "string" ? title : "";
	if (text.startsWith(APPROVAL_TITLE)) return "approval";
	if (text.startsWith(TRUST_TITLE)) return "trust";
	return "input";
}
