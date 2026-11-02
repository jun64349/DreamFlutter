/**
 * Live check of 蝶君's sandbox on this machine's WSL (v0.3 3.3): provisions a
 * separate distro (DFSandboxLiveCheck, in a temp folder), boots it, runs the
 * escape self-test, goes offline and back, resets it, and removes it again.
 *   node --disable-warning=ExperimentalWarning scripts/live-sandbox.ts [--keep]
 * Uses the image in core/sandbox-image/ (scripts/build-sandbox-image.ts): about 2 minutes;
 * without one it builds the image online first (10–20 minutes). --keep leaves the distro registered.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import { runWsl, type SandboxStatus, type SelfTestItem } from "../src/sandbox/sandbox.ts";

const keep = process.argv.includes("--keep");
const dir = mkdtempSync(join(tmpdir(), "df-live-sandbox-"));
const distro = "DFSandboxLiveCheck";
const core = buildCore({
	paths: corePaths(join(dir, "data")),
	agentDir: join(homedir(), ".pi", "agent"),
	sessionDir: join(dir, "sessions"),
	log: new Logger(undefined, false),
	notifier: new RecordingNotifier(),
	sandbox: { distro, dir: join(dir, "sandbox") },
});
await core.start();
let lastStep = "";
core.addClient((message) => {
	if (message.event !== "sandbox.changed") return;
	const status = message.status as SandboxStatus;
	const step = `${status.step ?? status.state}${status.progress !== null ? ` ${Math.round(status.progress * 100)}%` : ""}`;
	if (step !== lastStep) console.log(`  · ${step}`);
	lastStep = step;
});

const agent = (cmd: string) => runWsl(["-d", distro, "-u", "agent", "--cd", "/workspace", "--", "bash", "-c", cmd], { timeoutMs: 60_000 });
let failed = false;
const expect = (ok: boolean, what: string) => {
	console.log(`${ok ? "OK  " : "FAIL"} ${what}`);
	if (!ok) failed = true;
};

try {
	const started = Date.now();
	console.log("provisioning…");
	await core.call("sandbox.provision", {});
	for (;;) {
		await new Promise((r) => setTimeout(r, 2_000));
		const status = (await core.call("sandbox.status", {})) as SandboxStatus;
		if (status.state === "ready") break;
		if (status.state === "error") throw new Error(status.error ?? "provisioning failed");
	}
	console.log(`provisioned in ${Math.round((Date.now() - started) / 1000)} s`);

	const { items } = (await core.call("sandbox.selfTest", {})) as { items: SelfTestItem[] };
	for (const item of items) expect(item.passed, `self-test ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
	expect(items.some((i) => i.name === "no-windows-programs"), "self-test tried a Windows program");

	const tools = await agent("python3 -c 'import pandas, matplotlib; print(\"py\")'; rg --version | head -1; fd --version");
	expect(tools.stdout.includes("py") && tools.stdout.includes("ripgrep") && tools.stdout.includes("fd"), `tools: ${tools.stdout.trim().replaceAll("\n", " | ")}`);

	const debian = await agent(`grep -h '^VERSION_ID' /etc/os-release; python3 -c "from matplotlib import font_manager as f; print(f.findfont('WenQuanYi Micro Hei', fallback_to_default=False))"`);
	expect(debian.stdout.includes('VERSION_ID="13"'), `Debian 13: ${debian.stdout.split("\n")[0]}`);
	expect(/wqy/i.test(debian.stdout), `charts find the Chinese font: ${debian.stdout.split("\n")[1] ?? debian.stderr.trim()}`);

	const online = await agent("curl -s -m 8 -o /dev/null -w '%{http_code}' http://mirrors.aliyun.com/");
	expect(/^[23]\d\d$/.test(online.stdout.trim()), `online: ${online.stdout.trim()}`);
	await core.call("sandbox.setOnline", { online: false });
	const offline = await agent("curl -s -m 5 -o /dev/null -w '%{http_code}' http://mirrors.aliyun.com/ || true");
	expect(offline.stdout.trim() === "000", `offline: ${offline.stdout.trim()}`);
	await core.call("sandbox.setOnline", { online: true });
	const back = await agent("curl -s -m 8 -o /dev/null -w '%{http_code}' http://mirrors.aliyun.com/");
	expect(/^[23]\d\d$/.test(back.stdout.trim()), `back online: ${back.stdout.trim()}`);

	await agent("echo mess > /workspace/scratch/mess.txt");
	await core.call("sandbox.reset", {});
	const after = await agent("ls /workspace/scratch");
	expect(!after.stdout.includes("mess.txt"), "reset brings back the clean disk");
} catch (error) {
	failed = true;
	console.error("FAIL", error instanceof Error ? error.message : error);
} finally {
	if (!keep) await core.call("sandbox.remove", {}).catch(() => {});
	await core.shutdown();
}
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
