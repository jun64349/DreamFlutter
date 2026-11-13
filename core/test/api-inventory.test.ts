import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";
import { startTestCore } from "./harness.ts";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const docsRoot = fileURLToPath(new URL("../../docs/api/", import.meta.url));

function eventNames(): Set<string> {
	const names = new Set<string>();
	for (const file of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
		if (!file.isFile() || !file.name.endsWith(".ts")) continue;
		const path = join(file.parentPath, file.name);
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		function visit(node: ts.Node): void {
			// Inspect value expressions, excluding type declarations, comments,
			// nested domain events, response error objects and internal bus names.
			if (ts.isPropertyAssignment(node) && node.name.getText(source) === "event"
				&& ts.isStringLiteralLike(node.initializer)) {
				let expression: ts.Node = node.parent;
				while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
				const parent = expression.parent;
				const callee = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
					? parent.expression.name.text : undefined;
				const direct = callee === "broadcast" || callee === "send"
					|| (file.name === "index.ts" && path === join(sourceRoot, "modules", "voice", "index.ts") && callee === "emit");
				// core.ts builds the slot.record envelope before sending it to
				// attached clients. main.ts also forwards startup over IPC.
				const forwarded = ts.isVariableDeclaration(parent) &&
					((path === join(sourceRoot, "core.ts") && parent.name.getText(source) === "message")
					|| (path === join(sourceRoot, "main.ts") && parent.name.getText(source) === "event"));
				if (direct || forwarded) names.add(node.initializer.text);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return names;
}

function compare(kind: string, implemented: Set<string>, documented: Set<string>): void {
	assert.deepEqual({
		missing: [...implemented].filter(name => !documented.has(name)).sort(),
		extra: [...documented].filter(name => !implemented.has(name)).sort(),
	}, { missing: [], extra: [] }, kind);
}

it("matches the documented API headings to registered methods, push events and HTTP routes", async () => {
	const t = await startTestCore();
	try {
		// The Windows-only module registers its handlers in the constructor.
		// List the same API on other platforms without starting the sandbox.
		if (process.platform !== "win32") {
			const { Sandbox } = await import("../src/sandbox/sandbox.ts");
			new Sandbox(t.core);
		}
		const methods = new Set(t.core["methods"].keys());
		const routes = new Set(t.core["httpRoutes"].map(route => route.prefix));
		const events = eventNames();
		const documented = { methods: new Set<string>(), events: new Set<string>(), routes: new Set<string>() };
		const seen = new Set<string>();
		for (const file of readdirSync(docsRoot).filter(name => name.endsWith(".md"))) {
			const body = readFileSync(join(docsRoot, file), "utf8");
			for (const [, name, marker] of body.matchAll(/^## ([a-zA-Z]\w*(?:\.[a-zA-Z]\w*)*|\/[\w/-]+\/)[ \t]*\r?$(?:\n(?:[ \t]*\r?\n)*<!-- api:(method|event|http) -->)?/gm)) {
				if (!marker && !name.includes(".") && !name.startsWith("/") && file !== "events.md") continue;
				// T-130/T-131 authored their pages without inventory comments.
				const kind = marker ?? (file === "voice.md" && name.startsWith("voice.")
					? /^voice\.(partial|final|error)$/.test(name) ? "event" : "method"
					: file === "uninstall.md" && name.startsWith("uninstall.") ? "method" : undefined);
				assert.ok(kind, `接口标题缺少分类 ${name}（${file}）`);
				assert.ok(!seen.has(kind + ":" + name), `重复的接口标题 ${name}（${file}）`);
				seen.add(kind + ":" + name);
				documented[kind === "method" ? "methods" : kind === "event" ? "events" : "routes"].add(name);
			}
		}
		compare("JSON-RPC 方法", methods, documented.methods);
		compare("推送事件", events, documented.events);
		compare("HTTP 前缀", routes, documented.routes);
	} finally {
		await t.cleanup();
	}
});
