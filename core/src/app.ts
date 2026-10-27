import { Core, type CoreOptions } from "./core.ts";
import { SessionIndex } from "./modules/session-index.ts";

/** Builds the core with every feature module wired in. */
export function buildCore(options: CoreOptions): Core {
	const core = new Core(options);
	core.use(new SessionIndex(core));
	return core;
}
