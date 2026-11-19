import { posix } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { TasksModule } from "../modules/tasks.ts";
import { pythonFilesBySession } from "./python-kernel.ts";
import { resolveSandboxEnv } from "./state.ts";

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
					const provider = this.core.sandboxProvider?.();
					const scope = taskId ?? sessionId;
					if (!slot?.sandboxed || slot.incognito || !provider || !/^[\w-]+$/.test(scope)) return { folder: null, record: () => {} };
					const root = (provider.workspaceDir ?? "/workspace").replaceAll("\\", "/");
					const env = resolveSandboxEnv(provider);
					return {
						folder: posix.join(root, "outbox", scope),
						record: path => {
							if (taskId) this.core.module(TasksModule)?.recordArtifact(taskId, env.local(path));
						},
					};
				});
			});
		}];
	}
}
