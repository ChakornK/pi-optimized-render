import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createReadToolDefinition,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { OptimizedRenderer } from "../src/renderer.ts";
import type { Mutable } from "../src/patch.ts";
import { assistant, footerFixture } from "./native-fixtures.ts";
import { Counted, scene, TestTerminal } from "./helpers.ts";

initTheme("dark");

test("native footer avoids history scans for tokens, typing, and changing extension statuses", () => {
  const a = scene(false);
  const b = scene(true);
  const fixtures = [a, b].map((s) => {
    const fixture = footerFixture(Array.from({ length: 150 }, (_, i) => assistant(`message ${i}`, i)));
    s.dock.addChild(fixture.footer);
    return fixture;
  });
  const compare = (label: string) => assert.equal(b.frame(), a.frame(), label);
  try {
    compare("initial footer");
    const entryScans = fixtures[1]!.entryScans;
    const contextScans = fixtures[1]!.contextScans;
    for (let i = 0; i < 10; i++) {
      for (const [index, s] of [a, b].entries()) {
        const fixture = fixtures[index]!;
        fixture.footer.invalidate();
        fixture.statuses.set("activity", `frame ${i}`);
        s.editor.value = `typed ${i}`;
      }
      compare(`footer ${i}`);
    }
    assert.equal(fixtures[1]!.entryScans, entryScans, "statuses do not rescan entries");
    assert.equal(fixtures[1]!.contextScans, contextScans, "tokens do not rescan the branch");
    assert.ok(fixtures[0]!.entryScans > entryScans);
    for (const fixture of fixtures) fixture.append(assistant("new finalized response", 900));
    compare("new usage");
    assert.ok(fixtures[1]!.entryScans > entryScans);
    for (const fixture of fixtures) {
      fixture.manager.appendSessionInfo("renamed");
      fixture.setBranch("feature");
    }
    compare("metadata");
    for (const fixture of fixtures) fixture.state.thinkingLevel = "high";
    compare("thinking level");
    for (const fixture of fixtures) fixture.statuses.clear();
    compare("clear statuses");
    for (const s of [a, b]) s.tui.invalidate();
    compare("theme invalidation");
    assert.equal((fixtures[1]!.footer as unknown as Mutable).session, fixtures[1]!.session);
    assert.deepEqual(fixtures[1]!.state.messages, fixtures[0]!.state.messages);
  } finally {
    a.close();
    b.close();
  }
});

test("native user, assistant, and tool rows invalidate through their public mutators", () => {
  const a = scene(false);
  const b = scene(true);
  const rows = [a, b].map((s) => {
    const user = new UserMessageComponent("user **message**", getMarkdownTheme());
    const response = new AssistantMessageComponent(assistant("assistant **message**"));
    const tool = new ToolExecutionComponent(
      "read",
      "t1",
      { path: "file.ts" },
      { showImages: false },
      createReadToolDefinition("."),
      s.tui,
      ".",
    );
    tool.updateResult({
      content: [{ type: "text", text: "export const x = 1;\n".repeat(20) }],
      isError: false,
    });
    s.chat.addChild(user);
    s.chat.addChild(response);
    s.chat.addChild(tool);
    return { user, response, tool };
  });
  const compare = (label: string) => assert.equal(b.frame(), a.frame(), label);
  try {
    compare("initial native rows");
    const renders = b.controller!.stats.componentRenders;
    compare("native idle");
    assert.equal(b.controller!.stats.componentRenders - renders, 2);
    for (const row of rows) row.response.updateContent(assistant("stream **updated**"), true);
    compare("assistant stream");
    for (const row of rows) {
      row.user.setOutputPad(3);
      row.response.setHideThinkingBlock(true);
      row.tool.setExpanded(true);
    }
    compare("presentation settings");
    for (const row of rows) row.tool.updateArgs({ path: "changed.ts" });
    compare("tool args");
    for (const row of rows)
      row.tool.updateResult({ content: [{ type: "text", text: "new output" }], isError: true });
    compare("tool output");
    for (const s of [a, b]) s.tui.invalidate();
    compare("native subtree rebuild");
  } finally {
    a.close();
    b.close();
  }
});

test("settled native shell previews cache their anonymous component without freezing custom tools", () => {
  const a = scene(false);
  const b = scene(true);
  for (const s of [a, b]) {
    const tool = new ToolExecutionComponent(
      "bash",
      "shell",
      { command: "echo ok" },
      { showImages: false },
      createBashToolDefinition("."),
      s.tui,
      ".",
    );
    tool.updateResult({ content: [{ type: "text", text: "output\n".repeat(12) }], isError: false });
    s.chat.addChild(tool);
  }
  try {
    assert.equal(b.frame(), a.frame());
    const renders = b.controller!.stats.componentRenders;
    assert.equal(b.frame(), a.frame());
    assert.equal(b.controller!.stats.componentRenders - renders, 2);
  } finally {
    a.close();
    b.close();
  }
});

test("class names cannot opt custom renderers into native caching", () => {
  const Impostor = class Text {
    value = "first";
    render() {
      return [this.value];
    }
    invalidate() {}
  };
  const s = scene(true);
  const impostor = new Impostor();
  s.chat.addChild(impostor);
  try {
    s.frame();
    impostor.value = "second";
    assert.match(s.frame(), /second/);
  } finally {
    s.close();
  }
});

test("historical shrink keeps projection off until the native viewport is aligned", () => {
  const a = scene(false);
  const b = scene(true);
  try {
    for (const s of [a, b]) s.streaming.setLines(Array.from({ length: 12 }, (_, i) => `line ${i}`));
    assert.equal(b.frame(), a.frame());
    for (const s of [a, b]) s.streaming.setLines(["short"]);
    assert.equal(b.frame(), a.frame());
    for (const s of [a, b]) s.editor.value = "after shrink";
    assert.equal(b.frame(), a.frame());
    assert.equal(b.controller!.stats.fallbackReason, "short transcript or displaced viewport");
    assert.deepEqual(
      (b.tui as TuiMainScreen).captureRenderState(),
      (a.tui as TuiMainScreen).captureRenderState(),
    );
  } finally {
    a.close();
    b.close();
  }
});

test("unsupported or locked renderer state leaves no partial patches", () => {
  const terminal = new TestTerminal();
  const tui = new TuiMainScreen(terminal);
  const children = tui.children;
  const invalidate = tui.invalidate;
  const render = tui.render;
  Object.defineProperty(tui, "render", { configurable: false, writable: false, value: render });
  assert.throws(() => new OptimizedRenderer(tui as unknown as Mutable), /Cannot patch render/);
  assert.equal(tui.children, children);
  assert.equal(tui.invalidate, invalidate);
  assert.equal(tui.render, render);
});

test("cached child changes through an aliased array can be recovered by explicit invalidation", () => {
  const s = scene(true);
  const row = new Counted(["before"]);
  const children = s.chat.children;
  try {
    s.frame();
    children.push(row);
    s.tui.invalidate();
    assert.match(s.frame(), /before/);
    row.setLines(["after"]);
    assert.match(s.frame(), /after/);
  } finally {
    s.close();
  }
});
