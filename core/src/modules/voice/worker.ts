import { loadEngine } from "./engine.ts";
import type { Transcript } from "./provider.ts";

type Command = { id: number; action: "open" | "chunk" | "end"; pcm?: Buffer };
let engine: ReturnType<typeof loadEngine> | undefined;
process.on("disconnect", () => process.exit(0));
process.on("message", (command: Command) => {
	try {
		engine ??= loadEngine(process.argv[2]!);
		let results: Transcript[] = [];
		switch (command.action) {
			case "open": engine.reset(); break;
			case "chunk": results = engine.chunk(command.pcm!); break;
			case "end": results = engine.end(); break;
		}
		process.send?.({ id: command.id, results });
	} catch (error) {
		process.send?.({ id: command.id, missing: error instanceof Error && error.message === "missing", failed: true });
	}
});

