import { Core, type CoreOptions } from "./core.ts";
import { fallbackExtension } from "./ext/fallback.ts";
import { AutoTitle } from "./modules/auto-title.ts";
import { Llm } from "./modules/llm.ts";
import { McpModule } from "./modules/mcp.ts";
import { MemoryModule } from "./modules/memory.ts";
import { Providers } from "./modules/providers.ts";
import { SessionIndex } from "./modules/session-index.ts";
import { SkillsModule } from "./modules/skills.ts";
import { SchedulerModule } from "./modules/scheduler.ts";
import { TasksModule } from "./modules/tasks.ts";
import { WebModule } from "./modules/web.ts";

/** Builds the core with every feature module wired in. */
export function buildCore(options: CoreOptions): Core {
	const core = new Core(options);
	const llm = new Llm(core, options.modelRuntime);
	core.use(new SessionIndex(core));
	new Providers(core, llm);
	core.use(new AutoTitle(core, llm));
	core.use(new MemoryModule(core, llm));
	core.use(new SkillsModule(core, llm));
	const tasks = new TasksModule(core);
	core.use(tasks);
	core.use(new SchedulerModule(core, tasks));
	core.use(new WebModule());
	new McpModule(core);
	core.use({ extensions: () => [fallbackExtension(() => core.settings.get().fallbackModels)] });
	return core;
}
