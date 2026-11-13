import { RpcError, type Client, type Core } from "../../core.ts";

export function requireUser(core: Core, client: Client | undefined): void {
	if (!client || !core.clients.has(client)) throw new RpcError("forbidden", "这项设置由用户在窗口里修改");
	if (core.maintenance) throw new RpcError("busy", "正在维护数据");
}
