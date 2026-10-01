import { html, type SafeHtml } from "../dom/html.js";

// why: the swatch colour must depend on the id alone, so the same agent keeps its colour across sessions, sorts and page loads
export function avatarHue(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

export function avatarLetter(label: string): string {
  const found = /[\p{L}\p{N}]/u.exec(label);
  const first = found?.[0] ?? [...label][0] ?? "?";
  return [...first.toUpperCase()][0] ?? "?";
}

export function avatar(id: string, label: string, size: number): SafeHtml {
  return html`<span class="av" aria-hidden="true" data-agent-avatar="${id}" style="--h:${avatarHue(id)};--s:${size}px"><span data-avatar-initials>${avatarLetter(label)}</span><img data-avatar-image alt="" hidden></span>`;
}
