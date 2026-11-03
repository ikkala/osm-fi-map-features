// Text given whole or as a stream: a string, UTF-8 bytes, or what yields them (a Node.js Readable, a web
// ReadableStream), so that a caller hands in a file, a request's body or a string alike.

export type TextSource = string | Uint8Array | AsyncIterable<string | Uint8Array>;

/** The whole text of the source, its bytes read as UTF-8 */
export async function readText(source: TextSource): Promise<string> {
  if (typeof source === "string") {
    return source;
  }
  const decoder = new TextDecoder();
  if (source instanceof Uint8Array) {
    return decoder.decode(source);
  }
  let text = "";
  for await (const chunk of source) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
