import { test } from "node:test";
import assert from "node:assert/strict";
import { TwinBase, TwinError, Unsupported, createAirtableTwin, type BaseSchema } from "./index.ts";

const schema: BaseSchema = {
  tables: [
    {
      id: "tblPeople",
      name: "People",
      primaryFieldId: "fldName",
      fields: [
        { id: "fldName", name: "Name", type: "singleLineText" },
        { id: "fldActive", name: "Active", type: "checkbox" },
        {
          id: "fldUpper",
          name: "Upper",
          type: "formula",
          options: { formula: "UPPER({Name})", result: { type: "singleLineText" } },
        },
        {
          id: "fldTeams",
          name: "Teams",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblTeams", inverseLinkFieldId: "fldPeople" },
        },
      ],
    },
    {
      id: "tblTeams",
      name: "Teams",
      primaryFieldId: "fldTeamName",
      fields: [
        { id: "fldTeamName", name: "Name", type: "singleLineText" },
        {
          id: "fldPeople",
          name: "People",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPeople", inverseLinkFieldId: "fldTeams" },
        },
        {
          id: "fldNames",
          name: "Names",
          type: "multipleLookupValues",
          options: { recordLinkFieldId: "fldPeople", fieldIdInLinkedTable: "fldName" },
        },
        {
          id: "fldTotal",
          name: "Total",
          type: "rollup",
          options: {
            recordLinkFieldId: "fldPeople",
            fieldIdInLinkedTable: "fldName",
            result: { type: "number" },
          },
        },
      ],
    },
  ],
};

test("links, lookups, formulas and caller-supplied rollups follow writes and deletions", () => {
  const base = new TwinBase(schema, "appTwin", { rollups: { Total: (values) => values.length } });
  const team = base.create("Teams", { Name: "Test Team" });
  const person = base.create("People", { Name: "Alex", Active: true, Teams: [team.id] });
  assert.deepEqual(
    base.list("People", { formula: 'AND({Active}, LOWER({Name}) = "alex")', fields: ["Upper"] })[0]
      ?.fields,
    { Upper: "ALEX" },
  );
  assert.deepEqual(base.list("Teams", { fields: ["Names", "Total"] })[0]?.fields, {
    Names: ["Alex"],
    Total: 1,
  });
  base.destroy("People", person.id);
  assert.deepEqual(base.list("Teams", { fields: ["Names", "Total", "People"] })[0]?.fields, {
    Total: 0,
  });
});

test("snapshots preserve state and unsupported behavior stays explicit", () => {
  const base = new TwinBase(schema, "appTwin");
  const person = base.create("People", { Name: "Alex" });
  const restored = new TwinBase(schema, "appTwin");
  restored.restore(JSON.parse(JSON.stringify(base.snapshot())));
  assert.deepEqual(restored.get("People", person.id), base.get("People", person.id));
  assert.throws(() => base.create("People", { Upper: "ALEX" }), TwinError);
  assert.throws(() => base.list("People", { formula: "UNKNOWN()" }), Unsupported);
  base.create("Teams", { Name: "Test Team" });
  assert.throws(() => base.list("Teams", { fields: ["Total"] }), Unsupported);
});

test("HTTP handler supports CRUD, filtering, pagination and rejects unsupported fields", async () => {
  const base = new TwinBase(schema, "appTwin");
  const twin = createAirtableTwin({ base });
  const call = (path: string, method = "GET", body?: unknown) =>
    twin.fetch(
      new Request(`http://twin${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  for (const name of ["Alex", "Sam", "Jo"]) {
    assert.equal(
      (await call("/v0/appTwin/People", "POST", { fields: { Name: name } })).status,
      200,
    );
  }
  const first = await (await call("/v0/appTwin/People?pageSize=2&fields[]=Name")).json();
  assert.equal(first.records.length, 2);
  const second = await (
    await call(`/v0/appTwin/People?pageSize=2&offset=${first.offset}&fields[]=Name`)
  ).json();
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].fields.Name, "Jo");
  assert.equal(second.offset, undefined);
  const recordId = first.records[0].id;
  await call(`/v0/appTwin/People/${recordId}`, "PATCH", { fields: { Name: "Updated" } });
  assert.equal(
    (await (await call(`/v0/appTwin/People/${recordId}`)).json()).fields.Name,
    "Updated",
  );
  assert.equal((await call("/v0/anotherBase/People")).status, 404);
  assert.equal((await call("/v0/appTwin/People?sort=Name")).status, 501);
  assert.equal((await call("/v0/appTwin/People", "POST", { records: "invalid" })).status, 422);
  assert.equal((await call(`/v0/appTwin/People/${recordId}`, "DELETE")).status, 200);
  assert.equal((await call(`/v0/appTwin/People/${recordId}`)).status, 404);
});
