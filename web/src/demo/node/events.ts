/**
 * Node's `EventEmitter` as far as the daemon's services use it (the scheduler, the monitor, the SMS
 * service), for the live demo's bundle only (scripts/build-web.ts puts it in place of `node:events`).
 * As in Node, listeners run in the order they were added, synchronously, and an `error` event with no
 * listener throws.
 */

type Listener = (...args: never[]) => unknown;

export class EventEmitter {
  readonly #listeners = new Map<string | symbol, Array<{ fn: Listener; once: boolean }>>();

  on(event: string | symbol, listener: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), { fn: listener, once: false }]);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), { fn: listener, once: true }]);
    return this;
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event);
    if (!list) return this;
    // As Node: the most recently added registration of that listener goes
    const at = list.map((entry) => entry.fn).lastIndexOf(listener);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.#listeners.delete(event);
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) {
      if (event === "error") throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error event: ${String(args[0])}`);
      return false;
    }
    for (const listener of this.rawListeners(event)) Reflect.apply(listener, this, args);
    return true;
  }

  /** The listeners as registered: a `once` one is a wrapper that takes itself off before it calls the listener, as Node's. */
  rawListeners(event: string | symbol): Listener[] {
    return (this.#listeners.get(event) ?? []).map((entry) => {
      if (!entry.once) return entry.fn;
      const wrapper = (...args: unknown[]): unknown => {
        this.#drop(event, entry);
        return Reflect.apply(entry.fn, this, args);
      };
      return Object.assign(wrapper, { listener: entry.fn });
    });
  }

  #drop(event: string | symbol, entry: { fn: Listener; once: boolean }): void {
    const list = this.#listeners.get(event);
    if (!list) return;
    const at = list.indexOf(entry);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.#listeners.delete(event);
  }

  listenerCount(event: string | symbol): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  listeners(event: string | symbol): Listener[] {
    return (this.#listeners.get(event) ?? []).map((entry) => entry.fn);
  }

  setMaxListeners(_count: number): this {
    return this;
  }
}

export default { EventEmitter };
