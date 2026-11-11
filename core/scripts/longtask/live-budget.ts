import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Transport } from "../../src/gateway/gateway.ts";
import { estimate } from "../../src/ledger/rules.ts";
import { allowance, PER_GOAL_USD, TOTAL_USD } from "./cases.ts";

const MAX_OUTPUT_TOKENS = 4096;
const INPUT_OVERHEAD = 16_384;
const micro = (amount: number) => Math.ceil(amount * 1e6);

type Account = { used: number; held: number; requests: number; incomplete: number; denied?: string };

export class LiveBudget {
	private provider?: string;
	private modelId?: string;
	private current?: Account;
	private used = 0;
	private held = 0;
	private fatal?: string;

	configure(provider: string, modelId: string) {
		this.provider = provider;
		this.modelId = modelId;
	}

	remaining() { return allowance(this.used / 1e6, this.held / 1e6); }
	stopped() { return this.fatal ?? (this.remaining() === 0 ? "整轮预算已用完" : undefined); }

	begin() {
		if (this.held) throw new Error("上一项目标仍有请求未结算");
		this.current = { used: 0, held: 0, requests: 0, incomplete: 0 };
	}

	snapshot() {
		const account = this.current;
		return { budgetUsd: ((account?.used ?? 0) + (account?.held ?? 0)) / 1e6,
			requests: account?.requests ?? 0, incomplete: account?.incomplete ?? 0, denied: account?.denied };
	}

	transport: Transport = (model, context, options) => {
		const account = this.current;
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
		const roundAvailable = micro(TOTAL_USD) - this.used - this.held;
		const caseAvailable = micro(PER_GOAL_USD) - account.used - account.held;
		if (reserved > Math.min(roundAvailable, caseAvailable)) {
			const roundLimit = reserved > roundAvailable;
			account.denied = roundLimit ? "下一请求的预留会超过整轮 $3 上限" : "下一请求的预留会超过单目标 $0.50 上限";
			if (roundLimit) this.fatal = account.denied;
			throw new Error(account.denied);
		}
		this.held += reserved;
		account.held += reserved;
		account.requests++;
		const settle = (amount?: number) => {
			this.held -= reserved;
			account.held -= reserved;
			const charged = amount === undefined ? reserved : micro(amount);
			account.used += charged;
			this.used += charged;
			if (amount === undefined) account.incomplete++;
			if (charged > reserved) this.fatal = "供应商返回用量超过请求预留，已停止后续请求";
		};
		try {
			const response = streamSimple(model, context, { ...options, maxTokens: output });
			void response.result().then(message => {
				const usage = message.usage;
				const amount = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(tokens => tokens > 0)
					? estimate(model, usage) : null;
				settle(amount ?? undefined);
			}, () => settle());
			return response;
		} catch (error) {
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
