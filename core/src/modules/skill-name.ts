/** Agent Skills names: Unicode alphanumerics, lowercase where applicable, single hyphens, 1–64 characters. */
export function skillNameErrors(value: unknown, directoryName?: string): string[] {
	if (typeof value !== "string" || !value || [...value].length > 64 || value !== value.toLowerCase() || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value)) {
		return ["name 必须为 1–64 个 Unicode 小写字母、数字或单横线，不能以横线开头/结尾或包含连续横线"];
	}
	return directoryName && value !== directoryName ? ["name 必须与技能目录名一致"] : [];
}
