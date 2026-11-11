import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { TasksModule } from "../modules/tasks.ts";
import { pythonFilesBySession } from "./python-kernel.ts";
import { sandboxEnv } from "./state.ts";

/** Bind the kernel's files to the same outbox and artifact rules as other butterfly tools. */
export class PythonFilesModule implements CoreModule {
	readonly forSubagents = true;
	private readonly core: Core;

	constructor(core: Core) { this.core = core; }

	extensions({ slotId }: { slotId: string }): ExtensionFactory[] {
		return [pi => {
			pi.on("session_start", (_event, ctx) => {
				pythonFilesBySession.set(ctx.sessionManager, sessionId => {
					const slot = this.core.slots.get(slotId);
					const taskId = slot?.currentRun?.taskId ?? slot?.taskId;
					const distro = this.core.sandboxProvider?.()?.distro;
					const scope = taskId ?? sessionId;
					if (!slot?.sandboxed || slot.incognito || !distro || !/^[\w-]+$/.test(scope)) return { folder: null, record: () => {} };
					return {
						folder: "/workspace/outbox/" + scope,
						record: path => {
							if (taskId) this.core.module(TasksModule)?.recordArtifact(taskId, sandboxEnv(distro).local(path));
						},
					};
				});
			});
		}];
	}
}
