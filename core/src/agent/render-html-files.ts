import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { GoalsModule } from "../modules/goals.ts";
import { goalPath } from "../modules/goals/acceptance.ts";
import { TasksModule } from "../modules/tasks.ts";
import { canonicalPath, pathKey } from "../security/paths.ts";
import { pythonCleanupLogBySession } from "./python-kernel.ts";
import { htmlFilesBySession, htmlGoalBySession, htmlLogBySession } from "./render-html.ts";
import { sandboxEnv } from "./state.ts";

export class RenderHtmlFilesModule implements CoreModule {
	readonly forSubagents = true;
	private readonly core: Core;

	constructor(core: Core) { this.core = core; }

	extensions({ slotId }: { slotId: string }): ExtensionFactory[] {
		return [pi => {
			pi.on("session_start", (_event, ctx) => {
				pythonCleanupLogBySession.set(ctx.sessionManager, (message, detail) => this.core.log.error(message, detail));
				htmlLogBySession.set(ctx.sessionManager, (url, reason, error) => {
					if (error !== undefined) {
						const original = error instanceof Error && error.cause !== undefined ? error.cause : error;
						this.core.log.warn(reason, { url, error: original instanceof Error ? original.stack ?? original.message : original });
					}
					else this.core.log.info("HTML 截图拦截资源", { url, reason });
				});
				htmlGoalBySession.set(ctx.sessionManager, () => {
					const goals = this.core.module(GoalsModule);
					if (!goals?.executor.ownsSlot(slotId)) return;
					const slot = this.core.slots.get(slotId);
					const goal = slot && goals.scheduler.goalForSlot(slot);
					if (!goal) return async () => false;
					return async (requested, actual) => {
						const allowed = await goalPath(this.core, goal.scope, requested);
						return allowed !== null && pathKey(allowed) === pathKey(actual);
					};
				});
				htmlFilesBySession.set(ctx.sessionManager, sessionId => {
					const slot = this.core.slots.get(slotId);
					if (!slot || slot.incognito) return;
					const taskId = slot.currentRun?.taskId ?? slot.taskId;
					const scope = slot.sandboxed ? taskId ?? sessionId : sessionId;
					if (!/^[\w-]+$/.test(scope)) return;
					const distro = slot.sandboxed ? this.core.sandboxProvider?.()?.distro : undefined;
					if (slot.sandboxed && !distro) return;
					const sandboxDir = distro ? "/workspace/outbox/" + scope : undefined;
					const dir = distro ? sandboxEnv(distro).local(sandboxDir!) : join(this.core.paths.dataDir, "artifacts", scope);
					return async (png, signal) => {
						await checkDir(dir);
						signal.throwIfAborted();
						await mkdir(dir, { recursive: true });
						await checkDir(dir);
						signal.throwIfAborted();
						const name = "html-" + randomUUID() + ".png";
						const file = join(dir, name);
						const handle = await open(file, "wx");
						const discard = () => rm(file, { force: true });
						try {
							try { await writeFile(handle, png, { signal }); }
							finally { await handle.close(); }
						} catch (error) {
							await discard().catch(cleanup => this.core.log.warn("删除未登记的截图失败", cleanup));
							throw error;
						}
						return { path: sandboxDir ? sandboxDir + "/" + name : file, discard,
							record: () => { if (taskId) this.core.module(TasksModule)?.recordArtifact(taskId, file); } };
					};
				});
			});
		}];
	}
}

async function checkDir(dir: string): Promise<void> {
	if (pathKey(await canonicalPath(dir, dir)) !== pathKey(dir)) throw new Error("截图产物目录不能通过符号链接或联接写入。");
}
