/**
 * DreamFlutter's own model-facing text (dsh-text.ts stays verbatim dsh).
 */

/** Shown in standard mode when the card tool is there: what the window draws from a reply. */
export const RICH_OUTPUT_GUIDANCE = `This app draws some fenced code blocks in your replies as pictures (the user can zoom, copy and save them):
- \`\`\`mermaid: a Mermaid diagram (flowchart, sequence, class, state, gantt, mindmap...).
- \`\`\`svg: one complete <svg> element.
- \`\`\`chart: a chart drawn from your data, as JSON: {"type": "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "radar", "title": "...", "labels": ["x1", "x2"], "series": [{"name": "...", "data": [1, 2]}], "xLabel": "...", "yLabel": "...", "stacked": false, "horizontal": false}. For scatter, data points are {"x": 1, "y": 2}.
Use them when a picture says it better than prose. For something the user interacts with, use show_card instead.`;
