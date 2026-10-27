import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** An `extension_ui_request` record exactly as Pi's RPC mode writes it. */
export type UiRequest = { type: "extension_ui_request"; id: string; method: string } & Record<string, unknown>;

/** The client's `extension_ui_response` record. */
export type UiResponse = { type?: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export type DialogOutcome = "answered" | "cancelled" | "timeout" | "aborted";

export interface UiBridgeHooks {
	emit(record: UiRequest): void;
	dialogOpened?(request: UiRequest): void;
	dialogClosed?(id: string, outcome: DialogOutcome, response?: UiResponse): void;
}

interface PendingDialog {
	request: UiRequest;
	settle(response: UiResponse | undefined, outcome: DialogOutcome): void;
}

/**
 * Pi extension UI over the RPC record protocol (a port of Pi's rpc-mode UI
 * context). Dialogs stay pending until a client answers, so a dialog raised
 * while no window is open is still there when one connects; [replay] re-sends
 * pending dialogs and the latest status/widget state to a newly attached client.
 */
export class UiBridge {
	private readonly hooks: UiBridgeHooks;
	private readonly pending = new Map<string, PendingDialog>();
	private readonly statuses = new Map<string, UiRequest>();
	private readonly widgets = new Map<string, UiRequest>();

	constructor(hooks: UiBridgeHooks) {
		this.hooks = hooks;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	pendingRequests(): UiRequest[] {
		return [...this.pending.values()].map((p) => p.request);
	}

	has(id: string): boolean {
		return this.pending.has(id);
	}

	answer(response: UiResponse): boolean {
		const dialog = this.pending.get(response.id);
		if (!dialog) return false;
		dialog.settle(response, response.cancelled ? "cancelled" : "answered");
		return true;
	}

	/** Resolves every open dialog with its default answer (session closing). */
	cancelAll(): void {
		for (const dialog of [...this.pending.values()]) dialog.settle(undefined, "aborted");
	}

	replay(): UiRequest[] {
		return [...this.statuses.values(), ...this.widgets.values(), ...this.pendingRequests()];
	}

	private send(record: UiRequest): void {
		this.hooks.emit(record);
	}

	private fireAndForget(method: string, fields: Record<string, unknown>): UiRequest {
		const record: UiRequest = { type: "extension_ui_request", id: randomUUID(), method, ...fields };
		this.send(record);
		return record;
	}

	private dialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		fields: Record<string, unknown> & { method: string },
		parse: (response: UiResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = randomUUID();
		const request: UiRequest = { type: "extension_ui_request", id, ...fields };
		return new Promise<T>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => settle(undefined, "aborted");
			const settle = (response: UiResponse | undefined, outcome: DialogOutcome) => {
				if (!this.pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hooks.dialogClosed?.(id, outcome, response);
				resolve(response && outcome === "answered" ? parse(response) : defaultValue);
			};
			this.pending.set(id, { request, settle });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) timer = setTimeout(() => settle(undefined, "timeout"), opts.timeout);
			this.hooks.dialogOpened?.(request);
			this.send(request);
		});
	}

	/** The context handed to `session.bindExtensions`. */
	context(): ExtensionUIContext {
		const bridge = this;
		const ui: ExtensionUIContext = {
			select: (title, options, opts) =>
				bridge.dialog(opts, undefined as string | undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) => r.value),
			confirm: (title, message, opts) =>
				bridge.dialog(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) => r.confirmed === true),
			input: (title, placeholder, opts) =>
				bridge.dialog(opts, undefined as string | undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) => r.value),
			editor: (title, prefill) =>
				bridge.dialog(undefined, undefined as string | undefined, { method: "editor", title, prefill }, (r) => r.value),
			notify(message, type) {
				bridge.fireAndForget("notify", { message, notifyType: type });
			},
			onTerminalInput() {
				return () => {};
			},
			setStatus(key, text) {
				const record = bridge.fireAndForget("setStatus", { statusKey: key, statusText: text });
				if (text === undefined) bridge.statuses.delete(key);
				else bridge.statuses.set(key, record);
			},
			setWorkingMessage() {},
			setWorkingVisible() {},
			setWorkingIndicator() {},
			setHiddenThinkingLabel() {},
			setWidget(key: string, content: unknown, options?: { placement?: string }) {
				if (content !== undefined && !Array.isArray(content)) return;
				const record = bridge.fireAndForget("setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
				if (content === undefined) bridge.widgets.delete(key);
				else bridge.widgets.set(key, record);
			},
			setFooter() {},
			setHeader() {},
			setTitle(title) {
				bridge.fireAndForget("setTitle", { title });
			},
			async custom() {
				return undefined as never;
			},
			pasteToEditor(text) {
				this.setEditorText(text);
			},
			setEditorText(text) {
				bridge.fireAndForget("set_editor_text", { text });
			},
			getEditorText() {
				return "";
			},
			addAutocompleteProvider() {},
			setEditorComponent() {},
			getEditorComponent() {
				return undefined;
			},
			get theme() {
				// The TUI theme singleton is not exported; extensions only need it for terminal rendering.
				return undefined as never;
			},
			getAllThemes() {
				return [];
			},
			getTheme() {
				return undefined;
			},
			setTheme() {
				return { success: false, error: "Theme switching is not supported in DreamFlutter" };
			},
			getToolsExpanded() {
				return false;
			},
			setToolsExpanded() {},
		} as ExtensionUIContext;
		return ui;
	}
}
