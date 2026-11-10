// Runs the backend tests with every temporary file in one folder of its own,
// then deletes that folder, pass or fail (V07-05: test runs had left
// thousands of df-core-* folders in the user's %TEMP%).
//
//   npm test                         all tests
//   npm test -- test/memory.test.ts  some of them
//   KEEP_TEST_TEMP=1 npm test        keep the folder to look at what a test left
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dreamflutter-test-"));
const files = process.argv.slice(2);
const args = ["--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", ...(files.length ? files : ["test/**/*.test.ts"])];
// Model-provider credentials in the developer's environment (an ANTHROPIC_AUTH_TOKEN set by a coding
// tool, say) make Pi pick a real provider, so a test sends a real request instead of using the fake
// model, and fails or spends money depending on whose machine it runs on. Tests never see them.
const providerEnv = /^(ANTHROPIC|OPENAI|AZURE_OPENAI|DEEPSEEK|GEMINI|GOOGLE_API|GOOGLE_CLOUD|VERTEX|OPENROUTER|MISTRAL|GROQ|XAI|CEREBRAS|OPENCODE|MOONSHOT|KIMI|ZAI|MINIMAX|DASHSCOPE|AWS_BEARER_TOKEN_BEDROCK|COPILOT|GITHUB_TOKEN|HF_TOKEN)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !providerEnv.test(name.toUpperCase()) && !/_(API_KEY|AUTH_TOKEN)$/i.test(name)));
Object.assign(env, { TEMP: root, TMP: root, TMPDIR: root });

const result = spawnSync(process.execPath, args, { stdio: "inherit", env });

function size(path) {
	let total = 0;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			total += entry.isDirectory() ? size(full) : (() => { try { return statSync(full).size; } catch { return 0; } })();
		}
	} catch {}
	return total;
}

if (process.env.KEEP_TEST_TEMP) {
	console.log(`test temp kept: ${root}`);
} else {
	const mb = (size(root) / 1048576).toFixed(1);
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		console.log(`test temp cleaned: ${mb} MB`);
	} catch (error) {
		console.error(`test temp could not be fully removed (${mb} MB left in ${root}): ${error.message}`);
	}
}
process.exit(result.status ?? 1);
