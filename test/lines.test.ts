import assert from "node:assert/strict";
import test from "node:test";
import {
  arrayView,
  EMPTY,
  firstDifference,
  iterateLines,
  leaf,
  lineAt,
  LineIndex,
  sliceLines,
} from "../src/lines.ts";

function generator(seed: number) {
  return (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
}

function difference(a: string[], b: string[]) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? Infinity : Math.min(a.length, b.length);
}

test("indexed persistent snapshots match flat arrays across seeded edits", () => {
  for (const seed of [1, 23, 125, 871]) {
    const random = generator(seed);
    const index = new LineIndex();
    const chunks: string[][] = [];
    for (let step = 0; step < 700; step++) {
      const before = index.value;
      const old = chunks.flat();
      const action = random(5);
      if (action === 0 && chunks.length) {
        const length = random(chunks.length + 1);
        index.truncate(length);
        chunks.length = length;
      } else {
        const position = chunks.length && action < 3 ? random(chunks.length) : chunks.length;
        const lines = Array.from({ length: random(7) }, () => `value ${random(30)}`);
        chunks[position] = lines;
        index.set(position, leaf(lines));
      }
      const expected = chunks.flat();
      assert.deepEqual(sliceLines(index.value), expected, `seed ${seed}, step ${step}`);
      assert.deepEqual([...iterateLines(index.value)], expected);
      assert.deepEqual(sliceLines(before), old, "old snapshots remain unchanged");
      assert.equal(firstDifference(before, index.value), difference(old, expected));
      assert.equal(firstDifference(index.value, before), difference(expected, old));
      assert.equal(firstDifference(index.value, index.value), Infinity);
      assert.equal(index.value.length, expected.length);
      const start = random(expected.length + 1);
      const end = start + random(expected.length - start + 1);
      assert.deepEqual(sliceLines(index.value, start, end), expected.slice(start, end));
      assert.equal(lineAt(index.value, start), expected[start]);
    }
  }
});

test("diff aligns different tree shapes and empty leaves", () => {
  const a = new LineIndex();
  const b = new LineIndex();
  [[], ["a", "b"], [], ["c"], ["d", "e"], []].forEach((lines, i) => a.set(i, leaf(lines)));
  [["a"], [], ["b", "c", "d"], ["e"]].forEach((lines, i) => b.set(i, leaf(lines)));
  assert.equal(firstDifference(a.value, b.value), Infinity);
  assert.equal(firstDifference(EMPTY, b.value), 0);
  b.set(3, leaf(["x"]));
  assert.equal(firstDifference(a.value, b.value), 4);
  assert.equal(lineAt(b.value, -1), undefined);
  assert.equal(lineAt(b.value, b.value.length), undefined);
  assert.equal(lineAt(b.value, 0.5), undefined);
});

test("leaf takes a snapshot; image metadata composes through index updates", () => {
  const source = ["initial"];
  const snapshot = leaf(source);
  source[0] = "changed";
  source.push("new");
  assert.deepEqual(sliceLines(snapshot), ["initial"]);
  const index = new LineIndex();
  index.set(0, snapshot);
  index.set(1, leaf(["\x1b_Gi=9;data\x1b\\"]));
  assert.equal(index.value.images, true);
  index.truncate(1);
  assert.equal(index.value.images, false);
});

test("lazy array view supports native array reads and slice boundaries", () => {
  const index = new LineIndex();
  const expected = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  for (let i = 0; i < expected.length; i += 7) index.set(i / 7, leaf(expected.slice(i, i + 7)));
  const view = arrayView(index.value);
  assert.equal(Array.isArray(view), true);
  assert.equal(view.length, expected.length);
  assert.deepEqual([...view], expected);
  assert.deepEqual(
    view.map((text, i) => `${i}:${text}`),
    expected.map((text, i) => `${i}:${text}`),
  );
  assert.equal(
    view.reduce((total, text) => total + text.length, 0),
    expected.reduce((total, text) => total + text.length, 0),
  );
  assert.equal(
    view.findIndex((text) => text.endsWith("78")),
    78,
  );
  assert.equal(view.join("|"), expected.join("|"));
  for (const start of [undefined, -Infinity, -400, -3, -0.5, 0, 1.8, 5, 199, 800, Infinity, NaN]) {
    for (const end of [undefined, -Infinity, -3, 0, 10.5, 200, Infinity, NaN]) {
      assert.deepEqual(view.slice(start, end), expected.slice(start, end), `slice(${start}, ${end})`);
    }
  }
  assert.deepEqual(Object.keys(view), Object.keys(expected));
  assert.deepEqual(view, expected);
});

test("array views copy on mutation and leave their retained snapshots intact", () => {
  const tree = leaf(["a", "b", "c", "d"]);
  for (const mutate of [
    (array: string[]) => {
      array[1] = "B";
    },
    (array: string[]) => {
      array.length = 2;
    },
    (array: string[]) => {
      array.length = 7;
      array[6] = "g";
    },
    (array: string[]) => {
      array.splice(1, 2, "x", "y", "z");
    },
    (array: string[]) => {
      array.push("e");
      array.shift();
      array.pop();
    },
    (array: string[]) => {
      delete array[1];
    },
    (array: string[]) => {
      Object.defineProperty(array, "0", { value: "A", enumerable: false });
    },
    (array: string[]) => {
      array.reverse();
    },
    (array: string[]) => {
      Object.freeze(array);
    },
  ]) {
    const view = arrayView(tree);
    const native = ["a", "b", "c", "d"];
    mutate(view);
    mutate(native);
    assert.deepEqual(view, native);
    assert.deepEqual([...view], [...native]);
    assert.deepEqual(view.slice(), native.slice());
    assert.deepEqual(Object.getOwnPropertyDescriptors(view), Object.getOwnPropertyDescriptors(native));
    assert.deepEqual(sliceLines(tree), ["a", "b", "c", "d"]);
  }
});

test("iterators observe mutations even after yielding the snapshot's final row", () => {
  const view = arrayView(leaf(["a"]));
  const iterator = view[Symbol.iterator]();
  assert.equal(iterator.next().value, "a");
  view.push("b");
  assert.equal(iterator.next().value, "b");
  assert.equal(iterator.next().done, true);
});

test("large transcript slices avoid argument-spread limits", () => {
  const index = new LineIndex();
  for (let i = 0; i < 2000; i++) index.set(i, leaf(Array.from({ length: 100 }, (_, j) => `${i}:${j}`)));
  const before = index.value;
  index.set(1999, leaf(["updated"]));
  assert.equal(before.length, 200000);
  assert.equal(firstDifference(before, index.value), 199900);
  assert.deepEqual(sliceLines(before, 199998), ["1999:98", "1999:99"]);
  assert.equal(arrayView(before).slice().length, 200000);
});

test("invalid index sizes fail rather than looping", () => {
  const index = new LineIndex();
  for (const invalid of [-1, 0.5, Infinity, NaN]) {
    assert.throws(() => index.set(invalid, EMPTY), RangeError);
    assert.throws(() => index.truncate(invalid), RangeError);
  }
});
