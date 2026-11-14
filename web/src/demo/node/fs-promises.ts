import { promises } from "./fs.ts";

/** `node:fs/promises` for the live demo's bundle: the same in-memory file system as ./fs.ts. */
export const { mkdir, open, rename, rm } = promises;
export default promises;
