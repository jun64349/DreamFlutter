import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "../../../src/cards/zip.ts";

export const SEED = 0x1052026;
export const SALES_ROWS = 3600;
export const DATA_ROWS = 500_000;
export const SCRIPT_SECONDS = 310;
export const MIN_HEADINGS = 4;
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const sheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";

const zip = (parts: Record<string, string>) => writeZip(Object.entries(parts).map(([name, data]) => ({ name, data: Buffer.from(data) })));
const relation = (target: string, kind = "officeDocument") =>
	`<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/${kind}" Target="${target}"/></Relationships>`;
const types = (parts: Record<string, string>) =>
	`<Types xmlns="${contentTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(parts).map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join("")}</Types>`;
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function makeDocx(sections: readonly { title: string; text: string }[]): Buffer {
	const paragraph = (text: string, heading = false) =>
		`<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
	return zip({
		"[Content_Types].xml": types({ "word/document.xml": "wordprocessingml.document.main", "word/styles.xml": "wordprocessingml.styles" }),
		"_rels/.rels": relation("word/document.xml"),
		"word/_rels/document.xml.rels": relation("styles.xml", "styles"),
		"word/styles.xml": `<w:styles xmlns:w="${wordNamespace}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
		"word/document.xml": `<w:document xmlns:w="${wordNamespace}"><w:body>${sections.map(({ title, text }) => paragraph(title, true) + paragraph(text)).join("")}<w:sectPr/></w:body></w:document>`,
	});
}

function random(seed: number) {
	let state = seed;
	return (max: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return Math.floor(state / 0x1_0000_0000 * max);
	};
}

export interface Month { month: string; units: number; revenue_cents: number }
export interface Group { count: number; sum_cents: number }
export interface Statistics { count: number; sum_cents: number; min_cents: number; max_cents: number; groups: Record<string, Group> }

function sales(): { workbook: Buffer; expected: Month[] } {
	const rng = random(SEED + 2);
	const expected = Array.from({ length: 12 }, (_, i) => ({ month: "2026-" + String(i + 1).padStart(2, "0"), units: 0, revenue_cents: 0 }));
	const rows = [["month", "units", "unit_price_cents"]];
	for (let i = 0; i < SALES_ROWS; i++) {
		const month = expected[rng(12)]!;
		const units = 1 + rng(20), price = 100 + rng(9000);
		month.units += units;
		month.revenue_cents += units * price;
		rows.push([month.month, String(units), String(price)]);
	}
	const sheet = rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => {
		const ref = String.fromCharCode(65 + j) + (i + 1);
		return i > 0 && j > 0 ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
	}).join("")}</row>`).join("");
	return { expected, workbook: zip({
		"[Content_Types].xml": types({ "xl/workbook.xml": "spreadsheetml.sheet.main", "xl/worksheets/sheet1.xml": "spreadsheetml.worksheet" }),
		"_rels/.rels": relation("xl/workbook.xml"),
		"xl/_rels/workbook.xml.rels": relation("worksheets/sheet1.xml", "worksheet"),
		"xl/workbook.xml": `<workbook xmlns="${sheetNamespace}" xmlns:r="${office}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="${sheetNamespace}"><sheetData>${sheet}</sheetData></worksheet>`,
	}) };
}

function data(path: string): Statistics {
	const rng = random(SEED + 3);
	const groups = { A: { count: 0, sum_cents: 0 }, B: { count: 0, sum_cents: 0 }, C: { count: 0, sum_cents: 0 } };
	const expected: Statistics = { count: DATA_ROWS, sum_cents: 0, min_cents: Infinity, max_cents: 0, groups };
	const keys = ["A", "B", "C"] as const;
	const fd = openSync(path, "wx");
	try {
		let chunk = "row_id,group,amount_cents\n";
		for (let i = 1; i <= DATA_ROWS; i++) {
			const key = keys[rng(keys.length)]!, cents = 1 + rng(100_000);
			expected.sum_cents += cents;
			expected.min_cents = Math.min(expected.min_cents, cents);
			expected.max_cents = Math.max(expected.max_cents, cents);
			groups[key].count++;
			groups[key].sum_cents += cents;
			chunk += `${i},${key},${cents}\n`;
			if (i % 8192 === 0) { writeSync(fd, chunk); chunk = ""; }
		}
		writeSync(fd, chunk);
	} finally { closeSync(fd); }
	return expected;
}

export function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export type CaseId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";
export type Answers = { originalDocx?: string; months?: Month[]; statistics?: Statistics };

export function generateFixture(id: CaseId, directory: string): Answers {
	mkdirSync(directory, { recursive: true });
	const file = (name: string, content: string | Buffer) => writeFileSync(join(directory, name), content, { flag: "wx" });
	switch (id) {
		case "L1": {
			const sections = ["范围", "来源", "方法", "发现", "风险", "例外", "交付", "后续"].map((title, index) => ({
				title, text: `合成材料第 ${index + 1} 节。这里描述一项示例办公流程，约定先核对样例，再汇总差异，最后登记检查结果。示例编号 DF-${101 + index}，没有个人信息。`,
			}));
			file("original.docx", makeDocx(sections));
			return { originalDocx: sha256(join(directory, "original.docx")) };
		}
		case "L2": {
			const { workbook, expected } = sales();
			file("sales.xlsx", workbook);
			return { months: expected };
		}
		case "L3": return { statistics: data(join(directory, "large.csv")) };
		case "L4": file("brief.txt", "单页须有标题、简短介绍、数据概览和联系区。保留“合成样例”字样。\n"); break;
		case "L5":
			file("long-job.ps1", `$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::UtcNow
Start-Sleep -Seconds ${SCRIPT_SECONDS}
New-Item -ItemType Directory -Path 'output' -Force | Out-Null
@{ status = 'done'; startedAt = $started.ToUnixTimeMilliseconds(); endedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -LiteralPath 'output/job.json' -Encoding utf8
`);
			break;
		case "L6":
			file("north.csv", "name,value\nNorth,3\n");
			file("south.csv", "name,value\nSouth,5\n");
			break;
		case "L7":
			file("phase-one.txt", "阶段一校对编号 DF-105-A\n");
			file("phase-two.txt", "阶段二校对编号 DF-105-B\n");
			break;
	}
	return {};
}
