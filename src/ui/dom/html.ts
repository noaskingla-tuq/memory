const MINT = Symbol("safe-html");

export class SafeHtml {
  readonly value: string;

  constructor(token: symbol, value: string) {
    if (token !== MINT) throw new TypeError("SafeHtml can only be produced by the html template tag");
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return value instanceof SafeHtml;
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/gu, (char) => ESCAPES[char] as string);
}

type State = "text" | "lt" | "tagName" | "closeTag" | "tag" | "attrName" | "attrEnd" | "afterEq" | "dq" | "sq" | "uq" | "comment" | "rawScript" | "rawText";

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "action", "formaction", "xlink:href", "srcset", "poster", "data"]);
const UNSAFE_URL = /^(?:javascript|vbscript|data):/u;
const SAFE_STYLE_VALUE = /^[A-Za-z0-9#%.\- ]*$/u;
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["textarea", "title"]);
const RAW_SCRIPT_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

class Scanner {
  state: State = "text";
  tag = "";
  attr = "";
  valueLength = 0;
  private rawTail = "";
  private commentTail = "";

  feed(chunk: string): void {
    for (const char of chunk) this.step(char);
  }

  private endTag(): void {
    if (RAW_SCRIPT_TAGS.has(this.tag)) this.state = "rawScript";
    else if (RAW_TEXT_TAGS.has(this.tag)) this.state = "rawText";
    else this.state = "text";
    this.rawTail = "";
  }

  private finishAttribute(): void {
    if (this.attr.startsWith("on")) throw new TypeError(`html: event handler attribute ${this.attr} is not allowed`);
  }

  private startAttribute(char: string): void {
    this.state = "attrName";
    this.attr = char.toLowerCase();
  }

  private step(char: string): void {
    const space = /\s/u.test(char);
    switch (this.state) {
      case "text":
        if (char === "<") this.state = "lt";
        break;
      case "lt":
        if (/[A-Za-z]/u.test(char)) {
          this.state = "tagName";
          this.tag = char.toLowerCase();
        } else if (char === "/") this.state = "closeTag";
        else if (char === "!") {
          this.state = "comment";
          this.commentTail = "";
        } else this.state = char === "<" ? "lt" : "text";
        break;
      case "tagName":
        if (space || char === "/") this.state = "tag";
        else if (char === ">") this.endTag();
        else this.tag += char.toLowerCase();
        break;
      case "closeTag":
        if (char === ">") this.state = "text";
        break;
      case "tag":
        if (char === ">") this.endTag();
        else if (!space && char !== "/") this.startAttribute(char);
        break;
      case "attrName":
        if (char === "=" || space || char === ">") this.finishAttribute();
        if (char === "=") this.state = "afterEq";
        else if (space) this.state = "attrEnd";
        else if (char === ">") this.endTag();
        else this.attr += char.toLowerCase();
        break;
      case "attrEnd":
        if (char === "=") this.state = "afterEq";
        else if (char === ">") this.endTag();
        else if (!space) this.startAttribute(char);
        break;
      case "afterEq":
        this.valueLength = 0;
        if (char === '"') this.state = "dq";
        else if (char === "'") this.state = "sq";
        else if (char === ">") this.endTag();
        else if (!space) {
          this.state = "uq";
          this.valueLength = 1;
        }
        break;
      case "dq":
      case "sq":
        if (char === (this.state === "dq" ? '"' : "'")) this.state = "tag";
        else this.valueLength += 1;
        break;
      case "uq":
        if (space) this.state = "tag";
        else if (char === ">") this.endTag();
        break;
      case "comment":
        this.commentTail = (this.commentTail + char).slice(-3);
        if (this.commentTail === "-->") this.state = "text";
        break;
      case "rawScript":
      case "rawText":
        this.rawTail = (this.rawTail + char.toLowerCase()).slice(-(this.tag.length + 2));
        if (this.rawTail === `</${this.tag}`) this.state = "closeTag";
        break;
    }
  }
}

function fragment(scanner: Scanner, value: unknown): string {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (isSafeHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map((item) => fragment(scanner, item)).join("");
  return esc(value);
}

function attributeValue(scanner: Scanner, value: unknown): string {
  if (isSafeHtml(value) || Array.isArray(value)) throw new TypeError(`html: a fragment cannot be placed in the ${scanner.attr} attribute`);
  const text = value === null || value === undefined ? "" : String(value);
  if (scanner.attr === "style" && !(typeof value === "number" || SAFE_STYLE_VALUE.test(text))) throw new TypeError("html: unsafe value in a style attribute");
  if (URL_ATTRIBUTES.has(scanner.attr) && scanner.valueLength === 0) {
    const probe = text.replace(/[\x00-\x20]/gu, "").toLowerCase();
    if (UNSAFE_URL.test(probe)) return "#";
  }
  scanner.valueLength += text.length;
  return esc(text);
}

export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): SafeHtml {
  const scanner = new Scanner();
  let out = "";
  for (let index = 0; index < strings.length; index += 1) {
    const chunk = strings[index] as string;
    scanner.feed(chunk);
    out += chunk;
    if (index >= values.length) break;
    const value = values[index];
    switch (scanner.state) {
      case "text":
        out += fragment(scanner, value);
        break;
      case "rawText":
        if (isSafeHtml(value) || Array.isArray(value)) throw new TypeError("html: a fragment cannot be placed in a raw text element");
        out += esc(value);
        break;
      case "dq":
      case "sq":
        out += attributeValue(scanner, value);
        break;
      default:
        throw new TypeError(`html: interpolation is not allowed in the ${scanner.state} position; quote attribute values and keep tags static`);
    }
  }
  return new SafeHtml(MINT, out);
}

export const EMPTY_HTML: SafeHtml = new SafeHtml(MINT, "");

export function mount(target: { innerHTML: string }, content: SafeHtml): void {
  target.innerHTML = content.value;
}
