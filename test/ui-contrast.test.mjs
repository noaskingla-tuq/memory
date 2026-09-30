import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_ROOT } from "./uiViewHarness.mjs";

const STYLES = join(UI_ROOT, "styles");
const tokensCss = readFileSync(join(STYLES, "tokens.css"), "utf8");
const appCss = readFileSync(join(STYLES, "app.css"), "utf8");

function declarations(block) {
  const found = new Map();
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gu)) found.set(match[1], match[2].trim());
  return found;
}

function themes() {
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/u.exec(tokensCss);
  const light = /^:root \{([\s\S]*?)\n\}/u.exec(tokensCss);
  assert.ok(light !== null && dark !== null, "tokens.css has a light :root block and a prefers-color-scheme dark block");
  const lightValues = declarations(light[1]);
  return { light: lightValues, dark: new Map([...lightValues, ...declarations(dark[1])]) };
}

const THEMES = themes();

function resolve(theme, name, depth = 0) {
  assert.ok(depth < 8, `--${name} resolves`);
  const raw = THEMES[theme].get(name);
  assert.ok(raw !== undefined, `--${name} is defined for ${theme}`);
  const reference = /^var\(--([a-z0-9-]+)\)$/u.exec(raw);
  return reference === null ? raw : resolve(theme, reference[1], depth + 1);
}

function rgb(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/iu, `${hex} is a 6-digit hex colour`);
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function luminance([red, green, blue]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function ratio(foreground, background) {
  const first = luminance(rgb(foreground));
  const second = luminance(rgb(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const contrast = (theme, foreground, background) => ratio(resolve(theme, foreground), resolve(theme, background));

const SURFACES = ["surface", "surface-sunken", "surface-muted", "accent-tint"];
const READABLE_ON_ALL = ["text-primary", "text-secondary-strong", "link"];
const READABLE_ON_PLAIN = ["text-secondary"];
const STATUS_ON = ["surface", "surface-sunken"];
const FILLED = [
  ["accent-fg", "accent"],
  ["accent-fg", "accent-hover"],
  ["danger-fg", "error-strong"],
  ["hit-fg", "hit-bg"],
  ["error-strong", "error-tint"],
];

test("every text colour reaches 4.5:1 on the surfaces it is allowed on, in the light and the dark scheme", () => {
  for (const theme of ["light", "dark"]) {
    for (const foreground of READABLE_ON_ALL) for (const background of SURFACES) assert.ok(contrast(theme, foreground, background) >= 4.5, `${theme}: --${foreground} on --${background} is ${contrast(theme, foreground, background).toFixed(2)}`);
    for (const foreground of READABLE_ON_PLAIN) for (const background of ["surface", "surface-sunken"]) assert.ok(contrast(theme, foreground, background) >= 4.5, `${theme}: --${foreground} on --${background} is ${contrast(theme, foreground, background).toFixed(2)}`);
    for (const foreground of ["error-strong", "warning-strong", "success-strong"]) for (const background of STATUS_ON) assert.ok(contrast(theme, foreground, background) >= 4.5, `${theme}: --${foreground} on --${background} is ${contrast(theme, foreground, background).toFixed(2)}`);
    for (const [foreground, background] of FILLED) assert.ok(contrast(theme, foreground, background) >= 4.5, `${theme}: --${foreground} on --${background} is ${contrast(theme, foreground, background).toFixed(2)}`);
  }
});

test("the focus ring colour reaches 3:1 on every surface in both schemes", () => {
  for (const theme of ["light", "dark"]) for (const background of SURFACES) assert.ok(contrast(theme, "link", background) >= 3, `${theme}: focus ring on --${background}`);
});

test("--text-muted and --accent-hover fail as text, which is why they are banned, and --link replaces the accent as link colour", () => {
  assert.equal(contrast("light", "text-muted", "surface").toFixed(2), "2.61");
  assert.equal(contrast("light", "accent-hover", "surface").toFixed(2), "2.94");
  assert.ok(contrast("light", "text-muted", "surface") < 4.5);
  assert.ok(contrast("light", "accent-hover", "surface") < 4.5);
  assert.ok(contrast("light", "accent", "surface") < 4.5);
  assert.ok(contrast("light", "on-accent", "accent") < 4.5);
  assert.ok(contrast("dark", "text-muted", "surface") < 4.5);
  assert.equal(resolve("light", "link"), "#1d72a8");
  assert.equal(resolve("dark", "link"), "#7cc4ee");
  assert.notEqual(resolve("light", "link"), resolve("light", "accent-hover"));
});

function textColorUses(css) {
  const uses = [];
  for (const match of css.matchAll(/(^|[;{\s])color:\s*([^;}]+)[;}]/gu)) uses.push(match[2].trim());
  return uses;
}

const TEXT_TOKENS = new Set(["text-primary", "text-secondary", "text-secondary-strong", "link", "error-strong", "warning-strong", "success-strong", "accent-fg", "danger-fg", "hit-fg"]);

test("no rule sets a text colour from a token that fails as text, and every text token used is one the contrast matrix covers", () => {
  const uses = textColorUses(appCss);
  assert.ok(uses.length >= 8, "app.css sets text colours");
  for (const value of uses) {
    if (value === "inherit") continue;
    const reference = /^var\(--([a-z0-9-]+)\)$/u.exec(value);
    assert.ok(reference !== null, `text colour ${value} must come from a token`);
    assert.ok(TEXT_TOKENS.has(reference[1]), `--${reference[1]} is not an allowed text colour`);
  }
  for (const banned of ["text-muted", "accent-hover", "accent", "on-accent"]) assert.ok(!uses.includes(`var(--${banned})`), `--${banned} is never a text colour`);
  const tokenSet = new Set([...appCss.matchAll(/var\(--([a-z0-9-]+)\)/gu)].map((match) => match[1]));
  for (const name of tokenSet) assert.ok(THEMES.light.has(name), `app.css uses --${name} which tokens.css defines`);
});

test("app.css writes no colour of its own outside the two overlay shadows", () => {
  const hex = appCss.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
  assert.deepEqual(hex, []);
  const functions = appCss.match(/\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gu) ?? [];
  assert.ok(functions.every((entry) => entry.startsWith("rgba(0, 0, 0,")), functions.join(", "));
});

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test("the theme follows prefers-color-scheme alone: no data-theme selector, class switch or script toggle exists in the UI", () => {
  assert.match(tokensCss, /color-scheme: light dark;/u);
  assert.match(tokensCss, /@media \(prefers-color-scheme: dark\)/u);
  assert.equal((tokensCss.match(/@media/gu) ?? []).length, 1);
  for (const file of walk(UI_ROOT)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/data-theme|\.dark\b|classList\.(?:add|toggle)\(["']dark/u.test(text), `${file} does not switch the theme by hand`);
  }
  assert.ok(!/html\[data-theme/u.test(appCss));
});

test("the contrast maths matches the design's reference figures", () => {
  assert.equal(ratio("#ffffff", "#000000").toFixed(2), "21.00");
  assert.equal(ratio("#737373", "#ffffff").toFixed(2), "4.74");
});
