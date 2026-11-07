import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalPath, classifyPath, pathKey, type PathRoots } from "../src/security/paths.ts";
import { MASK, redact, redactValue, rememberSecret } from "../src/security/redaction.ts";
import { literalCommand, safeLiteralCommand } from "../src/security/command.ts";

test("security: literal grammar rejects execution, aliases and unknown flags", () => {
	for (const command of ["ls", "cat a", "Get-Credential", "Get-Anything", "git diff --ext-diff", "git status --unknown", "cmd /c dir", "bash -c ls", "Get-Content $(whoami)", 'Get-Content "$env:SECRET"', "Get-Content a > b", "Get-Content a; whoami", "Get-Content 'unterminated", "Get-Content a | Out-File b", "& Get-Content a", "cargo check"]) {
		assert.equal(safeLiteralCommand(command), false, command);
	}
	assert.equal(safeLiteralCommand("Get-Content -LiteralPath 'folder with spaces/a.txt' -Raw"), true);
	assert.equal(safeLiteralCommand("git status --short"), true);
	assert.deepEqual(literalCommand("Get-Content 'a b'"), ["Get-Content", "a b"]);
});

test("security: log and model redaction are distinct, with synthetic secrets only", () => {
	const secret = "T63_synthetic_saved_secret_928431";
	rememberSecret(secret);
	assert.equal(redact(`prefix ${secret} suffix`), `prefix ${MASK} suffix`);
	const pem = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-NOT-A-KEY\n-----END PRIVATE KEY-----";
	assert.equal(redact(pem), MASK);
	assert.equal(redact("-----BEGIN OPENSSH PRIVATE KEY-----\npartial"), MASK);
	assert.equal(redact("password is a programming example"), "password is a programming example");
	assert.equal(redact("https://user:synthetic@proxy.test:8080", true), `https://${MASK}@proxy.test:8080`);
	assert.equal(redact("Authorization: Bearer synthetic-value", true), `Authorization: ${MASK}`);
	assert.deepEqual(redactValue({ Authorization: "Basic synthetic", inner: [secret] }, true), { Authorization: MASK, inner: [MASK] });
	assert.equal(redact("Authorization: example"), "Authorization: example");
});

test("security: canonical paths reject junction aliases to protected directories and resolve missing targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "df-t63-path-"));
	try {
		const roots: PathRoots = { home: join(root, "home"), localAppData: join(root, "local"), appData: join(root, "roaming"), secrets: join(root, "app-secrets") };
		const privateDir = join(roots.home, ".ssh");
		await mkdir(privateDir, { recursive: true });
		await writeFile(join(privateDir, "id_ed25519"), "SYNTHETIC ONLY");
		await symlink(privateDir, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		const actual = await canonicalPath(join(root, "alias", "id_ed25519"), root);
		assert.equal(classifyPath(actual, roots).decision, "deny");
		const future = await canonicalPath(join(root, "alias", "id_future"), root);
		assert.equal(classifyPath(future, roots).decision, "deny");
		assert.equal(classifyPath(join(privateDir, "config"), roots).decision, "confirm");
		assert.equal(classifyPath(join(privateDir, "known_hosts"), roots).decision, "confirm");
		assert.equal(classifyPath(join(privateDir, "id_ed25519.pub"), roots).decision, "allow");
		for (const name of [".env", ".env.production", ".ENV", ".env:stream"]) assert.equal(classifyPath(join(root, name), roots).decision, "deny", name);
		for (const name of [".env.example", ".env.sample", ".env.template", "example.env"]) assert.equal(classifyPath(join(root, name), roots).decision, "allow", name);
		for (const path of [join(roots.localAppData, "Google/Chrome/User Data/Default/Cookies"), join(roots.appData, "Mozilla/Firefox/Profiles/test"), join(roots.secrets, "test.dpapi")]) assert.equal(classifyPath(path, roots).decision, "deny");
		for (const path of [join(roots.home, ".aws/config"), join(roots.home, ".kube/config"), join(root, ".npmrc")]) assert.equal(classifyPath(path, roots).decision, "confirm");
		assert.equal(pathKey("\\\\?\\UNC\\SERVER\\Share\\File"), "//server/share/file");
	} finally { await rm(root, { recursive: true, force: true }); }
});
