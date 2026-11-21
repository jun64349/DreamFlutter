import { AsyncLocalStorage } from "node:async_hooks";

const session = new AsyncLocalStorage<string>();

/** Supply the owning session to the gateway's programmatic virtual model route. */
export function withDshRouteSession<T>(id: string | undefined, resolve: () => T): T {
	return id ? session.run(id, resolve) : resolve();
}

export function dshRouteSessionId(): string | undefined {
	return session.getStore();
}
