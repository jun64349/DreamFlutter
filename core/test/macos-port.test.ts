import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseScutilProxy } from "../src/agent/system-proxy.ts";
import { isSameBackupSource } from "../src/backup/restore.ts";
import { isReadOnlyCall, isReadOnlyCommand } from "../src/ext/approval.ts";
import { platformDefaults } from "../src/memory/platform-defaults.ts";
import { openWithMasterKey, sealWithMasterKey } from "../src/modules/secrets.ts";
import { defaultDataDir, isMacAppBundle, legacyDataDir } from "../src/paths.ts";
import { safePosixLiteralCommand } from "../src/security/command.ts";
import { classifyPath, type PathRoots } from "../src/security/paths.ts";
import { localDatabaseTarget, parseDarwinMountOutput } from "../src/storage/target.ts";

test("macos-port: paths recognize .app bundles and macOS Application Support dirs", () => {
	assert.equal(isMacAppBundle("/Applications/DreamFlutter.app/Contents/Resources"), true);
	assert.equal(isMacAppBundle("/Users/dev/DreamFlutter"), false);
	assert.equal(
		defaultDataDir("darwin", "/Applications/DreamFlutter.app/Contents/Resources", {}, "/Users/alice"),
		join("/Users/alice", "Library", "Application Support", "DreamFlutter"),
	);
	assert.equal(
		defaultDataDir("darwin", "/Applications/DreamFlutter.app/Contents/Resources", { DREAMFLUTTER_DATA: "/tmp/custom-df" }, "/Users/alice"),
		"/tmp/custom-df",
	);
	assert.equal(
		legacyDataDir("darwin", {}, "/Users/alice"),
		join("/Users/alice", "Library", "Application Support", "DreamFlutter"),
	);
});

test("macos-port: Keychain AES-256-GCM envelope seals/opens and secret.mjs resolves dfkc1 payloads", () => {
	const masterKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const wrongKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
	const plain = "sk-test-中文密钥-!@#";
	const sealed = sealWithMasterKey(plain, masterKey);
	assert.ok(sealed.startsWith("dfkc1:"));
	assert.equal(openWithMasterKey(sealed, masterKey), plain);
	assert.throws(() => openWithMasterKey(sealed, wrongKey));

	const dir = mkdtempSync(join(tmpdir(), "df-macos-secret-"));
	try {
		const secretFile = join(dir, "k.dpapi");
		writeFileSync(secretFile, sealed, "utf8");
		const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "secret.mjs");
		const res = spawnSync(process.execPath, [script, secretFile], {
			encoding: "utf8",
			env: { ...process.env, DREAMFLUTTER_TEST_MASTER_KEY: masterKey },
		});
		assert.equal(res.status, 0, res.stderr);
		assert.equal(res.stdout, plain);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("macos-port: POSIX read-only command allowlist and approval classification", () => {
	for (const cmd of [
		"pwd",
		"ls",
		"ls -la 'folder with spaces'",
		"cat -n src/main.ts",
		"head -n 20 package.json",
		"tail -5 app.log",
		"wc -l README.md",
		"git status --short",
		"git rev-parse --show-toplevel",
		"uname -m",
	]) {
		assert.equal(safePosixLiteralCommand(cmd), true, cmd);
		assert.equal(isReadOnlyCall("bash", { command: cmd }, "darwin"), true, cmd);
		assert.equal(isReadOnlyCall("bash", { command: cmd }, "win32"), false, `win32 must stay strict: ${cmd}`);
	}
	assert.equal(isReadOnlyCommand("ls"), false, "default PowerShell classifier unchanged");
	for (const cmd of [
		"rm -rf /tmp/x",
		"cat a > b",
		"ls; whoami",
		"echo $(id)",
		"echo `id`",
		"ls *.ts",
		"l\\s",
		"cat ~/Documents/x",
		"git diff --ext-diff",
		"find . -exec id {} +",
		"bash -c ls",
	]) {
		assert.equal(safePosixLiteralCommand(cmd), false, cmd);
		assert.equal(isReadOnlyCall("bash", { command: cmd }, "darwin"), false, cmd);
	}
});

test("macos-port: classifyPath denies macOS Keychains, browser profiles, Mail and Messages", () => {
	const roots: PathRoots = {
		home: "/Users/alice",
		localAppData: "/Users/alice/Library/Application Support",
		appData: "/Users/alice/Library/Application Support",
		secrets: "/Users/alice/Library/Application Support/DreamFlutter/secrets",
	};
	for (const p of [
		"/Users/alice/Library/Keychains/login.keychain-db",
		"/Users/alice/Library/Application Support/Google/Chrome/Default/Cookies",
		"/Users/alice/Library/Application Support/Microsoft Edge/Default/Login Data",
		"/Users/alice/Library/Application Support/Firefox/Profiles/abc",
		"/Users/alice/Library/Safari/History.db",
		"/Users/alice/Library/Cookies/Cookies.binarycookies",
		"/Users/alice/Library/Mail/V10",
		"/Users/alice/Library/Messages/chat.db",
	]) {
		assert.equal(classifyPath(p, roots).decision, "deny", p);
	}
});

test("macos-port: parseScutilProxy extracts HTTP, HTTPS, SOCKS and bypass rules", () => {
	const sample = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : *.example.test
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`;
	const parsed = parseScutilProxy(sample);
	assert.deepEqual(parsed, {
		enabled: true,
		server: "http=127.0.0.1:7890;https=127.0.0.1:7890",
		bypass: "*.local;169.254/16;*.example.test",
		autoConfig: false,
	});
});

test("macos-port: localDatabaseTarget validates Darwin local vs network volumes", () => {
	const mountOut = [
		"/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
		"/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
		"//alice@nas.local/share on /Volumes/NAS (smbfs, nodev, nosuid, mounted by alice)",
		"nas.local:/export on /Volumes/NFS (nfs, nodev)",
	].join("\n");
	assert.deepEqual(parseDarwinMountOutput(mountOut, "/Users/alice/DreamFlutter/db"), { fsType: "apfs", local: true });
	assert.deepEqual(parseDarwinMountOutput(mountOut, "/Volumes/NAS/db"), { fsType: "smbfs", local: false });
	assert.deepEqual(parseDarwinMountOutput(mountOut, "/Volumes/NFS/db"), { fsType: "nfs", local: false });

	assert.throws(
		() => localDatabaseTarget("relative/db", undefined, "darwin", () => ({ fsType: "apfs", local: true })),
		/本地绝对目录/,
	);
	assert.equal(localDatabaseTarget("/Users/alice/df-db", undefined, "darwin", () => ({ fsType: "apfs", local: true })), "/Users/alice/df-db");
	assert.throws(
		() => localDatabaseTarget("/Volumes/NAS/db", undefined, "darwin", () => ({ fsType: "smbfs", local: false })),
		/不支持网络挂载/,
	);
});

test("macos-port: platformDefaults and cross-platform backup source comparison", () => {
	const mac = platformDefaults("darwin");
	assert.ok(mac.some((c) => c.includes("macOS")));
	assert.ok(mac.some((c) => c.includes("蝶君")));
	assert.ok(mac.some((c) => c.includes("MCP")));
	assert.ok(mac.some((c) => c.includes("内置技能")));
	assert.equal(isSameBackupSource({ platform: "win32", host: "H", user: "U" } as never, "darwin", "H", "U"), false);
	assert.equal(isSameBackupSource({ platform: "darwin", host: "H", user: "U" } as never, "darwin", "H", "U"), true);
});
