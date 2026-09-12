# Renderer architecture

## Retained components

Cache audited native render functions by component identity and width. Setters, invalidation, and mounted child-array edits mark affected ancestors dirty. Unknown descendants stay live, including those inside native wrappers. Subtree removal releases observers and line indexes.

Persistent indexes share unchanged branches across frames. Immutable snapshots isolate retained lines from Pi's cursor extraction and ANSI resets.

## Regular mode

Tail projection requires:

- Matching dimensions and synchronized raw/native frames.
- A positive `previousViewportTop` equal to `previousLines.length - terminal.rows`.
- An unchanged prefix above the viewport.
- No shrink, images, overlays, external restoration, or debug logging requiring a full frame.

The optimizer rebases eligible frames onto the visible tail. Pi handles normalization, diffing, writes, scrolling, and cursor placement. The optimizer restores full coordinates and commits the suffix without copying the prefix.

Other frames use native rendering. Pi's scrollback limits apply. Native errors propagate without retrying terminal writes.

## Fullscreen mode

Pi retains layout, selection, search, overlays, and images. Indexed views expose visible rows without flattening history; mutations materialize a copy and leave the snapshot intact.

## Footer

Cache history-derived rows against session, branch, message, model, and presentation dependencies. Format status changes through an empty-history shadow, leaving the real session, usage, and model context unchanged.

## Attachment and cleanup

Resolve Pi's forwarding reference before installing instance hooks. Follow renderer switches and yield to replacement renderers. Disable, reload, and shutdown restore hooks. Retain one current-width snapshot per component. Reject unsupported structures and restore native rendering.

## Custom cache controls

Unknown components stay live. Stable functions or equal output do not prove independence from hidden state. The optimizer does not inspect other plugins' packages, settings, or commands.

Opt in if `invalidate()` or observed setters cover input changes except width, including startup and external settings:

```ts
import { truncateToWidth } from "@earendil-works/pi-tui";

class StaticCard {
  [Symbol.for("pi-optimized-render.cacheable")] = true;
  private text = "Ready";

  setText(text: string) {
    this.text = text;
    this.invalidate();
  }

  invalidate() {}

  render(width: number) {
    return [truncateToWidth(this.text, width, "")];
  }
}
```

Set flags during construction. `[Symbol.for("pi-optimized-render.dynamic")] = true` overrides caching. Use ANSI-aware width utilities for styled or non-ASCII text.

Old array aliases, redefined properties, and in-place input edits require `invalidate()`. `/render-opt clear` resets the cache.
