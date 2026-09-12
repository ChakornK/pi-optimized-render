import assert from "node:assert/strict";
import test from "node:test";
import { Container, TuiAltScreen, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { resolveTui, type Mutable } from "../src/patch.ts";
import { TestTerminal } from "./helpers.ts";
import { createJiti } from "jiti";

const CONTROLLER = Symbol.for("pi-optimized-render.controller");

async function harness(mode = "tui", disabled = false, factory = extension) {
  const terminal = new TestTerminal();
  let tui: TuiMainScreen | TuiAltScreen = new TuiMainScreen(terminal);
  const widgets = new Container();
  tui.addChild(widgets);
  const reference = new Proxy(
    {},
    {
      get(_target, key) {
        const instance = tui as unknown as Mutable;
        const value = instance[key];
        return typeof value === "function" ? (...args: unknown[]) => value.apply(instance, args) : value;
      },
      set(_target, key, value) {
        return Reflect.set(tui, key, value, tui);
      },
      has(_target, key) {
        return Reflect.has(tui, key);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(tui);
      },
    },
  ) as Mutable;
  const events = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, Mutable>();
  const notices: string[] = [];
  let widget: (Component & { dispose?(): void }) | undefined;
  let widgetCalls = 0;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setWidget(_key: string, factory: (reference: Mutable) => Component) {
        widgetCalls++;
        widget?.dispose?.();
        widgets.clear();
        widget = factory(reference);
        widgets.addChild(widget);
      },
      notify(text: string) {
        notices.push(text);
      },
    },
  } as unknown as ExtensionContext;
  const api = {
    on(event: string, handler: (...args: any[]) => unknown) {
      events.set(event, handler);
    },
    registerCommand(name: string, command: Mutable) {
      commands.set(name, command);
    },
    registerFlag() {},
    getFlag() {
      return disabled;
    },
  } as unknown as ExtensionAPI;
  await factory(api);
  return {
    reference,
    terminal,
    notices,
    ctx,
    get tui() {
      return tui;
    },
    get widgetCalls() {
      return widgetCalls;
    },
    start() {
      return events.get("session_start")!({ reason: "startup" }, ctx);
    },
    shutdown() {
      return events.get("session_shutdown")!({ reason: "quit" }, ctx);
    },
    command(args: string) {
      return commands.get("render-opt")!.handler(args, ctx);
    },
    switchRenderer() {
      const children = [...tui.children];
      tui.stop({ preserveScreen: true });
      tui.clear();
      tui = new TuiAltScreen(terminal);
      for (const child of children) tui.addChild(child);
      tui.start();
      tui.renderNow();
    },
    close() {
      events.get("session_shutdown")!({ reason: "quit" }, ctx);
      widget?.dispose?.();
      tui.stop({ preserveScreen: true });
    },
  };
}

test("resolves Pi's forwarding reference and removes its temporary property", async () => {
  const h = await harness();
  try {
    const keys = Reflect.ownKeys(h.tui);
    assert.equal(resolveTui(h.reference), h.tui);
    assert.deepEqual(Reflect.ownKeys(h.tui), keys);
    assert.equal(resolveTui(h.tui as unknown as Mutable), h.tui);
  } finally {
    h.close();
  }
});

for (const mode of ["rpc", "json", "print"]) {
  test(`${mode}: extension does not touch the TUI`, async () => {
    const h = await harness(mode);
    const native = (h.tui as unknown as Mutable).doRender;
    try {
      h.start();
      assert.equal(h.widgetCalls, 0);
      assert.equal((h.tui as unknown as Mutable).doRender, native);
    } finally {
      h.close();
    }
  });
}

test("on, off, clear, and reload are idempotent and keep the widget invisible", async () => {
  const h = await harness();
  const native = (h.tui as unknown as Mutable).doRender;
  try {
    h.start();
    h.tui.renderNow();
    assert.ok((h.tui as unknown as Mutable)[CONTROLLER]);
    assert.deepEqual(h.tui.render(80), []);
    await h.command("status");
    assert.match(h.notices.at(-1)!, /Render optimization on/);
    await h.command("off");
    assert.equal((h.tui as unknown as Mutable).doRender, native);
    await h.command("on");
    const first = (h.tui as unknown as Mutable)[CONTROLLER];
    await h.command("on");
    assert.equal((h.tui as unknown as Mutable)[CONTROLLER], first);
    await h.command("clear");
    h.tui.renderNow();
    h.start();
    h.tui.renderNow();
    assert.equal(first.disposed, true);
    assert.notEqual((h.tui as unknown as Mutable)[CONTROLLER], first);
    h.shutdown();
    h.shutdown();
    assert.equal((h.tui as unknown as Mutable).doRender, native);
    assert.equal((h.tui as unknown as Mutable)[CONTROLLER], undefined);
  } finally {
    h.close();
  }
});

test("CLI opt-out does not install renderer hooks until explicitly enabled", async () => {
  const h = await harness("tui", true);
  const native = (h.tui as unknown as Mutable).doRender;
  try {
    h.start();
    assert.equal((h.tui as unknown as Mutable).doRender, native);
    await h.command("on");
    assert.notEqual((h.tui as unknown as Mutable).doRender, native);
  } finally {
    h.close();
  }
});

test("unsupported Pi versions do not load private renderer APIs", async () => {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    tryNative: false,
    virtualModules: {
      "@earendil-works/pi-coding-agent": { VERSION: "0.0.0-unsupported" },
      "@earendil-works/pi-tui": {},
    },
  });
  const factory = await jiti.import<typeof extension>(new URL("../src/index.ts", import.meta.url).href, {
    default: true,
  });
  const h = await harness("tui", false, factory);
  const native = (h.tui as unknown as Mutable).doRender;
  try {
    h.start();
    assert.equal((h.tui as unknown as Mutable).doRender, native);
    assert.equal((h.tui as unknown as Mutable)[CONTROLLER], undefined);
    assert.match(h.notices.at(-1)!, /disabled on Pi 0.0.0-unsupported/);
  } finally {
    h.close();
  }
});

test("widget follows a replaced renderer after the native transition frame", async () => {
  const h = await harness();
  try {
    h.start();
    h.tui.renderNow();
    const old = (h.tui as unknown as Mutable)[CONTROLLER];
    h.switchRenderer();
    await Promise.resolve();
    h.tui.renderNow();
    const next = (h.tui as unknown as Mutable)[CONTROLLER];
    assert.equal(old.disposed, true);
    assert.ok(next);
    assert.equal(next.tui, h.tui);
    assert.notEqual(next, old);
  } finally {
    h.close();
  }
});
