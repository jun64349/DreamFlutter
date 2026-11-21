const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    const rows = [];
    for (const format of ['cjs', 'mjs']) {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat-manifest.json'), 'utf8'));
        for (const hostApi of [1, 2]) {
            for (const enabled of [false, true]) {
                let invoked = false;
                let result = 'disabled';
                if (enabled) {
                    if (manifest.apiVersion !== hostApi) result = 'unsupported_api';
                    else {
                        const entry = format === 'cjs' ? require('./compat-plugin.cjs') : await import('./compat-plugin.mjs');
                        result = entry.formatTemperature(20);
                        invoked = true;
                        assert.equal(result, '20 °C');
                    }
                }
                rows.push({ format, hostApi, enabled, invoked, result });
            }
        }
    }
    const evidence = { runtime: process.version, platform: process.platform, rows };
    fs.writeFileSync(path.join(__dirname, 'compat-results.json'), JSON.stringify(evidence, null, 2) + '\n');
    const report = [
        '# 温度格式化插件兼容性', '', `运行时 ${evidence.runtime}，平台 ${evidence.platform}。`, '',
        '在原生 Windows 工作区执行合成插件，分别用 CommonJS 和 ESM 加载同一个格式化功能。',
        '两个合成宿主 API 分别声明版本 1 和 2。只有版本 2 支持该插件。停用或不兼容时不调用插件。',
        '', '| 模块 | 宿主 API | 启用 | 实际调用 | 结果 |', '| --- | ---: | --- | --- | --- |',
        ...rows.map(row => `| ${row.format} | ${row.hostApi} | ${row.enabled} | ${row.invoked} | ${row.result} |`),
        '', '把交付文件放到同一目录后运行 `node compat-check.cjs`。明细保存在 [JSON](compat-results.json)。', '',
    ];
    fs.writeFileSync(path.join(__dirname, 'compat-report.md'), report.join('\n'));
    console.log(`Verified ${rows.length} plugin cases under ${evidence.runtime}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
