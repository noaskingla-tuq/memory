import { html, type SafeHtml } from "../dom/html.js";

const WIDTH = 84;
const HEIGHT = 24;
const STEP = 6;

export function sparkline(values: readonly number[], label: string): SafeHtml {
  const peak = Math.max(1, ...values);
  const bars = values.map((value, index) => {
    const height = value > 0 ? Math.max(2, Math.round((value / peak) * (HEIGHT - 2))) : 1;
    return value > 0
      ? html`<rect x="${index * STEP}" y="${HEIGHT - height}" width="4.5" height="${height}" rx="1"/>`
      : html`<rect class="zero" x="${index * STEP}" y="${HEIGHT - height}" width="4.5" height="${height}" rx="1"/>`;
  });
  return html`<svg class="spark" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label}">${bars}</svg>`;
}
