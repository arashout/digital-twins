import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createBrevoTwin, type Seed } from "./index.ts";

const seed: Seed = {
  folders: [{ id: 17, name: "Community" }],
  lists: [
    { id: 1, name: "League", folderId: 17 },
    { id: 2, name: "Clinics", folderId: 17 },
  ],
  contacts: [{ id: 4, email: "alex@example.com", attributes: { FIRSTNAME: "Alex" }, listIds: [1] }],
};
function client(twin: ReturnType<typeof createBrevoTwin>) {
  return (path: string, method = "GET", body?: unknown) =>
    twin.fetch(
      new Request(`http://twin${path}`, {
        method,
        headers: { "api-key": "twin-key", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

test("upserts preserve IDs, merge attributes and add memberships until explicitly unlinked", async () => {
  const call = client(createBrevoTwin({ seed }));
  const response = await call("/v3/contacts", "POST", {
    email: "ALEX@example.com",
    updateEnabled: true,
    attributes: { EXT_ID: "member-1" },
    listIds: [2],
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  const contact = await (await call("/v3/contacts/alex%40example.com")).json();
  assert.equal(contact.id, 4);
  assert.deepEqual(contact.attributes, { FIRSTNAME: "Alex", EXT_ID: "member-1" });
  assert.deepEqual(contact.listIds, [1, 2]);
  assert.equal(
    (await call("/v3/contacts/4", "PUT", { unlinkListIds: [1], emailBlacklisted: true })).status,
    204,
  );
  const listed = await (await call("/v3/contacts/lists/2/contacts?limit=1&offset=0")).json();
  assert.deepEqual(listed.contacts[0].listIds, [2]);
  assert.equal(listed.contacts[0].emailBlacklisted, true);
  assert.equal((await (await call("/v3/contacts/lists/1/contacts")).json()).count, 0);
});

test("duplicates, invalid writes and unsupported inputs do not mutate state", async () => {
  const twin = createBrevoTwin({ seed });
  const call = client(twin);
  const before = twin.snapshot();
  assert.equal(
    (await (await call("/v3/contacts", "POST", { email: "alex@example.com" })).json()).code,
    "duplicate_parameter",
  );
  assert.equal(
    (await call("/v3/contacts/4", "PUT", { attributes: { FIRSTNAME: "Changed" }, listIds: [999] }))
      .status,
    404,
  );
  assert.equal(
    (await call("/v3/contacts/4", "PUT", { attributes: { FIRSTNAME: null } })).status,
    400,
  );
  assert.equal((await call("/v3/contacts/4", "PUT", { forceMerge: true })).status, 501);
  assert.equal((await call("/v3/contacts?modifiedSince=2026-01-01")).status, 501);
  assert.equal((await call("/v3/smtp/email", "POST", {})).status, 501);
  assert.deepEqual(twin.snapshot(), before);
  assert.equal((await twin.fetch(new Request("http://twin/v3/contacts"))).status, 401);
});

test("creates contacts and lists, paginates folders and contacts, and persists ID sequences across deletions", async () => {
  const twin = createBrevoTwin({ seed });
  const call = client(twin);
  const list = await (
    await call("/v3/contacts/lists", "POST", { name: "Winter", folderId: 17 })
  ).json();
  assert.equal(list.id, 3);
  const created = await call("/v3/contacts", "POST", { email: "sam@example.com", listIds: [3] });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { id: 5 });
  const page = await (await call("/v3/contacts?limit=1&offset=1&sort=asc")).json();
  assert.equal(page.count, 2);
  assert.equal(page.contacts[0].id, 5);
  const lists = await (
    await call("/v3/contacts/folders/17/lists?limit=1&offset=1&sort=asc")
  ).json();
  assert.equal(lists.count, 3);
  assert.equal(lists.lists[0].id, 2);
  assert.equal((await call("/v3/contacts/5", "DELETE")).status, 204);
  const restored = createBrevoTwin({ seed, snapshot: twin.snapshot() });
  assert.deepEqual(
    await (await client(restored)("/v3/contacts", "POST", { email: "new@example.com" })).json(),
    { id: 6 },
  );
  assert.equal((await call("/v3/contacts?limit=1001")).status, 400);
  assert.equal((await call("/v3/contacts/lists/999/contacts")).status, 404);
});

test("email changes clear email blacklisting and cannot collide with another contact", async () => {
  const call = client(createBrevoTwin({ seed }));
  await call("/v3/contacts/4", "PUT", { emailBlacklisted: true, smsBlacklisted: true });
  await call("/v3/contacts/4", "PUT", { attributes: { EMAIL: "new@example.com" } });
  const updated = await (await call("/v3/contacts/new%40example.com")).json();
  assert.equal(updated.emailBlacklisted, false);
  assert.equal(updated.smsBlacklisted, true);
  assert.equal((await call("/v3/contacts/alex%40example.com")).status, 404);
});

test("faults expire, reset restores the seed, instances are isolated, and request logs omit credentials", async () => {
  const twin = createBrevoTwin({ seed });
  const call = client(twin);
  assert.equal(
    (
      await call("/_twin/faults", "POST", {
        method: "GET",
        path: "/v3/contacts/4",
        status: 429,
        times: 1,
        retryAfter: 0,
      })
    ).status,
    204,
  );
  const throttled = await call("/v3/contacts/4");
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "0");
  assert.equal((await call("/v3/contacts/4")).status, 200);
  await call("/v3/contacts/4", "DELETE");
  assert.equal((await client(createBrevoTwin({ seed }))("/v3/contacts/4")).status, 200);
  const log = await (await call("/_twin/requests")).text();
  assert.equal(log.includes("twin-key"), false);
  assert.equal(log.includes("alex@example.com"), false);
  await call("/_twin/reset", "POST");
  assert.equal((await call("/v3/contacts/4")).status, 200);
  assert.equal((await (await call("/_twin/requests")).json()).length, 1);
});

test("serves the same API over an actual HTTP socket", async (t) => {
  const server = createBrevoTwin({ seed }).createServer();
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v3/contacts/4`, {
    headers: { "api-key": "twin-key" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, "alex@example.com");
});
