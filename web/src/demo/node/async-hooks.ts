/**
 * `AsyncLocalStorage` for the live demo's bundle (scripts/build-web.ts puts it in place of
 * `node:async_hooks`). A page has no context that follows a call across `await` (TC39's AsyncContext
 * is not in browsers yet), so a store set by `run` is seen only until `fn` returns: the caller a write
 * is audited under is read when the request starts (src/scheduler.ts `control`, before any `await`),
 * and the session client's re-entry check only guards against a nested call made synchronously.
 */
export class AsyncLocalStorage<T> {
  #active = false;
  #store: T | undefined = undefined;

  getStore(): T | undefined {
    return this.#active ? this.#store : undefined;
  }

  run<R>(store: T, fn: () => R): R {
    const before = { active: this.#active, store: this.#store };
    this.#active = true;
    this.#store = store;
    try {
      return fn();
    } finally {
      this.#active = before.active;
      this.#store = before.store;
    }
  }
}

export default { AsyncLocalStorage };
