import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessState } from "../agent/state.ts";
import { GitService, GIT_READ_TOOLS } from "./service.ts";
import { GitError, hostGitRunner, sandboxGitEnvironment, sandboxGitRunner } from "./process.ts";

const pathList = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200, description: "Literal repository-relative paths. Use [\".\"] explicitly to stage all; no parent/absolute paths." };
const definitions: { name: string; label: string; description: string; properties?: Record<string, unknown>; required?: string[] }[] = [
	{ name: "git_status", label: "Git 状态", description: "Read repository status, branch, HEAD, staged/unstaged/untracked paths, conflicts and operations in progress." },
	{ name: "git_diff", label: "Git 改动", description: "Read tracked-file changes (staged=true for index). No external diff/text conversion. Untracked paths are listed; read their contents with read.", properties: { staged: { type: "boolean" }, paths: pathList } },
	{ name: "git_history", label: "Git 历史", description: "Read the current branch's commit history with the real configured authors.", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
	{ name: "git_branches", label: "Git 分支列表", description: "List local branches and the current branch. Does not switch branches." },
	{ name: "git_recovery_points", label: "Git 恢复点", description: "List persistent DreamFlutter recovery refs saved before switch, revert and recovery." },
	{ name: "git_stage", label: "Git 暂存", description: "Stage only explicitly selected literal repository-relative paths; includes deletions. Requires normal workbench approval.", properties: { paths: pathList }, required: ["paths"] },
	{ name: "git_commit", label: "Git 提交", description: "Commit the existing staged changes with your message and the user's Git-configured identity. Does not stage, amend, sign, run hooks or push. Missing identity is an error.", properties: { message: { type: "string", maxLength: 20000 } }, required: ["message"] },
	{ name: "git_branch_create", label: "Git 新建分支", description: "Create a local branch at HEAD without switching; does not replace existing branches.", properties: { name: { type: "string" } }, required: ["name"] },
	{ name: "git_switch", label: "Git 切换分支", description: "Switch to an existing local branch only when clean and idle. Saves a persistent recovery point first. Refuses dirty/conflicted worktrees; never stashes or discards files.", properties: { name: { type: "string" } }, required: ["name"] },
	{ name: "git_revert", label: "Git 回退", description: "Undo one non-merge commit with a NEW revert commit; preserves history. Requires a clean idle worktree and Git identity; saves a recovery point first. Reports conflicts without resolving them.", properties: { commit: { type: "string" } }, required: ["commit"] },
	{ name: "git_recover", label: "Git 恢复", description: "Recover a saved point on a NEW local branch; preserves current branch/history and saves another point. Requires clean idle state. Only to cancel this tool's conflicted revert, explicitly set abortRevert=true with its matching point id: this discards conflict-resolution edits from that revert using git revert --abort. Other in-progress operations are refused.", properties: { id: { type: "string" }, abortRevert: { type: "boolean" } }, required: ["id"] },
];

export function gitTools(state: HarnessState, sandbox?: { ready: () => Promise<void>; distro: string }): ToolDefinition[] {
	const runner = state.env.kind === "sandbox"
		? sandboxGitRunner(sandbox ? sandboxGitEnvironment(sandbox.distro) : state.env, sandbox?.ready ?? (async () => { throw new Error("沙箱尚未准备好。"); }))
		: hostGitRunner();
	return definitions.map((definition) => ({
		...definition,
		parameters: { type: "object", properties: definition.properties ?? {}, required: definition.required ?? [], additionalProperties: false } as never,
		executionMode: "sequential" as const,
		async execute(_id, input, signal) {
			// Always authorize the actual repository root too: cwd may be a nested directory.
			if (state.security && state.env.kind === "host") await state.security.authorize(state.cwd, definition.name);
			const service = new GitService(state.cwd, runner);
			let result;
			try {
				if (state.security && state.env.kind === "host") await state.security.authorize(await service.repositoryRoot(signal), definition.name);
				result = await service.execute(definition.name, input as Record<string, unknown>, signal);
			} catch (error) {
				result = { ok: false, code: error instanceof GitError ? error.code : "git_failed", reason: error instanceof Error ? error.message : "Git 操作失败。" };
			}
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
		},
	}));
}

export { GIT_READ_TOOLS };
