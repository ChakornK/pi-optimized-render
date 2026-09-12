import { performance } from "node:perf_hooks";
import {
  AssistantMessageComponent,
  createReadToolDefinition,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, ScrollView, TuiAltScreen, TuiMainScreen, VStack } from "@earendil-works/pi-tui";
import { OptimizedRenderer } from "../src/renderer.ts";
import type { Mutable } from "../src/patch.ts";
import { TestTerminal } from "../test/helpers.ts";
import { assistant, footerFixture } from "../test/native-fixtures.ts";

const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const sizes = (option("sizes") ?? "100,1000,5000").split(",").map(Number);
const frames = Number(option("frames") ?? 60);
const requestedMode = option("mode") ?? "regular";
if (
  sizes.some((size) => !Number.isSafeInteger(size) || size < 1) ||
  !Number.isSafeInteger(frames) ||
  frames < 1
)
  throw new Error("Sizes and frames must be positive integers");
if (!["regular", "fullscreen", "both"].includes(requestedMode))
  throw new Error("Mode must be regular, fullscreen, or both");
const modes =
  requestedMode === "both"
    ? (["regular", "fullscreen"] as const)
    : [requestedMode as "regular" | "fullscreen"];
const markdown =
  "## Renderer notes\n\nKeep the **full transcript**, links, and code blocks. An unchanged message should not need new layout work.\n\n```typescript\nconst frame = render(changes);\nawait flush(frame);\n```\n\n- Preserve scrolling\n- Update the active message\n";

function build(size: number, optimized: boolean, mode: "regular" | "fullscreen") {
  const terminal = new TestTerminal();
  terminal.capture = false;
  terminal.columns = 100;
  terminal.rows = 36;
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const document = new Container();
  const chat = new Container();
  document.addChild(chat);
  const messages = [];
  const definition = createReadToolDefinition(".");
  for (let i = 0; i < size; i++) {
    if (i % 4 === 0)
      chat.addChild(
        new UserMessageComponent(
          `Please inspect module ${i} and explain the rendering behavior.`,
          getMarkdownTheme(),
        ),
      );
    else if (i % 4 === 3) {
      const tool = new ToolExecutionComponent(
        "read",
        `tool-${i}`,
        { path: `module-${i}.ts` },
        { showImages: false },
        definition,
        tui,
        ".",
      );
      tool.updateResult({
        content: [
          {
            type: "text",
            text: `export const index = ${i};\nexport function double(n: number) { return n * 2; }\n`.repeat(
              8,
            ),
          },
        ],
        isError: false,
      });
      chat.addChild(tool);
    } else {
      const message = assistant(`Message ${i}\n\n${markdown}`, i);
      messages.push(message);
      chat.addChild(new AssistantMessageComponent(message));
    }
  }
  const streaming = new AssistantMessageComponent(assistant("Working..."));
  chat.addChild(streaming);
  const editor = new Input({ prompt: "> " });
  const footer = footerFixture(messages);
  const dock = new Container();
  dock.addChild(editor);
  dock.addChild(footer.footer);
  tui.addChild(document);
  tui.addChild(dock);
  if (tui instanceof TuiAltScreen)
    tui.setLayoutRoot(
      new VStack([
        { component: new ScrollView(document, { follow: "end", primary: true }), grow: 1, basis: 0 },
        dock,
      ]),
    );
  tui.setFocus(editor);
  const start = performance.now();
  const controller = optimized ? new OptimizedRenderer(tui as unknown as Mutable) : undefined;
  tui.start();
  tui.renderNow();
  const firstFrameMs = performance.now() - start;
  return { terminal, tui, streaming, editor, footer, controller, firstFrameMs };
}

function percentile(values: number[], fraction: number) {
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
}

function measure(size: number, optimized: boolean, mode: "regular" | "fullscreen") {
  const fixture = build(size, optimized, mode);
  const results = [];
  try {
    for (const workload of ["typing", "streaming", "status"] as const) {
      const mutate = (frame: number) => {
        if (workload === "typing") fixture.editor.setValue(`typing ${frame}`);
        if (workload === "streaming")
          fixture.streaming.updateContent(
            assistant(`## Streaming\n\n${"Another incremental sentence. ".repeat(frame + 1)}`),
            true,
          );
        if (workload === "status") fixture.footer.statuses.set("task", `Processing step ${frame}`);
        fixture.footer.footer.invalidate();
      };
      for (let i = 0; i < 8; i++) {
        mutate(i);
        fixture.tui.renderNow();
      }
      const scans = fixture.footer.entryScans;
      const rendered = fixture.controller?.stats.componentRenders ?? 0;
      const samples = [];
      for (let i = 0; i < frames; i++) {
        const start = performance.now();
        mutate(i + 8);
        fixture.tui.renderNow();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results.push({
        mode,
        messages: size,
        workload,
        optimized,
        frames,
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        firstFrameMs: fixture.firstFrameMs,
        lines:
          fixture.controller?.stats.transcriptLines ??
          (fixture.tui as unknown as Mutable).previousLines?.length,
        processedLines: fixture.controller?.stats.lastFrameLines,
        componentRendersPerFrame: fixture.controller
          ? (fixture.controller.stats.componentRenders - rendered) / frames
          : undefined,
        entryScans: fixture.footer.entryScans - scans,
      });
    }
  } finally {
    fixture.controller?.dispose();
    fixture.tui.stop({ preserveScreen: true });
  }
  return results;
}

initTheme("dark");
const results: ReturnType<typeof measure> = [];
for (const mode of modes)
  for (const size of sizes) {
    results.push(...measure(size, false, mode));
    await new Promise<void>((resolve) => setImmediate(resolve));
    results.push(...measure(size, true, mode));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
} else {
  console.log(`Pi 0.85.1 | Node ${process.version} | ${frames} measured frames after warmup`);
  console.log(
    "Real Pi message/tool/Markdown/input/footer components. CPU update + render time; terminal writes go to a counting sink.",
  );
  console.log("First attachment/render and terminal display latency are excluded from steady-state timings.");
  for (const mode of modes) {
    console.log(`\n${mode}`);
    console.table(
      results
        .filter((row) => row.mode === mode && row.optimized)
        .map((fast) => {
          const native = results.find(
            (row) =>
              row.mode === mode &&
              row.messages === fast.messages &&
              row.workload === fast.workload &&
              !row.optimized,
          )!;
          return {
            messages: fast.messages,
            workload: fast.workload,
            "native median ms": native.medianMs.toFixed(3),
            "optimized median ms": fast.medianMs.toFixed(3),
            "optimized p95 ms": fast.p95Ms.toFixed(3),
            speedup: `${(native.medianMs / fast.medianMs).toFixed(1)}x`,
            "processed / total lines": `${fast.processedLines} / ${fast.lines}`,
            "entry scans": fast.entryScans,
          };
        }),
    );
  }
}
