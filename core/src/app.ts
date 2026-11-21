import { BackupModule } from "./backup/backup.ts";
import { CardsModule } from "./cards/cards.ts";
import { Core, type CoreOptions } from "./core.ts";
import { Gateway } from "./gateway/gateway.ts";
import { PiMigration } from "./gateway/pi-migration.ts";
import { AutoTitle } from "./modules/auto-title.ts";
import { ButterflyModule } from "./modules/butterfly.ts";
import { DocumentsModule } from "./modules/documents.ts";
import { Llm } from "./modules/llm.ts";
import { McpModule } from "./modules/mcp.ts";
import { declareMemoryBackup, MemoryModule } from "./modules/memory.ts";
import { readSystemPlugins } from "./dsh/system-plugins.ts";
import { PluginManager } from "./dsh/plugins/manager.ts";
import { ContextModule } from "./modules/context.ts";
import { Providers } from "./modules/providers.ts";
import { SessionIndex } from "./modules/session-index.ts";
import { SkillsModule } from "./modules/skills.ts";
import { SchedulerModule } from "./modules/scheduler.ts";
import { TasksModule } from "./modules/tasks.ts";
import { SubagentsModule } from "./modules/subagents.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { MacSeatbeltSandbox } from "./sandbox/seatbelt.ts";
import { WindowsAppContainerSandbox } from "./sandbox/appcontainer-module.ts";
import { VisionModule } from "./modules/vision.ts";
import { registerRenderer } from "./render/renderer.ts";
import { StorageModule } from "./storage/storage.ts";
import { WebSearchModule } from "./modules/search.ts";
import { PackageSourcesModule } from "./modules/package-sources.ts";
import { Ledger } from "./ledger/ledger.ts";
import { UpdateModule } from "./update/module.ts";
import { AttentionModule } from "./modules/attention.ts";
import { SetupModule } from "./modules/setup.ts";
import { GitWindow } from "./git/window.ts";
import { VoiceModule } from "./modules/voice/index.ts";
import { registerUninstall } from "./uninstall/index.ts";
import { join } from "node:path";
import { DshBackend } from "./dsh/backend.ts";

/** Builds the core with every feature module wired in. */
export function buildCore(options: CoreOptions): Core {
	const plugins = readSystemPlugins(options.paths.dataDir);
	const core = new Core(options);
	core.use(new Ledger(core), "dfLedger");
	core.use(new PackageSourcesModule(core), "dfPackageSources");
	const llm = new Llm(core, options.modelRuntime);
	core.use(new GitWindow(core, llm), "dfGit");
	core.use(new SessionIndex(core), "dfSessionIndex");
	const providers = new Providers(core, llm);
	const gateway = new Gateway(core, providers, { transport: options.gatewayTransport });
	core.use(new PiMigration(core, providers, gateway, options.piMigration), "dfPiMigration");
	llm.extendRuntime = (runtime) => gateway.installRuntime(runtime);
	core.use(gateway, "dfGateway", ["dfLedger"]);
	core.use(new DshBackend(core.cordis, join(core.sessionDir ?? join(core.agentDir, "sessions"), ".dsh"), {
		runtime: (signal) => llm.runtime(signal),
	}), "dfDsh", ["dfGateway"]);
	core.use(new AutoTitle(core, llm), "dfAutoTitle", ["dfGateway"]);
	declareMemoryBackup(core);
	if (plugins.dfMemory) {
		const memory = new MemoryModule(core, llm);
		memory.seedPlatformDefaults = options.platformMemory === true;
		core.use(memory, "dfMemory", ["dfGateway"]);
	}
	core.use(new PluginManager(core, plugins), "dfPluginManager", ["dfDsh", "dfLedger"]);
	core.use(new ContextModule(core, llm), "dfContext", ["dfGateway"]);
	core.use(new SkillsModule(core, llm), "dfSkills", ["dfGateway"]);
	const tasks = new TasksModule(core);
	core.use(tasks, "dfTasks");
	core.use(new SchedulerModule(core, tasks), "dfScheduler", ["dfTasks"]);
	core.use(new ButterflyModule(core, tasks, llm), "dfButterfly", ["dfTasks", "dfGateway"]);
	core.use(new VisionModule(core, llm), "dfVision", ["dfGateway"]);
	core.use(new DocumentsModule(core), "dfDocuments");
	core.use(new CardsModule(core), "dfCards");
	core.use(new SubagentsModule(core), "dfSubagents");
	if (process.platform === "win32") {
		const sandbox = options.sandbox ? new Sandbox(core, options.sandbox) : new WindowsAppContainerSandbox(core);
		core.use(sandbox, "dfSandbox");
	}
	else if (process.platform === "darwin") core.use(new MacSeatbeltSandbox(core), "dfSandbox");
	core.use(new BackupModule(core, options.legacyData), "dfBackup");
	core.use(new StorageModule(core), "dfStorage");
	core.use(new WebSearchModule(core, options.webSearch), "dfWebSearch");
	core.use(new UpdateModule(core, options.updates), "dfUpdates");
	registerRenderer(core);
	core.use(new McpModule(core), "dfMcp");
	core.use(new AttentionModule(core, tasks), "dfAttention", ["dfTasks"]);
	core.use(new SetupModule(core, gateway), "dfSetup", ["dfGateway"]);
	core.use(new VoiceModule(core), "dfVoice");
	registerUninstall(core);
	return core;
}
