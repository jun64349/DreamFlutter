import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Core, type SandboxHandle } from "../src/core.ts";
import { resolveSandboxEnv } from "../src/agent/state.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { buildSeatbeltProfile, MacSeatbeltSandbox, resolveSeatbeltHostPath, SEATBELT_DISTRO, seatbeltSandboxEnv } from "../src/sandbox/seatbelt.ts";

test("seatbelt-sandbox: buildSeatbeltProfile locks writes and denies sensitive macOS paths", () => {
	const offline = buildSeatbeltProfile({
		workspaceDir: "/Users/alice/df/sandbox/workspace",
		agentHomeDir: "/Users/alice/df/sandbox/home/agent",
		tmpDir: "/Users/alice/df/sandbox/tmp",
		userHome: "/Users/alice",
		deniedPaths: ["/Users/alice/df/secrets"],
		allowNetwork: false,
	});
	assert.match(offline, /\(deny file-write\*\)/);
	assert.match(offline, /\(subpath "\/Users\/alice\/df\/sandbox\/workspace"\)/);
	assert.match(offline, /\(subpath "\/Users\/alice\/df\/sandbox\/home\/agent"\)/);
	assert.match(offline, /\(subpath "\/Users\/alice\/df\/sandbox\/tmp"\)/);
	assert.match(offline, /\(deny file-read\* file-write\*/);
	assert.match(offline, /\/Users\/alice\/Library\/Keychains/);
	assert.match(offline, /\/Users\/alice\/\.ssh/);
	assert.match(offline, /\/Users\/alice\/df\/secrets/);
	assert.match(offline, /\(deny network-outbound \(remote ip\)\)/);

	const online = buildSeatbeltProfile({
		workspaceDir: "/Users/alice/df/sandbox/workspace",
		agentHomeDir: "/Users/alice/df/sandbox/home/agent",
		tmpDir: "/Users/alice/df/sandbox/tmp",
		userHome: "/Users/alice",
		deniedPaths: [],
		allowNetwork: true,
	});
	assert.doesNotMatch(online, /\(deny network-outbound/);
});

test("seatbelt-sandbox: path resolution keeps logical /workspace inside host sandbox and blocks escapes", () => {
	const cfg = {
		dir: "/tmp/sb",
		workspaceDir: "/tmp/sb/workspace",
		agentHomeDir: "/tmp/sb/home/agent",
		tmpDir: "/tmp/sb/tmp",
		rootfsDir: "/tmp/sb/rootfs",
		profilePath: "/tmp/sb/seatbelt.sb",
		userHome: "/Users/alice",
		secretsDir: "/tmp/secrets",
		deniedDataDirs: [],
		online: () => true,
	};
	assert.equal(resolveSeatbeltHostPath(cfg, "/workspace/outbox/report.md"), join("/tmp/sb/workspace", "outbox", "report.md"));
	assert.equal(resolveSeatbeltHostPath(cfg, "/home/agent/.bashrc"), join("/tmp/sb/home/agent", ".bashrc"));
	assert.equal(resolveSeatbeltHostPath(cfg, "/tmp/scratch.txt"), join("/tmp/sb/tmp", "scratch.txt"));
	assert.equal(resolveSeatbeltHostPath(cfg, "/etc/passwd"), join("/tmp/sb/rootfs", "etc", "passwd"));
	assert.equal(resolveSeatbeltHostPath(cfg, "/workspace/../../etc/passwd"), join("/tmp/sb/rootfs", "etc", "passwd"));
	assert.throws(() => resolveSeatbeltHostPath(cfg, "/workspace/bad\0path"));

	const handle: SandboxHandle = { kind: "seatbelt", distro: SEATBELT_DISTRO, workspaceDir: cfg.workspaceDir, seatbelt: cfg, ready: async () => {}, online: () => true };
	const env = resolveSandboxEnv(handle);
	assert.equal(env.kind, "sandbox");
	assert.equal(env.local("/workspace/a.txt"), join("/tmp/sb/workspace", "a.txt"));
	assert.equal(seatbeltSandboxEnv(cfg).resolve("/workspace", "sub/file.py").replaceAll("\\", "/"), "/tmp/sb/workspace/sub/file.py");
});

test("seatbelt-sandbox: MacSeatbeltSandbox sets up workspace without blocking parent dataDir when DB is at root", async () => {
	const root = mkdtempSync(join(tmpdir(), "df-seatbelt-mod-"));
	try {
		const core = new Core({
			paths: corePaths(root),
			agentDir: defaultAgentDir(root),
			log: new Logger(),
			notifier: new RecordingNotifier(),
		});
		try {
			const sb = new MacSeatbeltSandbox(core, { userHome: "/Users/alice" });
			core.use(sb);
			await core.start();

			const status = (await core.call("sandbox.status", {})) as Record<string, unknown>;
			assert.equal(status.state, "ready");
			assert.equal(status.kind, "seatbelt");
			assert.equal(status.distro, SEATBELT_DISTRO);
			assert.ok(existsSync(join(sb.config.workspaceDir, "inbox")));
			assert.ok(existsSync(join(sb.config.workspaceDir, "outbox")));

			await core.call("sandbox.setOnline", { online: false });
			assert.equal(core.settings.get().sandboxOnline, false);
			const profileText = buildSeatbeltProfile({
				workspaceDir: sb.config.workspaceDir,
				agentHomeDir: sb.config.agentHomeDir,
				tmpDir: sb.config.tmpDir,
				userHome: sb.config.userHome,
				deniedPaths: [sb.config.secretsDir, ...sb.config.deniedDataDirs],
				allowNetwork: false,
			});
			// Parent dataDir must not appear in denied subpaths even though locations.database === dataDir.
			assert.equal(sb.config.deniedDataDirs.includes(root), false);
			assert.match(profileText, /\(deny network-outbound/);

			mkdirSync(join(sb.config.workspaceDir, "scratch"), { recursive: true });
			await core.call("sandbox.reset", {});
			assert.ok(existsSync(join(sb.config.workspaceDir, "outbox")));
		} finally {
			await core.shutdown();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
