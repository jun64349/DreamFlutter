import { createHash, randomUUID } from "node:crypto";
import { GitError, hostGitRunner, type GitOutput, type GitRunner } from "./process.ts";

const PREFIX = "refs/dreamflutter/recovery/";
const ID = /^(switch|revert|recover)-\d{13}-[a-f0-9-]{36}$/;
export interface GitFile { path: string; index: string; worktree: string; originalPath?: string; }
export interface GitStatus { root: string; branch: string | null; head: string | null; files: GitFile[]; dirty: boolean; conflicts: string[]; operation: string | null; }
export interface RecoveryPoint { id: string; commit: string; reason: string; createdAt: number; }
export interface GitSelection { root: string; head: string | null; paths: string[]; diff: string; fingerprint: string; }
export type GitResult = { ok: true; [key: string]: unknown } | { ok: false; code: string; reason: string; recoveryPoint?: RecoveryPoint; [key: string]: unknown };
export const GIT_READ_TOOLS = ["git_status", "git_diff", "git_history", "git_branches", "git_recovery_points"];
export const GIT_WRITE_TOOLS = ["git_stage", "git_commit", "git_branch_create", "git_switch", "git_revert", "git_recover"];
export const GIT_TOOLS = [...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS].sort();

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new GitError("invalid_input", `${name} 必须是非空字符串。`);
	return value;
}
function paths(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > 200) throw new GitError("invalid_input", "paths 必须含 1–200 个仓库相对文件路径；暂存所有文件请显式传 [\".\"]。");
	return value.map((item) => {
		const path = text(item, "path");
		if (/^(?:[\\/]|[a-zA-Z]:)/.test(path) || path.split(/[\\/]/).includes("..")) throw new GitError("invalid_input", "路径必须在仓库内，不能包含 ..。");
		return path;
	});
}
function limit(value: unknown, fallback = 20): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) throw new GitError("invalid_input", "limit 必须为 1–100 的整数。");
	return value;
}
function failure(result: GitOutput): GitError {
	const reason = (result.stderr || result.stdout).trim();
	const code = /not a git repository/i.test(reason) ? "not_repository"
		: /dubious ownership/i.test(reason) ? "unsafe_repository"
		: /unable to auto-detect email|identity unknown|empty ident|no email was given/i.test(reason) ? "identity_missing"
		: /index.lock|cannot lock ref/i.test(reason) ? "repository_locked" : "git_failed";
	return new GitError(code, code === "identity_missing" ? "未配置 Git 作者身份：请用户设置 user.name 和 user.email；不会伪造身份。" : code === "not_repository" ? "这个文件夹不是Git仓库。" : reason || `Git 退出码 ${result.code}`);
}

