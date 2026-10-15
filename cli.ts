#!/usr/bin/env node
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBrevoTwin, type Seed, type Snapshot } from "./twins/brevo/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "4010" },
    seed: { type: "string" },
    state: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: npm start -- brevo [--port 4010] [--seed seed.json] [--state .state/brevo.json]\nAPI key: twin-key. Bind address: 127.0.0.1. API prefix: /v3.",
  );
  process.exit(0);
}
if (positionals.length !== 1 || positionals[0] !== "brevo")
  throw new Error("Expected twin name: brevo. Use --help for usage.");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const statePath = values.state ? resolve(values.state) : undefined;
if (statePath && values.seed && statePath === resolve(values.seed))
  throw new Error("Seed and state paths must differ");
const twin = createBrevoTwin({
  seed: values.seed ? (JSON.parse(readFileSync(values.seed, "utf8")) as Seed) : undefined,
  snapshot:
    statePath && existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf8")) as Snapshot)
      : undefined,
  onChange: statePath
    ? (state) => {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
        renameSync(`${statePath}.tmp`, statePath);
      }
    : undefined,
});
const server = twin.createServer();
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  console.log(`Brevo twin: http://127.0.0.1:${address.port}/v3\nAPI key: twin-key`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
