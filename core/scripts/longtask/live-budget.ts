import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Transport } from "../../src/gateway/gateway.ts";
import { estimate } from "../../src/ledger/rules.ts";
import { REQUEST_LEDGER_ID } from "../../src/ledger/types.ts";
import { allowance, PER_GOAL_USD, TOTAL_USD } from "./cases.ts";
import { hasFinalUsageFrame, requestEnd, requestFailure, type TransportReceipt } from "./request-evidence.ts";

const MAX_OUTPUT_TOKENS = 4096;
const INPUT_OVERHEAD = 16_384;
const micro = (amount: number) => Math.ceil(amount * 1e6);

type Account = { used: number; held: number; pending: number; receipts: TransportReceipt[]; incomplete: number; denied?: string };
const ledgerIdOf = (options: Parameters<Transport>[2]) => (options as (typeof options & { [REQUEST_LEDGER_ID]?: string }))?.[REQUEST_LEDGER_ID];

export class LiveBudget {
	private readonly totalUsd: number;
	private provider?: string;
	private modelId?: string;
	private current?: Account;
	private used = 0;
	private held = 0;
	private fatal?: string;

	constructor(totalUsd = TOTAL_USD) { this.totalUsd = totalUsd; }

	configure(provider: string, modelId: string) {
		this.provider = provider;
		this.modelId = modelId;
	}

	observeGateway(runtime: Pick<ModelRuntime, "registerProvider">): void {
		const register = runtime.registerProvider.bind(runtime);
		runtime.registerProvider = (provider, config) => {
			const send = config.streamSimple;
			if (!send || provider !== this.provider) return register(provider, config);
			return register(provider, { ...config, streamSimple: (model, context, options) => {
				const account = this.current;
				const ledgerId = ledgerIdOf(options);
				const finish = (stop?: string, error?: string) => {
					if (!account || !ledgerId || account.receipts.some(receipt => receipt.ledgerId === ledgerId)) return;
					const end = requestEnd(stop, error, options?.signal);
					const status = end === "异常结束" ? "被拒" : end;
					account.receipts.push({ ledgerId, status, transport: false, finalUsage: false,
						...(status === "被拒" && { failure: requestFailure(error, false) }) });
				};
				const stream = send(model, context, options);
				void stream.result().then(message => finish(message?.stopReason, message?.errorMessage),
					error => finish(undefined, error instanceof Error ? error.message : undefined));
				return stream;
			} });
		};
	}

	remaining() { return allowance(this.used / 1e6, this.held / 1e6, this.totalUsd); }
	stopped() { return this.fatal ?? (this.remaining() === 0 ? "整轮预算已用完" : undefined); }

	begin() {
		if (this.current?.pending) throw new Error("上一项目标仍有请求未结算");
		this.current = { used: 0, held: 0, pending: 0, receipts: [], incomplete: 0 };
	}

	snapshot() {
		const account = this.current;
		const receipts = account?.receipts ?? [];
		return { budgetUsd: ((account?.used ?? 0) + (account?.held ?? 0)) / 1e6,
			requests: receipts.filter(receipt => receipt.transport).length, receipts, pending: account?.pending ?? 0,
			incomplete: account?.incomplete ?? 0, denied: account?.denied };
	}

	transport: Transport = (model, context, options) => {
		const account = this.current;
		const receipt: TransportReceipt = { ledgerId: ledgerIdOf(options), status: "被拒", finalUsage: false, transport: false,
			failure: { category: "无法归类", notSent: "试跑限制" } };
		account?.receipts.push(receipt);
		if (!account || model.provider !== this.provider || model.id !== this.modelId) throw new Error("试跑只允许已选的 OpenCode Go 模型");
		if (this.fatal) throw new Error(this.fatal);
		if (!priced(model)) {
			this.fatal = "模型缺少可核对的价格，已停止试跑";
			throw new Error(this.fatal);
		}
		const input = Math.min(model.contextWindow, Buffer.byteLength(JSON.stringify(context)) + INPUT_OVERHEAD);
		const output = Math.min(options?.maxTokens ?? MAX_OUTPUT_TOKENS, model.maxTokens, MAX_OUTPUT_TOKENS);
		const rates = model.cost;
		const reserved = micro((input * Math.max(rates.input, rates.cacheRead, rates.cacheWrite) + output * rates.output) / 1e6);
		const roundAvailable = micro(this.totalUsd) - this.used - this.held;
		const caseAvailable = micro(PER_GOAL_USD) - account.used - account.held;
		if (reserved > Math.min(roundAvailable, caseAvailable)) {
			const roundLimit = reserved > roundAvailable;
			account.denied = roundLimit ? `下一请求的预留会超过整轮 $${this.totalUsd} 上限` : "下一请求的预留会超过单目标 $0.50 上限";
			if (roundLimit) this.fatal = account.denied;
			throw new Error(account.denied);
		}
		this.held += reserved;
		account.held += reserved;
		account.pending++;
		receipt.transport = true;
		receipt.status = "中断";
		delete receipt.failure;
		let httpStatus: number | undefined;
		const recordEnd = (stop: string | undefined, error: unknown) => {
			const message = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
			receipt.status = requestEnd(stop, message, options?.signal);
			if (receipt.status !== "正常结束" && receipt.status !== "中断") {
				receipt.failure = requestFailure(httpStatus && httpStatus >= 400 ? { message, status: httpStatus } : error, true);
			}
		};
		const settle = (amount?: number) => {
			this.held -= reserved;
			account.held -= reserved;
			account.pending--;
			const charged = amount === undefined ? reserved : micro(amount);
			account.used += charged;
			this.used += charged;
			if (amount === undefined) account.incomplete++;
			if (charged > reserved) this.fatal = "供应商返回用量超过请求预留，已停止后续请求";
		};
		try {
			const response = streamSimple(model, context, { ...options, maxTokens: output, maxRetries: 0,
				fetch: async (input, init) => {
					const response = await (options?.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
					httpStatus = response.status;
					return response;
				},
				onProviderStreamEvent: (event, actualModel) => {
					if (hasFinalUsageFrame(event)) receipt.finalUsage = true;
					return options?.onProviderStreamEvent?.(event, actualModel);
				} });
			void response.result().then(message => {
				recordEnd(message.stopReason, message.errorMessage);
				const usage = message.usage;
				const amount = receipt.finalUsage && usage ? estimate(model, usage) : null;
				settle(amount ?? undefined);
			}, (error: unknown) => {
				recordEnd(undefined, error);
				settle();
			});
			return response;
		} catch (error) {
			recordEnd(undefined, error);
			settle();
			throw error;
		}
	};
}

export function priced(model: Model<string>) {
	if (!model.cost || model.cost.tiers?.length) return false;
	const { input, output, cacheRead, cacheWrite } = model.cost;
	const rates = [input, output, cacheRead, cacheWrite];
	return rates.every(rate => Number.isFinite(rate) && rate >= 0)
		&& rates.some(rate => rate > 0) && model.contextWindow > 0 && model.maxTokens > 0;
}
