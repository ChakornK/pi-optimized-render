export type Lines = Leaf | Branch;

interface Leaf {
  kind: "leaf";
  lines: readonly string[];
  length: number;
  images: boolean;
}

interface Branch {
  kind: "branch";
  left: Lines;
  right: Lines;
  length: number;
  images: boolean;
}

export const EMPTY: Lines = { kind: "leaf", lines: [], length: 0, images: false };

export function leaf(lines: readonly string[]): Lines {
  if (lines.length === 0) return EMPTY;
  const snapshot = lines.slice();
  return {
    kind: "leaf",
    lines: snapshot,
    length: snapshot.length,
    images: snapshot.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=")),
  };
}

function join(left: Lines, right: Lines): Lines {
  if (!left.length) return right;
  if (!right.length) return left;
  return {
    kind: "branch",
    left,
    right,
    length: left.length + right.length,
    images: left.images || right.images,
  };
}

interface Slot {
  value: Lines;
  left?: Slot;
  right?: Slot;
}

function slot(left?: Slot, right?: Slot): Slot {
  return { left, right, value: join(left?.value ?? EMPTY, right?.value ?? EMPTY) };
}

/** Indexes child outputs without flattening unchanged transcript segments. */
export class LineIndex {
  private capacity = 1;
  private root: Slot | undefined;

  get value(): Lines {
    return this.root?.value ?? EMPTY;
  }

  set(index: number, value: Lines): void {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new RangeError("Line index must be a non-negative safe integer");
    while (index >= this.capacity) {
      this.root = slot(this.root);
      this.capacity *= 2;
    }
    const update = (node: Slot | undefined, start: number, size: number): Slot => {
      if (size === 1) return { value };
      const half = size / 2;
      return index < start + half
        ? slot(update(node?.left, start, half), node?.right)
        : slot(node?.left, update(node?.right, start + half, half));
    };
    this.root = update(this.root, 0, this.capacity);
  }

  truncate(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new RangeError("Line index length must be a non-negative safe integer");
    const trim = (node: Slot | undefined, start: number, size: number): Slot | undefined => {
      if (!node || start >= length) return undefined;
      if (start + size <= length) return node;
      const half = size / 2;
      return slot(trim(node.left, start, half), trim(node.right, start + half, half));
    };
    this.root = trim(this.root, 0, this.capacity);
  }
}

export function lineAt(node: Lines, index: number): string | undefined {
  if (index < 0 || index >= node.length) return undefined;
  while (node.kind === "branch") {
    if (index < node.left.length) node = node.left;
    else {
      index -= node.left.length;
      node = node.right;
    }
  }
  return node.lines[index];
}

export function sliceLines(node: Lines, start = 0, end = node.length): string[] {
  const result: string[] = [];
  const visit = (part: Lines, offset: number): void => {
    if (offset >= end || offset + part.length <= start) return;
    if (part.kind === "leaf") {
      for (let i = Math.max(0, start - offset); i < Math.min(part.length, end - offset); i++) {
        result.push(part.lines[i]!);
      }
    } else {
      visit(part.left, offset);
      visit(part.right, offset + part.left.length);
    }
  };
  visit(node, 0);
  return result;
}

export function* iterateLines(node: Lines): Generator<string> {
  if (node.kind === "leaf") yield* node.lines;
  else {
    yield* iterateLines(node.left);
    yield* iterateLines(node.right);
  }
}

/**
 * Returns the first differing row index, or the shorter length for a prefix match.
 * Returns Infinity for equal sequences and skips shared subtrees.
 */
export function firstDifference(before: Lines, after: Lines): number {
  const a = [before];
  const b = [after];
  let aOffset = 0;
  let bOffset = 0;
  let row = 0;
  while (a.length && b.length) {
    const x = a[a.length - 1]!;
    const y = b[b.length - 1]!;
    if (x === y && aOffset === bOffset) {
      row += x.length - aOffset;
      a.pop();
      b.pop();
      aOffset = bOffset = 0;
    } else if (x.kind === "branch") {
      a.pop();
      a.push(x.right, x.left);
    } else if (y.kind === "branch") {
      b.pop();
      b.push(y.right, y.left);
    } else {
      const count = Math.min(x.length - aOffset, y.length - bOffset);
      for (let i = 0; i < count; i++) {
        if (x.lines[aOffset + i] !== y.lines[bOffset + i]) return row + i;
      }
      row += count;
      aOffset += count;
      bOffset += count;
      if (aOffset === x.length) {
        a.pop();
        aOffset = 0;
      }
      if (bOffset === y.length) {
        b.pop();
        bOffset = 0;
      }
    }
  }
  return before.length === after.length ? Infinity : row;
}

function arrayIndex(property: PropertyKey): number | undefined {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return undefined;
  const index = Number(property);
  return index < 0xffffffff ? index : undefined;
}

function boundary(value: number | undefined, length: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
  return integer < 0 ? Math.max(0, length + integer) : Math.min(length, integer);
}

/** Exposes an indexed snapshot; materializes for mutation or property enumeration. */
export function arrayView(tree: Lines): string[] {
  const target: string[] = [];
  let materialized = false;
  const hydrate = (): void => {
    if (materialized) return;
    let index = 0;
    for (const line of iterateLines(tree)) target[index++] = line;
    materialized = true;
  };
  const proxy = new Proxy(target, {
    get(array, property, receiver) {
      if (!materialized) {
        if (property === "length") return tree.length;
        const index = arrayIndex(property);
        if (index !== undefined) return lineAt(tree, index);
        if (property === "slice")
          return (start?: number, end?: number) =>
            materialized
              ? target.slice(start, end)
              : sliceLines(tree, boundary(start, tree.length, 0), boundary(end, tree.length, tree.length));
        if (property === Symbol.iterator)
          return function* () {
            let index = 0;
            for (const line of iterateLines(tree)) {
              if (materialized) {
                while (index < target.length) yield target[index++]!;
                return;
              }
              index++;
              yield line;
            }
            if (materialized) while (index < target.length) yield target[index++]!;
          };
      }
      return Reflect.get(array, property, receiver);
    },
    has(array, property) {
      const index = arrayIndex(property);
      return (!materialized && index !== undefined && index < tree.length) || Reflect.has(array, property);
    },
    getOwnPropertyDescriptor(array, property) {
      if (!materialized && property === "length") {
        return { value: tree.length, writable: true, enumerable: false, configurable: false };
      }
      const index = arrayIndex(property);
      if (!materialized && index !== undefined && index < tree.length) {
        return { value: lineAt(tree, index), writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(array, property);
    },
    ownKeys(array) {
      hydrate();
      return Reflect.ownKeys(array);
    },
    set(array, property, value) {
      hydrate();
      return Reflect.set(array, property, value);
    },
    deleteProperty(array, property) {
      hydrate();
      return Reflect.deleteProperty(array, property);
    },
    defineProperty(array, property, descriptor) {
      hydrate();
      return Reflect.defineProperty(array, property, descriptor);
    },
    preventExtensions(array) {
      hydrate();
      return Reflect.preventExtensions(array);
    },
  });
  return proxy;
}
