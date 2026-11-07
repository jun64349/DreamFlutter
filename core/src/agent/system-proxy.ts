import { spawnSync } from "node:child_process";

export interface SystemProxy { enabled: boolean; server: string; bypass?: string; autoConfig?: boolean }

/** WinINet's per-protocol list, without executing PAC scripts or changing user settings. */
export function proxyEnvironment(proxy: SystemProxy | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	if (!proxy?.enabled || proxy.autoConfig || !proxy.server.trim()) return env;
	const servers = new Map<string, string>();
	for (const piece of proxy.server.split(";")) {
		const match = /^(http|https|socks)=(.+)$/i.exec(piece.trim());
		if (match) servers.set(match[1]!.toLowerCase(), match[2]!.trim());
		else if (!piece.includes("=")) servers.set("all", piece.trim());
	}
	const address = (value: string | undefined): string | undefined => {
		if (!value) return undefined;
		try {
			const url = new URL(value.includes("://") ? value : `http://${value}`);
			return ["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) && !/[\r\n]/.test(value) ? url.href.replace(/\/$/, "") : undefined;
		} catch { return undefined; }
	};
	for (const scheme of ["http", "https"]) {
		const key = `${scheme}_proxy`;
		// Existing uppercase OR lowercase values, even an explicit empty value, win.
		if (Object.keys(base).some((k) => k.toLowerCase() === key) || Object.keys(base).some((k) => k.toLowerCase() === "all_proxy")) continue;
		const value = address(servers.get(scheme) ?? servers.get("all"));
		if (value) { env[key] = value; env[key.toUpperCase()] = value; }
	}
	if (!Object.keys(base).some((k) => k.toLowerCase() === "no_proxy")) {
		// <local> (every single-label host) has no portable NO_PROXY equivalent.
		const bypass = (proxy.bypass ?? "").split(";").map((x) => x.trim()).filter((x) => x && x !== "<local>").map((x) => x.replace(/^\*\./, "."));
		const value = [...new Set(["localhost", "127.0.0.1", "::1", ...bypass])].join(",");
		env.no_proxy = value; env.NO_PROXY = value;
	}
	return env;
}

let cached: { at: number; value: SystemProxy | undefined } | undefined;
/** Bounded read-only query; no shell and no proxy credentials in logs. */
export function readSystemProxy(): SystemProxy | undefined {
	if (process.platform !== "win32") return undefined;
	if (cached && Date.now() - cached.at < 30_000) return cached.value;
	const result = spawnSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", timeout: 1500, windowsHide: true });
	const field = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi").exec(result.stdout ?? "")?.[1]?.trim();
	const value = result.status === 0 ? { enabled: Number(field("ProxyEnable")) === 1, server: field("ProxyServer") ?? "", bypass: field("ProxyOverride"), autoConfig: !!field("AutoConfigURL") } : undefined;
	cached = { at: Date.now(), value };
	return value;
}
