export type Mutable = Record<PropertyKey, any>;

/** Restores patches whose method or getter identity still matches this instance's replacement. */
export class Patches {
  private restorers: (() => void)[] = [];
  private callbacks: { changed?: (index: number) => void }[] = [];
  active = true;

  method(
    object: Mutable,
    key: PropertyKey,
    wrap: (original: (...args: any[]) => any) => (...args: any[]) => any,
  ): void {
    const own = Object.getOwnPropertyDescriptor(object, key);
    const original = object[key];
    if (typeof original !== "function" || (own && (!own.configurable || own.get || own.set))) {
      throw new Error(`Cannot patch ${String(key)}`);
    }
    const replacement = wrap(original);
    Object.defineProperty(object, key, {
      configurable: true,
      writable: true,
      enumerable: own?.enumerable ?? false,
      value: replacement,
    });
    this.restorers.push(() => {
      if (object[key] !== replacement) return;
      if (own) Object.defineProperty(object, key, own);
      else delete object[key];
    });
  }

  field(object: Mutable, key: string, changed: () => void): boolean {
    const own = Object.getOwnPropertyDescriptor(object, key);
    if (!own || !own.configurable || !own.writable || !("value" in own)) return false;
    const cell = { changed: (_index: number) => changed() } as { changed?: (index: number) => void };
    this.callbacks.push(cell);
    let value = own.value;
    const get = () => value;
    const set = (next: unknown) => {
      if (next !== value) cell.changed?.(0);
      value = next;
    };
    Object.defineProperty(object, key, { configurable: true, enumerable: own.enumerable, get, set });
    this.restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(object, key)?.get === get) {
        Object.defineProperty(object, key, { ...own, value });
      }
    });
    return true;
  }

  children(object: Mutable, changed: (index: number) => void): boolean {
    const own = Object.getOwnPropertyDescriptor(object, "children");
    if (!own?.configurable || !own.writable || !Array.isArray(own.value)) return false;
    const cell = { changed } as { changed?: (index: number) => void };
    this.callbacks.push(cell);
    let raw = own.value as unknown[];
    const proxies = new WeakMap<unknown[], unknown[]>();
    const wrap = (array: unknown[]): unknown[] => {
      const proxy = new Proxy(array, {
        set(target, property, value) {
          if (property === "length") cell.changed?.(Math.min(target.length, Number(value)));
          else if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property))
            cell.changed?.(Number(property));
          return Reflect.set(target, property, value);
        },
        deleteProperty(target, property) {
          if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property))
            cell.changed?.(Number(property));
          return Reflect.deleteProperty(target, property);
        },
        defineProperty(target, property, descriptor) {
          cell.changed?.(
            typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : 0,
          );
          return Reflect.defineProperty(target, property, descriptor);
        },
      });
      proxies.set(proxy, array);
      return proxy;
    };
    let value = wrap(raw);
    const get = () => value;
    const set = (next: unknown[]) => {
      if (!Array.isArray(next)) throw new TypeError("Container children must be an array");
      raw = proxies.get(next) ?? next;
      value = wrap(raw);
      cell.changed?.(0);
    };
    Object.defineProperty(object, "children", { configurable: true, enumerable: own.enumerable, get, set });
    this.restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(object, "children")?.get === get) {
        Object.defineProperty(object, "children", { ...own, value: raw });
      }
    });
    return true;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const cell of this.callbacks) cell.changed = undefined;
    for (const restore of this.restorers.reverse()) restore();
    this.restorers = [];
    this.callbacks = [];
  }
}

/** Resolves Pi's live forwarding reference without relying on imported constructor identity. */
export function resolveTui(reference: Mutable): Mutable {
  const key = Symbol("pi-optimized-render.resolve");
  const probe = function (this: Mutable) {
    return this;
  };
  let actual: Mutable | undefined;
  try {
    if (!Reflect.set(reference, key, probe)) throw new Error("Pi renderer is not writable");
    actual = reference[key]();
    if (!actual || typeof actual.doRender !== "function")
      throw new Error("Pi renderer does not expose doRender");
    return actual;
  } finally {
    if (actual) Reflect.deleteProperty(actual, key);
    Reflect.deleteProperty(reference, key);
  }
}
