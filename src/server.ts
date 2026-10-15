import { createServer } from "node:http";

export function createTwinServer(handle: (request: Request) => Promise<Response>) {
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 1_048_576) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const method = incoming.method ?? "GET";
      const response = await handle(
        new Request(`http://localhost${incoming.url}`, {
          method,
          headers: incoming.headers as Record<string, string>,
          ...(method !== "GET" && method !== "HEAD" && chunks.length
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ code: "internal_error", message: "Twin request failed" }));
    }
  });
}
