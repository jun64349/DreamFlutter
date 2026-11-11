import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { TasksModule } from "../modules/tasks.ts";
import { canonicalPath, pathKey } from "../security/paths.ts";
import { htmlFilesBySession } from "./render-html.ts";
import { sandboxEnv } from "./state.ts";

export class RenderHtmlFilesModule implements CoreModule {
	readonly forSubagents = true;
	private readonly core: Core;

	constructor(core: Core) { this.core = core; }

	extensions({ slotId }: { slotId: string }): ExtensionFactory[] {
		return [pi => {
			pi.on("session_start", (_event, ctx) => {
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
						await writeFile(file, png, { flag: "wx" });
						if (taskId) this.core.module(TasksModule)?.recordArtifact(taskId, file);
						return sandboxDir ? sandboxDir + "/" + name : file;
					};
				});
			});
		}];
	}
}

async function checkDir(dir: string): Promise<void> {
	if (pathKey(await canonicalPath(dir, dir)) !== pathKey(dir)) throw new Error("截图产物目录不能通过符号链接或联接写入。");
}
