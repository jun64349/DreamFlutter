/** A deliberately small PowerShell literal grammar, not a general-purpose shell parser. */
const approvedCalls = new WeakSet<object>();
export function approveSecurityCall(input: object): void { approvedCalls.add(input); }
export function wasSecurityApproved(input: object): boolean { const allowed = approvedCalls.has(input); approvedCalls.delete(input); return allowed; }

export function literalCommand(command: string): string[] | undefined {
	if (!command.trim() || /[\r\n;|&`$(){}<>\[\]@]/.test(command)) return undefined;
	const words: string[] = [];
	const pattern = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
	let index = 0;
	while (index < command.length) {
		if (!command.slice(index).trim()) break;
		pattern.lastIndex = index;
		const match = pattern.exec(command);
		if (!match || match.index !== index) return undefined;
		words.push(match[1] ?? match[2] ?? match[3]!); index = pattern.lastIndex;
	}
	return words.length ? words : undefined;
}

const COMMANDS: Record<string, Set<string>> = {
	"get-location": new Set(),
	"get-content": new Set(["-literalpath", "-path", "-raw", "-totalcount", "-tail", "-encoding"]),
	"get-childitem": new Set(["-literalpath", "-path", "-file", "-directory", "-name", "-force", "-recurse", "-depth", "-filter"]),
	"get-item": new Set(["-literalpath", "-path", "-force"]),
	"test-path": new Set(["-literalpath", "-path", "-pathtype"]),
};
const GIT: Record<string, Set<string>> = {
	status: new Set(["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]),
	"rev-parse": new Set(["--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--short", "--verify", "--abbrev-ref"]),
};

export function safeLiteralCommand(command: string): boolean {
	const tokens = literalCommand(command);
	if (!tokens) return false;
	const first = tokens[0]!.toLowerCase();
	let args = tokens.slice(1), flags = COMMANDS[first];
	if (first === "git") { flags = GIT[args[0]?.toLowerCase() ?? ""]; args = args.slice(1); }
	if (!flags) return false;
	// Unknown switches, positional command substitutions and aliases never get a free pass.
	return args.every((arg) => !arg.startsWith("-") || flags!.has(arg.toLowerCase()));
}

const POSIX_COMMANDS: Record<string, Set<string>> = {
	pwd: new Set(["-L", "-P"]),
	ls: new Set(["-l", "-a", "-la", "-al", "-h", "-lh", "-alh", "-lah", "-1", "-F", "-d"]),
	cat: new Set(["-n"]),
	head: new Set(["-n"]),
	tail: new Set(["-n"]),
	wc: new Set(["-l", "-w", "-c", "-m"]),
	file: new Set(["-b", "-i"]),
	which: new Set(["-a"]),
	uname: new Set(["-a", "-m", "-s", "-r", "-p"]),
};

/** Conservative POSIX shell literal grammar for non-Windows workbench auto-approval. */
export function safePosixLiteralCommand(command: string): boolean {
	if (!command.trim() || /[\r\n;|&`$(){}<>\[\]@\\~*?]/.test(command)) return false;
	const tokens = literalCommand(command);
	if (!tokens) return false;
	const first = tokens[0]!;
	if (first === "git") {
		const sub = tokens[1]?.toLowerCase() ?? "";
		const flags = GIT[sub];
		if (!flags) return false;
		return tokens.slice(2).every((arg) => !arg.startsWith("-") || flags.has(arg.toLowerCase()));
	}
	const flags = POSIX_COMMANDS[first];
	if (!flags) return false;
	return tokens.slice(1).every((arg) => {
		if (!arg.startsWith("-")) return true;
		if ((first === "head" || first === "tail") && /^-\d+$/.test(arg)) return true;
		return flags.has(arg);
	});
}
