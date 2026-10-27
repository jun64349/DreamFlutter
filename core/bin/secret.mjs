#!/usr/bin/env node
// Prints a DPAPI-protected secret written by the DreamFlutter core.
// Pi runs this through a `"!command"` API key reference:
//   node secret.mjs <file> [#stamp]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) process.exit(2);

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
child.stdin.end(readFileSync(file, "utf8").trim());
