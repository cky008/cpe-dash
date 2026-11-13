import type { ConnectionOptions } from "../../src/drivers/connection.ts";

/**
 * How a test's core reaches its mock router: the mock's own transport and password, at the address
 * the H168-383 answers on. Every fixture that builds a core takes its connection from here, so that
 * all of them say it the same way; what a fixture needs otherwise (another address or user name, a
 * shorter request timeout, a password the router will refuse) goes in `overrides`.
 */
export function mockConnection(router: { password: string; fetchImpl: typeof fetch }, overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return { cpeUrl: "http://192.168.8.1", cpePassword: router.password, fetchImpl: router.fetchImpl, ...overrides };
}
