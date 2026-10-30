/**
 * Read a `fetch` response body as UTF-8 text, aborting as soon as it exceeds `maxBytes`
 * (streamed, so an oversized or endless body is never buffered in full).
 */
export async function readBoundedResponseText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes (maximum allowed size)`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response exceeds ${maxBytes} bytes (maximum allowed size)`);
      }
      chunks.push(buf);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
