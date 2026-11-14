import type { Plugin } from "esbuild";
import { REST_ROUTES } from "../src/operations/routes.ts";

/**
 * The console's build serves `src/operations/routes.ts` as the constant it evaluates to: the routes'
 * methods and paths, without the operation registry behind them (whose MCP descriptions and API
 * reference lines the console never shows). test/operations.test.ts checks the constant against the
 * module and that a bundle of the client holds no word of the registry.
 */

export function routesModuleSource(): string {
  return `export const REST_ROUTES = ${JSON.stringify(REST_ROUTES)};\n`;
}

export const OPERATION_ROUTES_PLUGIN: Plugin = {
  name: "operation-routes",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]operations[\\/]routes\.ts$/ }, () => ({ contents: routesModuleSource(), loader: "js" }));
  },
};