// Serialize complete mutations across sessions and worktree aliases of one repository.
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	const result = previous.then(action, action), tail = result.catch(() => {});
	locks.set(key, tail);
	try { return await result; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

/** All mutation entrypoints go through execute. The caller owns approval; no arbitrary Git arguments. */
export class GitService {
	readonly cwd: string;
	private runner: GitRunner;
	constructor(cwd: string, runner: GitRunner = hostGitRunner()) { this.cwd = cwd; this.runner = runner; }
	private run(args: string[], signal?: AbortSignal) { return this.runner.run(this.cwd, args, signal); }
	private async lockKey(signal?: AbortSignal): Promise<string> {
		const root = (await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).replace(/\r?\n$/, "");
		return `${this.cwd.startsWith("/") ? "linux" : "host"}:${process.platform === "win32" && !this.cwd.startsWith("/") ? root.toLowerCase() : root}`;
	}
	private async git(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await this.run(args, signal);
		if (result.code !== 0) throw failure(result);
		return result.stdout;
	}
	private async head(signal?: AbortSignal): Promise<string | null> {
		const result = await this.run(["rev-parse", "--verify", "HEAD"], signal);
		return result.code === 0 ? result.stdout.trim() : null;
	}
	async repositoryRoot(signal?: AbortSignal): Promise<string> {
		if ((await this.git(["rev-parse", "--is-inside-work-tree"], signal)).trim() !== "true") throw new GitError("not_worktree", "需要 Git 工作树；裸仓库不支持这些操作。");
		return (await this.git(["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, "");
	}
	async status(signal?: AbortSignal): Promise<GitStatus> {
		const root = await this.repositoryRoot(signal);
		const branchResult = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
		const entries = (await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal)).split("\0");
		const files: GitFile[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (!entry) continue;
			const file: GitFile = { index: entry[0]!, worktree: entry[1]!, path: entry.slice(3) };
			if (/[RC]/.test(file.index + file.worktree)) file.originalPath = entries[++i];
			files.push(file);
		}
		const conflicts = files.filter((file) => ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(file.index + file.worktree)).map((file) => file.path);
		const markers = ["REVERT_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "BISECT_START", "rebase-merge", "rebase-apply", "sequencer"];
		const markerPaths = (await this.git(["rev-parse", "--path-format=absolute", ...markers.flatMap((marker) => ["--git-path", marker])], signal)).replace(/\r?\n$/, "").split(/\r?\n/);
		if (markerPaths.length !== markers.length) throw new GitError("unsupported_path", "仓库路径含换行，无法安全检查进行中的 Git 操作。");
		const present = await this.runner.exists(markerPaths, signal);
		const operation = markers.find((_, index) => present[index]) ?? null;
		return { root, branch: branchResult.code === 0 ? branchResult.stdout.trim() : null, head: await this.head(signal), files, dirty: files.length > 0, conflicts, operation };
	}
	private idle(status: GitStatus, clean = false): void {
		if (status.conflicts.length) throw new GitError("conflict", `仓库有未解决冲突：${status.conflicts.join("、")}；请先处理。`);
		if (status.operation) throw new GitError("operation_in_progress", `仓库正在执行 ${status.operation}；请先完成或取消。`);
		if (clean && status.dirty) throw new GitError("uncommitted_changes", "工作区有未提交改动或未跟踪文件；请先由用户决定如何保留，再切换、回退或恢复。");
	}
	/** A complete working-tree patch, including untracked/binary files, for exactly these files. */
	private async selection(status: GitStatus, input: unknown, signal?: AbortSignal): Promise<GitSelection> {
		this.idle(status);
		const requested = paths(input).map((path) => path.replaceAll("\\", "/"));
		const selected = new Set<string>();
		for (const path of requested) {
			const file = status.files.find((file) => file.path === path || file.originalPath === path);
			if (!file) throw new GitError("invalid_selection", `文件没有可提交的改动：${path}；请刷新后重新选择。`);
			selected.add(file.path);
			if (file.originalPath) selected.add(file.originalPath);
		}
		const chosen = [...selected].sort();
		const args = ["-C", status.root, "diff", "--binary", "--no-ext-diff", "--no-textconv"];
		let patch = status.head ? await this.git([...args, status.head, "--", ...chosen], signal) : "";
		for (const path of chosen) {
			const file = status.files.find((file) => file.path === path);
			if (!file || status.head && file.index !== "?") continue;
			if (!status.head && (file.index === "D" || file.worktree === "D")) continue;
			const out = await this.run([...args, "--no-index", "--", "/dev/null", path], signal);
			if (out.code !== 0 && out.code !== 1) throw failure(out);
			patch += out.stdout;
			if (Buffer.byteLength(patch) > 2 * 1024 * 1024) throw new GitError("output_limit", "所选改动超过2MiB，请缩小提交文件范围。");
		}
		const diff = patch.split(/(?=^diff --git )/m).map((part) => part.includes("\nGIT binary patch\n") ? `${part.split("\nGIT binary patch\n")[0]}\n二进制文件已更改\n` : part).join("");
		return { root: status.root, head: status.head, paths: chosen, diff, fingerprint: createHash("sha256").update(JSON.stringify([status.head, chosen, patch])).digest("hex") };
	}
	async prepareCommit(selected: unknown, signal?: AbortSignal): Promise<GitResult> {
		try {
			return await locked(await this.lockKey(signal), async () => ({ ok: true, ...await this.selection(await this.status(signal), selected, signal) }));
		} catch (error) { return { ok: false, code: error instanceof GitError ? error.code : "git_failed", reason: error instanceof Error ? error.message : "无法读取Git改动。" }; }
	}
	/** Direct window confirmation is approval. The model tool retains its normal approval path. */
	commitSelected(selected: unknown, message: unknown, expected: { head?: string | null; fingerprint?: string; paths?: string[] } = {}, signal?: AbortSignal): Promise<GitResult> {
		return this.execute("git_commit", { paths: selected ?? [], message, ...(expected.head !== undefined ? { expectedHead: expected.head } : {}), ...(expected.fingerprint !== undefined ? { expectedFingerprint: expected.fingerprint } : {}), ...(expected.paths !== undefined ? { expectedPaths: expected.paths } : {}) }, signal);
	}
	private async commitId(value: unknown, signal?: AbortSignal): Promise<string> {
		const ref = text(value, "commit");
		if (ref.startsWith("-") || /[\r\n]/.test(ref)) throw new GitError("invalid_input", "无效的提交引用。");
		return (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)).trim();
	}
	private async branch(value: unknown, signal?: AbortSignal): Promise<string> {
		const name = text(value, "name");
		// Reject switch shortcuts like @{-1}; only actual local branch names are accepted.
		const result = await this.run(["check-ref-format", `refs/heads/${name}`], signal);
		if (name.startsWith("-") || name === "HEAD" || name.startsWith("refs/") || result.code !== 0) throw new GitError("invalid_input", "请提供有效的本地分支名。");
		return name;
	}
	private async save(reason: "switch" | "revert" | "recover", status: GitStatus, signal?: AbortSignal): Promise<RecoveryPoint> {
		if (!status.head) throw new GitError("empty_repository", "仓库尚无提交，无法创建恢复点。");
		const createdAt = Date.now(), id = `${reason}-${createdAt}-${randomUUID()}`;
		await this.git(["update-ref", "-m", `DreamFlutter before ${reason}`, `${PREFIX}${id}`, status.head, ""], signal);
		return { id, commit: status.head, reason, createdAt };
	}
	async recoveryPoints(signal?: AbortSignal): Promise<RecoveryPoint[]> {
		const lines = (await this.git(["for-each-ref", "--format=%(refname)%00%(objectname)", PREFIX], signal)).trim().split("\n");
		return lines.filter(Boolean).flatMap((line) => {
			const [ref, commit] = line.split("\0"), id = ref!.slice(PREFIX.length);
			if (!ID.test(id) || !commit) return [];
			return [{ id, commit, reason: id.split("-")[0]!, createdAt: Number(id.split("-")[1]) }];
		}).sort((a, b) => b.createdAt - a.createdAt);
	}
	async execute(tool: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<GitResult> {
		let point: RecoveryPoint | undefined;
		try {
			if (!GIT_TOOLS.includes(tool)) throw new GitError("unsupported_operation", "不支持此 Git 操作；不提供推送或改写已有历史的工具。");
			const allowed: Record<string, string[]> = { git_diff: ["staged", "paths"], git_history: ["limit"], git_stage: ["paths"], git_commit: ["message", "paths", "expectedHead", "expectedFingerprint", "expectedPaths"], git_branch_create: ["name"], git_switch: ["name"], git_revert: ["commit"], git_recover: ["id", "abortRevert"] };
			if (Object.keys(input).some((key) => !(allowed[tool] ?? []).includes(key))) throw new GitError("invalid_input", "包含此 Git 工具不支持的参数。");
			const lockKey = await this.lockKey(signal);
			const perform = async (): Promise<GitResult> => {
				const status = await this.status(signal);
				switch (tool) {
					case "git_status": return { ok: true, ...status };
					case "git_diff": {
						if (input.staged !== undefined && typeof input.staged !== "boolean") throw new GitError("invalid_input", "staged 必须是布尔值。");
						const selected = input.paths === undefined ? [] : paths(input.paths);
						return { ok: true, diff: await this.git(["-C", status.root, "diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--cached"] : []), "--", ...selected], signal), untracked: status.files.filter((f) => f.index === "?").map((f) => f.path), note: "未跟踪文件只列路径；内容请用文件读取工具核对。" };
					}
					case "git_history": {
						const count = limit(input.limit);
						if (!status.head) return { ok: true, commits: [] };
						const raw = await this.git(["log", `-${count}`, "-z", "--format=%H%x00%an%x00%ae%x00%aI%x00%s"], signal);
						const fields = raw.split("\0"), commits = [];
						for (let i = 0; i + 4 < fields.length; i += 5) commits.push({ commit: fields[i], author: fields[i + 1], email: fields[i + 2], time: fields[i + 3], subject: fields[i + 4] });
						return { ok: true, commits };
					}
					case "git_branches": return { ok: true, current: status.branch, branches: (await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], signal)).trim().split("\n").filter(Boolean) };
					case "git_recovery_points": return { ok: true, points: await this.recoveryPoints(signal) };
				}
				if (!(tool === "git_recover" && input.abortRevert === true)) this.idle(status, ["git_switch", "git_revert", "git_recover"].includes(tool));
				switch (tool) {
					case "git_stage": await this.git(["-C", status.root, "add", "--", ...paths(input.paths)], signal); break;
					case "git_commit": {
						const message = text(input.message, "message");
						if (message.length > 20_000) throw new GitError("invalid_input", "提交信息过长。");
						const selected = input.paths === undefined ? null : await this.selection(status, input.paths, signal);
						const reviewed = selected && input.expectedPaths !== undefined ? await this.selection(status, input.expectedPaths, signal) : selected;
						if (selected && reviewed && selected.paths.some((path) => !reviewed.paths.includes(path))) throw new GitError("invalid_selection", "只能提交本次预览中勾选的文件。");
						if (reviewed && (input.expectedHead !== undefined && input.expectedHead !== reviewed.head || input.expectedFingerprint !== undefined && input.expectedFingerprint !== reviewed.fingerprint)) throw new GitError("changed_since_prepare", "所选文件或仓库已变化，请重新检查改动后再提交。");
						if (selected ? !selected.diff.trim() : !status.files.some((file) => file.index !== " " && file.index !== "?")) throw new GitError("nothing_staged", "没有可提交的所选改动。");
						await this.git(["var", "GIT_AUTHOR_IDENT"], signal); await this.git(["var", "GIT_COMMITTER_IDENT"], signal);
						if (selected) {
							// A staged rename/deletion has already removed its old path from the index.
							const toStage = selected.paths.filter((path) => status.files.some((file) => file.path === path && file.index !== "D"));
							if (toStage.length) await this.git(["-C", status.root, "add", "--", ...toStage], signal);
						}
						await this.git(["-C", status.root, "-c", "commit.gpgSign=false", "commit", "--no-verify", ...(selected ? ["--only"] : []), "-m", message, ...(selected ? ["--", ...selected.paths] : [])], signal); break;
					}
					case "git_branch_create": await this.git(["branch", "--no-track", "--", await this.branch(input.name, signal)], signal); break;
					case "git_switch": {
						const name = await this.branch(input.name, signal);
						await this.git(["show-ref", "--verify", `refs/heads/${name}`], signal);
						point = await this.save("switch", status, signal);
						await this.git(["switch", "--no-guess", "--", name], signal); break;
					}
					case "git_revert": {
						const commit = await this.commitId(input.commit, signal);
						const parents = (await this.git(["rev-list", "--parents", "-n", "1", commit], signal)).trim().split(" ");
						if (parents.length > 2) throw new GitError("merge_commit_unsupported", "首版不回退合并提交；请明确父线后使用人工 Git 流程。");
						await this.git(["var", "GIT_AUTHOR_IDENT"], signal); await this.git(["var", "GIT_COMMITTER_IDENT"], signal);
						point = await this.save("revert", status, signal);
						await this.git(["update-ref", `refs/dreamflutter/revert-target/${point.id}`, commit, ""], signal);
						await this.git(["-c", "commit.gpgSign=false", "revert", "--no-edit", commit], signal); break;
					}
					case "git_recover": {
						const id = text(input.id, "id");
						if (!ID.test(id)) throw new GitError("invalid_input", "无效的恢复点编号。");
						const commit = await this.commitId(`${PREFIX}${id}`, signal);
						if (input.abortRevert !== undefined && typeof input.abortRevert !== "boolean") throw new GitError("invalid_input", "abortRevert 必须是布尔值。");
						if (input.abortRevert === true) {
							const target = await this.commitId(`refs/dreamflutter/revert-target/${id}`, signal);
							if (status.operation !== "REVERT_HEAD" || status.head !== commit || await this.commitId("REVERT_HEAD", signal) !== target) throw new GitError("recovery_mismatch", "仅能明确取消由此恢复点记录、且 HEAD 未移动的本工具回退；未修改仓库。");
							await this.git(["revert", "--abort"], signal);
						}
						const before = await this.status(signal);
						this.idle(before, true);
						point = await this.save("recover", before, signal);
						const name = `dreamflutter-recovered/${Date.now()}-${randomUUID().slice(0, 8)}`;
						await this.git(["switch", "--no-guess", "-c", name, commit], signal);
						return { ok: true, recoveredFrom: id, recoveryPoint: point, ...await this.status(signal) };
					}
				}
				return { ok: true, ...(point ? { recoveryPoint: point } : {}), ...await this.status(signal) };
			};
			return GIT_WRITE_TOOLS.includes(tool) ? await locked(lockKey, perform) : await perform();
		} catch (error) {
			let code = error instanceof GitError ? error.code : "git_failed";
			const reason = error instanceof Error ? error.message : "Git 操作失败。";
			let status: GitStatus | undefined;
			if (point && !signal?.aborted) {
				try { status = await this.status(signal); if (status.conflicts.length) code = "conflict"; } catch {}
			}
			return { ok: false, code, reason, ...(point ? { recoveryPoint: point } : {}), ...(status ? { status } : {}) };
		}
	}
}
