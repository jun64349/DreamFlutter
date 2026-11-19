#!/usr/bin/env node
// Prints a DPAPI- or Keychain-protected secret written by the DreamFlutter core.
// Pi runs this through a `"!command"` API key reference:
//   node secret.mjs <file> [#stamp]
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) process.exit(2);

const payload = readFileSync(file, "utf8").trim();

if (payload.startsWith("dfkc1:")) {
	const envKey = process.env.DREAMFLUTTER_TEST_MASTER_KEY?.trim();
	let keyHex = envKey && /^[0-9a-f]{64}$/i.test(envKey) ? envKey : undefined;
	if (!keyHex && process.platform === "darwin") {
		const res = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "DreamFlutter.SecretsMasterKey", "-a", "default", "-w"], { encoding: "utf8" });
		if (res.status === 0 && /^[0-9a-f]{64}$/i.test(res.stdout.trim())) keyHex = res.stdout.trim();
	}
	if (!keyHex) process.exit(1);
	const parts = payload.split(":");
	if (parts.length !== 4) process.exit(1);
	const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(parts[1], "base64"));
	decipher.setAAD(Buffer.from("DreamFlutter.Secrets.v1", "utf8"));
	decipher.setAuthTag(Buffer.from(parts[2], "base64"));
	const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
	process.stdout.write(plain);
	process.exit(0);
}

if (process.platform !== "win32") process.exit(1);

const script = `
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
	windowsHide: true,
	stdio: ["pipe", "inherit", "ignore"],
});
child.on("close", (code) => process.exit(code ?? 1));
child.stdin.end(payload);
