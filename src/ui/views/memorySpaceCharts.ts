import { html, type SafeHtml } from "../dom/html.js";

const CHART_HEIGHT = 56;

function column(value: number, peak: number, tip: string): SafeHtml {
  const height = value > 0 ? Math.max(3, Math.round((value / peak) * CHART_HEIGHT)) : 1;
  return value > 0 ? html`<i title="${tip}" style="height:${height}px"></i>` : html`<i class="zero" title="${tip}" style="height:${height}px"></i>`;
}

// why: the columns only carry mouse tooltips, so the whole chart is one image whose label already says the total and the peak
export function columnChart(values: readonly number[], label: string, tipOf: (value: number, index: number) => string): SafeHtml {
  const peak = Math.max(1, ...values);
  return html`<div class="cols" role="img" aria-label="${label}">${values.map((value, index) => column(value, peak, tipOf(value, index)))}</div>`;
}

export function axis(labels: readonly string[]): SafeHtml {
  return html`<div class="axis" aria-hidden="true">${labels.map((label) => html`<span>${label}</span>`)}</div>`;
}

function fill(percent: number): number {
  return percent <= 0 ? 0 : Math.max(3, Math.min(100, Math.round(percent)));
}

function rowParts(label: string, hint: string, value: string, percent: number): SafeHtml {
  return html`<span class="lbl" title="${hint}">${label}</span><span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${fill(percent)}%"></span></span><span class="bar-val">${value}</span>`;
}

export function barRow(label: string, hint: string, value: string, percent: number): SafeHtml {
  return html`<li class="bar-row">${rowParts(label, hint, value, percent)}</li>`;
}

// why: the scope and project id stay on the row so the timeline slice (S6c) can turn a row into a filter without re-deriving them from the label
export function spaceBarRow(label: string, hint: string, value: string, percent: number, scope: string, projectId: string): SafeHtml {
  return html`<li class="bar-row" data-scope="${scope}" data-project-id="${projectId}">${rowParts(label, hint, value, percent)}</li>`;
}
