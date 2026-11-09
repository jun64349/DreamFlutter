import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { scoreRouting, type RoutingDataset, type RoutingAttempt } from "../src/modules/skill-routing-eval.ts";

const [trace, output] = process.argv.slice(2);
if (!trace || !output) throw new Error("Usage: score-routing-t77.ts <actual-trace.json> <score.json>");
const raw = readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url));
const dataset = JSON.parse(raw.toString("utf8")) as RoutingDataset;
const rawTrace = readFileSync(trace), input = JSON.parse(rawTrace.toString("utf8")) as { attempts: RoutingAttempt[]; datasetSha256: string };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex"), datasetSha256 = hash(raw);
let datasetRevision: Record<string, unknown> | undefined;
if (input.datasetSha256 !== datasetSha256) {
	const approved = JSON.parse(readFileSync(new URL("../../Claude Codex Bridge/T77-dataset-revision.json", import.meta.url), "utf8")) as { beforeSha256: string; afterSha256: string; replacements: number };
	const reverse = raw.toString("utf8").replaceAll("showcard-pro", "showcard_pro");
	const affected = dataset.cases.filter((item) => JSON.stringify(item).includes("showcard-pro")).map((item) => item.id);
	if (approved.replacements !== 6 || approved.beforeSha256 !== input.datasetSha256 || approved.afterSha256 !== datasetSha256 || hash(reverse) !== input.datasetSha256 || input.attempts.some((attempt) => affected.includes(attempt.caseId))) throw new Error("Trace dataset differs; affected cases must be rerun after approval");
	datasetRevision = { traceDatasetSha256: input.datasetSha256, approvedNameOnlyRevision: true, executedInputsAndLabelsUnchanged: true, affectedCasesNotExecuted: affected };
}
const report = { approval: "v0.7 dispatch sections 7–9, 14–15 and user-confirmed six showcard name replacements", datasetSha256, datasetRevision, sourceTraceSha256: hash(rawTrace), ...scoreRouting(dataset, input.attempts) };
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ complete: report.complete, formalPassed: report.formalPassed, strictPassed: report.strictPassed, executedCases: report.executedCases, total: report.total }));
