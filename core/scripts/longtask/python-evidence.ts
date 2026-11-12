function tokensOf(code: string): string[] {
	// Keep quoted strings intact so prose and comments do not become calls.
	return (code.match(/#[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|==|:=|\r?\n|[^\s]/g) ?? [])
		.filter(token => !token.startsWith("#")).map(token => token === "\r\n" ? "\n" : token);
}

const opens = ["(", "[", "{"];
const closes = [")", "]", "}"];

function callArguments(tokens: readonly string[], start: number): string[][] {
	const args: string[][] = [];
	let depth = 0, from = start;
	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!depth && (token === "," || token === ")")) {
			args.push(tokens.slice(from, i));
			if (token === ")") break;
			from = i + 1;
		} else if (opens.includes(token)) depth++;
		else if (closes.includes(token)) depth--;
	}
	return args;
}

export function namesSource(value: unknown): boolean {
	return typeof value === "string" && /(?:^|[/\\])large\.csv$/i.test(value);
}

const literalValue = (token: string) => /^['"]/.test(token) ? token.slice(1, -1) : undefined;
const keyword = (args: string[][], name: string) => args.find(arg => arg[0] === name && arg[1] === "=")?.slice(2);

export function loadsSourceIntoDf(code: string): boolean {
	const tokens = tokensOf(code);
	const sourceNames = new Set<string>();
	let depth = 0, start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		const token = tokens[end] ?? "\n";
		if (opens.includes(token)) depth++;
		if (closes.includes(token)) depth--;
		if (depth || (token !== "\n" && token !== ";")) continue;
		const statement = tokens.slice(start, end).filter(part => part !== "\n");
		start = end + 1;
		const name = statement[0];
		if (!name || !/^[A-Za-z_]\w*$/.test(name) || statement[1] !== "=") continue;
		const rhs = statement.slice(2);
		if (name === "df" && rhs.some((part, i) => {
			if (part !== "read_csv" || rhs[i + 1] !== "(") return false;
			const args = callArguments(rhs, i + 2);
			const source = keyword(args, "filepath_or_buffer") ?? args[0] ?? [];
			return source.some(value => namesSource(literalValue(value))) || (source.length === 1 && sourceNames.has(source[0]!));
		})) return true;
		sourceNames.delete(name);
		if (rhs.some(value => namesSource(literalValue(value)))) sourceNames.add(name);
	}
	return false;
}

export function referencesDf(code: string): boolean {
	const tokens = tokensOf(code);
	return tokens.some((token, i) => (token === "df" && tokens[i - 1] !== "." && tokens[i + 1] !== "=")
		|| (/^(?:f|fr|rf)$/i.test(tokens[i - 1] ?? "") && /(?<!\{)\{\s*df\b/.test(literalValue(token) ?? "")));
}

function isOtherFile(arg: string[] | undefined): boolean {
	// A literal names the file. Treat computed paths as potential source reads.
	const literal = arg?.length === 1 ? literalValue(arg[0]!) : undefined;
	return literal !== undefined && !namesSource(literal);
}

export function readsPythonData(code: string): boolean {
	const tokens = tokensOf(code).filter(token => token !== "\n");
	return tokens.some((token, i) => {
		if (tokens[i + 1] !== "(") return false;
		if (!/^(?:open|read(?:_\w+)?|load(?:_\w+)?)$/.test(token)) return false;
		const args = callArguments(tokens, i + 2);
		if (token !== "open") {
			const path = keyword(args, "filepath_or_buffer") ?? args[0];
			// The nested open call supplies the file evidence for e.g. json.load(open(...)).
			if (path?.includes("open")) return false;
			return !isOtherFile(path);
		}
		const boundOpen = tokens[i - 1] === "." && !["io", "builtins", "os"].includes(tokens[i - 2] ?? "");
		const mode = keyword(args, "mode") ?? args[boundOpen ? 0 : 1];
		const writable = mode?.length === 1 && /^(['"])(?=[waxbt+]*[wax])[waxbt+]+\1$/.test(mode[0]!);
		return !writable && (boundOpen || !isOtherFile(keyword(args, "file") ?? args[0]));
	});
}
