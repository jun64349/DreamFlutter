import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * API keys encrypted with Windows DPAPI (bound to the current Windows user),
 * so they never sit in Pi's config files in plain text. Pi resolves them on
 * demand through its `"!command"` key syntax, which runs bin/secret.mjs.
 */
export class SecretStore {
	readonly dir: string;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "secrets");
	}

	fileFor(name: string): string {
		return join(this.dir, `${name.replace(/[^\w.-]/g, "_")}.dpapi`);
	}

	/** Encrypts and stores [secret]; returns the Pi key reference to put in config. */
	async put(name: string, secret: string): Promise<string> {
		mkdirSync(this.dir, { recursive: true });
		const file = this.fileFor(name);
		writeFileSync(file, await dpapi("protect", secret), "utf8");
		return keyCommand(file);
	}

	remove(name: string): void {
		rmSync(this.fileFor(name), { force: true });
	}

	async get(name: string): Promise<string> {
		const { readFileSync } = await import("node:fs");
		return dpapi("unprotect", readFileSync(this.fileFor(name), "utf8").trim());
	}
}

/** True when [value] is a key reference written by [SecretStore.put]. */
export function isSecretReference(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("!") && value.includes("secret.mjs");
}

/** The encrypted file a key reference reads. */
export function secretFileOf(ref: string): string | undefined {
	return isSecretReference(ref) ? /^!"[^"]*" "[^"]*" "([^"]+)"/.exec(ref)?.[1] : undefined;
}

/**
 * [ref] pointing at the same key file in [secretsDir], run by this node and
 * script: references hold absolute paths, which differ on another machine
 * (or between the development checkout and the installed app).
 */
export function relocateSecretRef(ref: string, secretsDir: string): string {
	const file = secretFileOf(ref);
	if (!file) return ref;
	return keyCommand(join(secretsDir, file.split(/[\\/]/).pop()!));
}

/**
 * The `!command` Pi runs to read a key. Pi caches command output per command
 * string for the process lifetime, so the trailing `#<stamp>` (a comment to
 * bash, an ignored argument to cmd) makes a changed key a new cache entry.
 */
function keyCommand(file: string): string {
	const node = process.execPath.replaceAll("\\", "/");
	const script = fileURLToPath(new URL("../../bin/secret.mjs", import.meta.url)).replaceAll("\\", "/");
	return `!"${node}" "${script}" "${file.replaceAll("\\", "/")}" #${Date.now().toString(36)}`;
}

const PROTECT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

const UNPROTECT = `
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

const MANY = `
Add-Type -AssemblyName System.Security
$op = [Console]::In.ReadLine()
$out = @()
foreach ($line in [Console]::In.ReadToEnd().Split("\`n")) {
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $bytes = [Convert]::FromBase64String($line)
  if ($op -eq 'protect') { $out += [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')))) }
  else { $out += [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($bytes)), $null, 'CurrentUser')) }
}
[Console]::Out.Write(($out -join "\`n"))
`;

/**
 * DPAPI over many values in one PowerShell (a backup has a key per channel).
 * protect: plain texts → the .dpapi file contents; unprotect: the reverse.
 * Everything crosses the pipe base64-encoded, so no console code page touches it.
 */
export async function dpapiMany(operation: "protect" | "unprotect", values: string[]): Promise<string[]> {
	if (values.length === 0) return [];
	if (process.platform !== "win32") throw new Error("DPAPI is only available on Windows");
	const encoded = Buffer.from(MANY, "utf16le").toString("base64");
	const input = `${operation}\n${values.map((v) => Buffer.from(operation === "protect" ? v : v.trim(), "utf8").toString("base64")).join("\n")}\n`;
	const out = await new Promise<string>((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`DPAPI ${operation} failed: ${stderr.trim() || `exit ${code}`}`))));
		child.stdin.end(input, "utf8");
	});
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length !== values.length) throw new Error(`DPAPI ${operation} returned ${lines.length} of ${values.length} values`);
	return lines.map((l) => Buffer.from(l, "base64").toString("utf8"));
}

/** Runs DPAPI through PowerShell; data goes through stdin, never the command line. */
export function dpapi(operation: "protect" | "unprotect", input: string): Promise<string> {
	if (process.platform !== "win32") return Promise.reject(new Error("DPAPI is only available on Windows"));
	const script = operation === "protect" ? PROTECT : UNPROTECT;
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`DPAPI ${operation} failed: ${err.trim() || `exit ${code}`}`))));
		child.stdin.end(input, "utf8");
	});
}
