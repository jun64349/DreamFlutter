import { CardsModule } from "./cards/cards.ts";
import { Core, type CoreOptions } from "./core.ts";
import { Gateway } from "./gateway/gateway.ts";
import { AutoTitle } from "./modules/auto-title.ts";
import { DocumentsModule } from "./modules/documents.ts";
import { Llm } from "./modules/llm.ts";
import { McpModule } from "./modules/mcp.ts";
import { MemoryModule } from "./modules/memory.ts";
import { Providers } from "./modules/providers.ts";
import { SessionIndex } from "./modules/session-index.ts";
import { SkillsModule } from "./modules/skills.ts";
import { SchedulerModule } from "./modules/scheduler.ts";
import { TasksModule } from "./modules/tasks.ts";
import { SubagentsModule } from "./modules/subagents.ts";
import { VisionModule } from "./modules/vision.ts";
import { registerRenderer } from "./render/renderer.ts";

/** Builds the core with every feature module wired in. */
export function buildCore(options: CoreOptions): Core {
	const core = new Core(options);
	const llm = new Llm(core, options.modelRuntime);
	core.use(new SessionIndex(core));
	const providers = new Providers(core, llm);
	const gateway = new Gateway(core, providers, { transport: options.gatewayTransport });
	llm.extendRuntime = (runtime) => gateway.installRuntime(runtime);
	core.use(gateway);
	core.use(new AutoTitle(core, llm));
	core.use(new MemoryModule(core, llm));
	core.use(new SkillsModule(core, llm));
	const tasks = new TasksModule(core);
	core.use(tasks);
	core.use(new SchedulerModule(core, tasks));
	core.use(new VisionModule(core, llm));
	core.use(new DocumentsModule(core));
	core.use(new CardsModule(core));
	core.use(new SubagentsModule(core));
	registerRenderer(core);
	new McpModule(core);
	return core;
}
