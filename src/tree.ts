import { arrayView, EMPTY, leaf, LineIndex, sliceLines, type Lines } from "./lines.ts";
import { Patches, type Mutable } from "./patch.ts";
import { footerKey, FooterMemo } from "./footer.ts";
import {
  Box,
  Container,
  Image,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  FooterComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

/** Opts in to caching when observed changes or invalidate() cover render dependencies other than width. */
export const CACHEABLE = Symbol.for("pi-optimized-render.cacheable");
/** Set before attachment to require live rendering; takes precedence over CACHEABLE. */
export const DYNAMIC = Symbol.for("pi-optimized-render.dynamic");

export interface RenderStats {
  frames: number;
  fastFrames: number;
  nativeFrames: number;
  componentRenders: number;
  cacheHits: number;
  lastFrameMs: number;
  totalFrameMs: number;
  lastFrameLines: number;
  transcriptLines: number;
  fallbackReason: string;
}

const STATIC_RENDERERS = new Set<unknown>(
  [
    Text,
    Markdown,
    Spacer,
    Image,
    TruncatedText,
    Container,
    MouseRegion,
    Box,
    UserMessageComponent,
    AssistantMessageComponent,
    ToolExecutionComponent,
  ].map((component) => component.prototype.render),
);
const EXACT_CONSTRUCTORS = new Map<unknown, unknown>(
  [
    Markdown,
    Image,
    TruncatedText,
    Box,
    UserMessageComponent,
    AssistantMessageComponent,
    ToolExecutionComponent,
  ].map((component) => [component.prototype.render, component]),
);
const shellRenderers = new WeakMap<object, boolean>();
let shellRendererSource: string | undefined;

function nativeShell(root: Mutable, render: unknown): boolean {
  if (
    render !== ToolExecutionComponent.prototype.render ||
    typeof root.toolDefinition?.renderResult !== "function"
  )
    return false;
  const renderer = root.toolDefinition.renderResult;
  let matches = shellRenderers.get(renderer);
  if (matches === undefined) {
    shellRendererSource ??= Function.prototype.toString.call(createBashToolDefinition(".").renderResult);
    matches = Function.prototype.toString.call(renderer) === shellRendererSource;
    shellRenderers.set(renderer, matches);
  }
  return matches;
}
const MUTATOR =
  /^(?:invalidate(?:Cache)?|set[A-Z].*|update[A-Z].*|append[A-Z].*|addChild|removeChild|clear|rebuild|markExecutionStarted)$/;
const INPUT_FIELDS = [
  "text",
  "paddingX",
  "paddingY",
  "customBgFn",
  "bgFn",
  "lines",
  "child",
  "outputPad",
  "hideComponent",
  "hasToolCalls",
  "isStreaming",
  "hideThinkingBlock",
  "hiddenThinkingLabel",
  "expanded",
  "isPartial",
  "showImages",
  "imageWidthCells",
];

function nameOf(component: Mutable): string {
  return component.constructor?.name?.replace(/^_/, "") ?? "";
}

interface Watch {
  patches: Patches;
  notify?: () => void;
  failed?: boolean;
}

/** Propagates subtree mutations and keeps unaudited renderers live. */
class SubtreeWatch {
  private records = new Map<Mutable, Watch>();
  constructor(
    private root: Mutable,
    private changed: () => void,
    private originalRender: unknown,
  ) {}

  refresh(): boolean {
    const seen = new Set<Mutable>();
    let live = false;
    const shell = nativeShell(this.root, this.originalRender);
    const visit = (component: Mutable, trustedShellPreview = false): void => {
      if (seen.has(component)) return;
      seen.add(component);
      const name = nameOf(component);
      const certified = component[CACHEABLE] === true;
      const render = component === this.root ? this.originalRender : component.render;
      const expectedConstructor = EXACT_CONSTRUCTORS.get(render);
      const unknown =
        !STATIC_RENDERERS.has(render) ||
        (expectedConstructor && component.constructor !== expectedConstructor);
      if (component[DYNAMIC] || (unknown && !certified && !trustedShellPreview)) live = true;
      if (
        render === Box.prototype.render &&
        component.bgFn &&
        component !== this.root.contentBox &&
        this.originalRender !== UserMessageComponent.prototype.render &&
        !("previewArgsKey" in component) &&
        !certified
      )
        live = true;
      if (!this.records.has(component)) {
        const record: Watch = { patches: new Patches(), notify: this.changed };
        this.records.set(component, record);
        const notify = () => record.notify?.();
        try {
          const keys = new Set<string>();
          for (
            let proto: Mutable | null = component;
            proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)
          ) {
            for (const key of Object.getOwnPropertyNames(proto)) if (MUTATOR.test(key)) keys.add(key);
          }
          for (const key of keys) {
            if (typeof component[key] !== "function") continue;
            // The native footer invalidation is a no-op, called on every token. Poll its actual inputs instead.
            if (
              component === this.root &&
              this.originalRender === FooterComponent.prototype.render &&
              key === "invalidate"
            )
              continue;
            record.patches.method(
              component,
              key,
              (original) =>
                function (this: Mutable, ...args: unknown[]) {
                  notify();
                  return original.apply(this, args);
                },
            );
          }
          for (const key of INPUT_FIELDS) {
            if (!(key in component) || record.patches.field(component, key, notify)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(component, key);
            if (!descriptor || descriptor.get || descriptor.set || descriptor.writable) record.failed = true;
          }
          if (Array.isArray(component.children) && !record.patches.children(component, notify))
            record.failed = true;
        } catch {
          record.patches.dispose();
          record.failed = true;
        }
      }
      if (this.records.get(component)?.failed) live = true;
      if (Array.isArray(component.children)) {
        for (const child of component.children) {
          if (child && typeof child.render === "function")
            visit(
              child,
              shell && name === "BashResultRenderComponent" && render === Container.prototype.render,
            );
        }
      }
      if (render === MouseRegion.prototype.render && component.child) visit(component.child);
    };
    // An instance-level render override does not inherit the native class's cache contract.
    if (this.root[DYNAMIC] || (!STATIC_RENDERERS.has(this.originalRender) && this.root[CACHEABLE] !== true))
      live = true;
    visit(this.root);
    for (const [component, record] of this.records) {
      if (seen.has(component)) continue;
      record.notify = undefined;
      record.patches.dispose();
      this.records.delete(component);
    }
    return live;
  }

  dispose(): void {
    for (const record of this.records.values()) {
      record.notify = undefined;
      record.patches.dispose();
    }
    this.records.clear();
  }
}

interface Link {
  parent: RenderNode;
  node: RenderNode;
  index: number;
}

class RenderNode {
  readonly parents = new Set<Link>();
  readonly patches = new Patches();
  readonly original: (width: number) => string[];
  renderWrapper?: (width: number) => string[];
  readonly branch: boolean;
  readonly index = new LineIndex();
  links: Link[] = [];
  dirtyChildren = new Set<Link>();
  structureFrom = 0;
  dirty = true;
  width = -1;
  output: Lines = EMPTY;
  view?: string[];
  watcher?: SubtreeWatch;
  live = false;
  pollKey?: unknown[];
  readonly footer: boolean;
  footerMemo?: FooterMemo;
  disposed = false;
  rendering = false;

  constructor(
    readonly owner: RenderTree,
    readonly component: Mutable,
    root: boolean,
  ) {
    this.original = component.render;
    this.footer =
      this.original === FooterComponent.prototype.render && !Object.hasOwn(component, "invalidate");
    this.branch = root || (this.original === Container.prototype.render && component[DYNAMIC] !== true);
    try {
      if (
        this.branch &&
        !this.patches.children(component, (index) => {
          this.structureFrom = Math.min(this.structureFrom, index);
          this.mark();
        })
      )
        throw new Error("Pi Container.children is not observable");
      if (this.branch) {
        this.patches.method(component, "invalidate", (original) => (...args: unknown[]) => {
          if (root) owner.invalidate();
          else {
            this.structureFrom = 0;
            this.mark();
          }
          return original.apply(component, args);
        });
      } else {
        this.watcher = new SubtreeWatch(component, () => this.mark(), this.original);
        this.live = this.watcher.refresh() && !this.footer;
        if (this.footer) {
          owner.polled.add(this);
          this.pollKey = footerKey(component);
          this.footerMemo = new FooterMemo(component, this.original);
        }
        if (this.live) owner.live.add(this);
      }
      this.patches.method(
        component,
        "render",
        (original) =>
          (this.renderWrapper = (width: number) => {
            if (!owner.active || this.disposed) return original.call(component, width);
            if (this === owner.root && owner.regularOutput) return owner.regularOutput();
            const output = this.read(width);
            // Indexed arrays let viewport consumers read lines without flattening the document.
            if (this.branch) return (this.view ??= arrayView(output));
            return sliceLines(output);
          }),
      );
    } catch (error) {
      this.watcher?.dispose();
      this.patches.dispose();
      owner.live.delete(this);
      owner.polled.delete(this);
      throw error;
    }
  }

  mark(): void {
    if (this.disposed) return;
    if (this.renderWrapper && this.component.render !== this.renderWrapper) this.owner.conflict = true;
    this.dirty = true;
    for (const link of this.parents) {
      if (link.parent.dirtyChildren.has(link)) continue;
      link.parent.dirtyChildren.add(link);
      link.parent.mark();
    }
  }

  reconcile(): void {
    const children = this.component.children as Mutable[];
    const from = Math.min(this.structureFrom, children.length, this.links.length);
    const removed = this.links.splice(from);
    this.index.truncate(from);
    this.structureFrom = Infinity;
    for (let i = from; i < children.length; i++) {
      const child = children[i];
      if (!child || typeof child.render !== "function") throw new Error("Invalid Pi container child");
      const node = this.owner.obtain(child);
      const link = { parent: this, node, index: i };
      node.parents.add(link);
      this.links.push(link);
      this.dirtyChildren.add(link);
    }
    for (const link of removed) {
      this.dirtyChildren.delete(link);
      link.node.parents.delete(link);
      this.owner.release(link.node);
    }
    const mouse = this.component.mouseLayout;
    const layouts = mouse?.width === this.width ? mouse.children : [];
    layouts.length = Math.min(layouts.length, from);
    for (let i = layouts.length; i < this.links.length; i++) {
      const node = this.links[i]!.node;
      layouts.push({ component: node.component, height: node.output.length });
    }
    this.component.mouseLayout = { width: this.width, children: layouts };
  }

  read(width: number): Lines {
    if (this.rendering) throw new Error("Cyclic Pi component tree");
    const resized = width !== this.width;
    if (!this.dirty && !resized) {
      this.owner.stats.cacheHits++;
      return this.output;
    }
    this.rendering = true;
    this.dirty = false;
    try {
      if (this.branch) {
        if (this.structureFrom !== Infinity) this.reconcile();
        const dirty = resized ? this.links : [...this.dirtyChildren];
        this.dirtyChildren.clear();
        for (const link of dirty) {
          const output = link.node.read(width);
          this.index.set(link.index, output);
          this.component.mouseLayout.children[link.index].height = output.length;
        }
        this.component.mouseLayout.width = width;
        this.output = this.index.value;
      } else {
        this.owner.stats.componentRenders++;
        const lines = this.footerMemo
          ? this.footerMemo.render(width, this.owner.generation)
          : this.original.call(this.component, width);
        // Pi mutates its frame arrays while extracting the cursor and resetting ANSI state.
        this.output = leaf(lines);
        this.live = this.watcher!.refresh() && !this.footer;
        if (this.live) this.owner.live.add(this);
        else this.owner.live.delete(this);
      }
      this.view = undefined;
      this.width = width;
      return this.output;
    } catch (error) {
      this.mark();
      throw error;
    } finally {
      this.rendering = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.live.delete(this);
    this.owner.polled.delete(this);
    this.watcher?.dispose();
    this.patches.dispose();
    for (const link of this.links) {
      link.node.parents.delete(link);
      this.owner.release(link.node);
    }
    this.links = [];
    this.dirtyChildren.clear();
    this.index.truncate(0);
    this.output = EMPTY;
    this.view = undefined;
    this.footerMemo = undefined;
    this.pollKey = undefined;
  }
}

/** Retains line snapshots and refreshes dirty, resized, or live components. */
export class RenderTree {
  readonly nodes = new Map<Mutable, RenderNode>();
  readonly live = new Set<RenderNode>();
  readonly polled = new Set<RenderNode>();
  readonly root: RenderNode;
  active = false;
  conflict = false;
  generation = 0;
  regularOutput?: () => string[];

  constructor(
    tui: Mutable,
    readonly stats: RenderStats,
  ) {
    this.root = this.obtain(tui, true);
  }

  obtain(component: Mutable, root = false): RenderNode {
    let node = this.nodes.get(component);
    if (!node) {
      node = new RenderNode(this, component, root);
      this.nodes.set(component, node);
    }
    return node;
  }

  release(node: RenderNode): void {
    if (node.parents.size || node === this.root) return;
    this.nodes.delete(node.component);
    node.dispose();
  }

  begin(): void {
    for (const node of this.live) node.mark();
    for (const node of this.polled) {
      const key = footerKey(node.component);
      if (
        !key ||
        !node.pollKey ||
        key.length !== node.pollKey.length ||
        key.some((value, i) => value !== node.pollKey![i])
      )
        node.mark();
      node.pollKey = key;
    }
    this.active = true;
  }

  read(width: number): Lines {
    return this.root.read(width);
  }

  prepareFullscreen(): void {
    if (this.root.structureFrom !== Infinity) this.root.reconcile();
  }

  get ownsRootRender(): boolean {
    return this.root.component.render === this.root.renderWrapper;
  }

  get lineCount(): number {
    return this.root.links.reduce((total, link) => total + link.node.output.length, 0);
  }

  invalidate(): void {
    this.generation++;
    for (const node of this.nodes.values()) {
      if (node.branch) node.structureFrom = 0;
      node.mark();
    }
  }

  end(): void {
    this.active = false;
    this.regularOutput = undefined;
  }

  dispose(): void {
    this.end();
    this.root.dispose();
    this.nodes.clear();
    this.live.clear();
    this.polled.clear();
  }
}
