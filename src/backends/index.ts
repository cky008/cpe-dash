import { type RouterBackend, selectRouterBackend } from "../router-backend.ts";
import type { MutexSessionScheduler } from "../scheduler.ts";
import { DriverBackend } from "./driver.ts";
import { HilinkBackend } from "./hilink.ts";

export { DriverBackend } from "./driver.ts";
export { HilinkBackend } from "./hilink.ts";

/** `() => backend of the connection in use`, for a service that reads or writes the router. */
export function routerBackendOf(scheduler: MutexSessionScheduler): () => RouterBackend {
  const backends = { hilink: new HilinkBackend(scheduler), driver: new DriverBackend(scheduler) };
  return () => selectRouterBackend(scheduler, backends);
}
