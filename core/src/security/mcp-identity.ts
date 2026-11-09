import { resolve } from "node:path";

export const MCP_ID_PREFIX = "mcp:v1:";
export interface McpIdentity { source: string; name: string; }
export function mcpSourceKey(source: string): string { return process.platform === "win32" ? resolve(source).toLowerCase() : resolve(source); }
export function mcpIdentity(source: string, name: string): string { return MCP_ID_PREFIX + JSON.stringify([mcpSourceKey(source), name]); }
export function parseMcpIdentity(key: string, legacy = false): McpIdentity | undefined {
	if (key.startsWith(MCP_ID_PREFIX)) {
		try { const value: unknown = JSON.parse(key.slice(MCP_ID_PREFIX.length)); if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string" && item)) return { source: value[0], name: value[1] }; } catch { /* malformed keys never become a permission grant */ }
	} else if (legacy) { const at = key.lastIndexOf("#"); if (at > 0 && at < key.length - 1) return { source: key.slice(0, at), name: key.slice(at + 1) }; }
	return undefined;
}
