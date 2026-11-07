import type { WslRunner, WslResult } from "../sandbox/sandbox.ts";

/** Decode wsl.exe's redirected UTF-16 output, or injected UTF-8 test output. */
export function decodeWsl(output: Buffer): string {
	return output.includes(0) ? output.toString("utf16le").replace(/^\uFEFF/, "") : output.toString("utf8");
}

/** Capability, not a version guess: older WSL builds must not get a home-made migration. */
export function supportsOfficialMove(help: string): boolean {
	return /--manage\b/.test(help) && /--move\s+<?(?:Location|位置|路径|[A-Za-z]+)>?/i.test(help);
}

export function officialMoveArguments(help: string, distro: string, target: string): string[] {
	if (!supportsOfficialMove(help)) throw new Error("当前 WSL 不支持官方 --manage --move，请升级 WSL 后再搬迁沙箱");
	if (!distro || distro.startsWith("-") || /[\r\n\0]/.test(distro + target)) throw new Error("无效的 WSL 搬迁参数");
	return ["--manage", distro, "--move", target];
}
/** Termination can return before Windows releases the VHD handle. Retry only that transient error. */
export async function officialMoveWithRetry(wsl: WslRunner, args: string[], wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))): Promise<WslResult> {
	for (let attempt = 0; ; attempt++) {
		const result = await wsl(args, { timeoutMs: 600_000 });
		if (result.code === 0 || attempt >= 5 || !/ERROR_SHARING_VIOLATION/.test(result.stderr + result.stdout)) return result;
		await wait(3000);
	}
}
