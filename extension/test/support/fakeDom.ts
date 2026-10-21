// Just enough of the DOM for a webview view to render into in a test:
// elements with classes, attributes, text and children, found by class name
// and printed as HTML. Install it as `document` before rendering, e.g.
//   vi.stubGlobal('document', fakeDocument);

type Child = FakeElement | FakeText;

export class FakeText {
  constructor(public data: string) {}

  get textContent(): string {
    return this.data;
  }
}

export class FakeElement {
  readonly tagName: string;
  childNodes: Child[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly classList = {
    add: (...names: string[]): void => {
      const classes = new Set(this.classNames());
      for (const name of names) classes.add(name);
      this.className = [...classes].join(' ');
    },
    contains: (name: string): boolean => this.classNames().includes(name),
  };

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get title(): string {
    return this.attributes.get('title') ?? '';
  }

  set title(value: string) {
    this.attributes.set('title', value);
  }

  get type(): string {
    return this.attributes.get('type') ?? '';
  }

  set type(value: string) {
    this.attributes.set('type', value);
  }

  get href(): string {
    return this.attributes.get('href') ?? '';
  }

  set href(value: string) {
    this.attributes.set('href', value);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = value === '' ? [] : [new FakeText(value)];
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  append(...nodes: Array<Child | string>): void {
    for (const node of nodes)
      this.childNodes.push(typeof node === 'string' ? new FakeText(node) : node);
  }

  appendChild(node: Child): Child {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes: Array<Child | string>): void {
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Elements below this one with class `name`, in document order. */
  byClass(name: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.classList.contains(name)) found.push(child);
      found.push(...child.byClass(name));
    }
    return found;
  }

  /** Supports the one selector form the views use: `.class`. */
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) throw new Error(`fake DOM: unsupported selector ${selector}`);
    return this.byClass(selector.slice(1))[0] ?? null;
  }

  /** The element as HTML: attributes in the order they were set, text escaped. */
  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attributes = [...this.attributes]
      .map(([name, value]) => ` ${name}="${escapeHtml(value).replace(/"/g, '&quot;')}"`)
      .join('');
    const inner = this.childNodes
      .map((child) => (child instanceof FakeText ? escapeHtml(child.data) : child.outerHTML))
      .join('');
    return `<${tag}${attributes}>${inner}</${tag}>`;
  }

  private classNames(): string[] {
    return this.className.split(/\s+/).filter((name) => name !== '');
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const fakeDocument = {
  createElement: (tag: string): FakeElement => new FakeElement(tag),
  createTextNode: (data: string): FakeText => new FakeText(data),
};
