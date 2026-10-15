import { createTwinServer } from "../../src/server.ts";
import { TwinBase, TwinError, type Fields, type Snapshot } from "./base.ts";
import { Unsupported } from "./formula.ts";
export {
  TwinBase,
  TwinError,
  type BaseSchema,
  type Fields,
  type Snapshot,
  type ApiRecord,
} from "./base.ts";
export { Unsupported, evaluate, ListValue, stringOf, truthy, type Value } from "./formula.ts";

const LIST_PARAMS = new Set(["pageSize", "maxRecords", "offset", "filterByFormula", "fields[]"]);
const BODY_KEYS = new Set(["fields", "records", "typecast"]);

export function createAirtableTwin(options: {
  base: TwinBase;
  onChange?: (snapshot: Snapshot) => void;
}) {
  const base = options.base;
  function list(table: string, params: URLSearchParams): unknown {
    for (const key of params.keys()) {
      if (!LIST_PARAMS.has(key)) {
        throw new Unsupported(
          `The twin does not support the list parameter ${key}. Implement it in list() in server.ts.`,
        );
      }
    }
    const formula = params.get("filterByFormula");
    const records = base.list(table, {
      ...(formula ? { formula } : {}),
      ...(params.has("fields[]") ? { fields: params.getAll("fields[]") } : {}),
    });
    const pageSize = Number(params.get("pageSize") ?? 100);
    const maxRecords = Number(params.get("maxRecords") ?? Number.MAX_SAFE_INTEGER);
    const token = params.get("offset");
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1
    ) {
      throw new TwinError(422, "Invalid pagination.");
    }
    if (token !== null && !/^twin:\d+$/.test(token)) throw new TwinError(422, "Invalid offset.");
    const offset = token === null ? 0 : Number(token.slice(5));
    if (!Number.isSafeInteger(offset)) throw new TwinError(422, "Invalid offset.");
    const limited = records.slice(0, maxRecords);
    const next = offset + pageSize;
    return {
      records: limited.slice(offset, next),
      ...(next < limited.length ? { offset: `twin:${next}` } : {}),
    };
  }

  interface WriteBody {
    fields?: Fields;
    records: { id: string; fields: Fields }[];
    typecast?: boolean;
  }

  function writeBody(raw: string): WriteBody {
    const body = JSON.parse(raw) as WriteBody;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new TwinError(422, "Expected a request object.");
    for (const key of Object.keys(body)) {
      if (!BODY_KEYS.has(key)) {
        throw new Unsupported(
          `The twin does not support the body key ${key}. Add it to writeBody() in server.ts.`,
        );
      }
    }
    if (body.typecast !== undefined && typeof body.typecast !== "boolean")
      throw new TwinError(422, "Invalid typecast.");
    const validFields = (value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    if (body.fields !== undefined && !validFields(body.fields))
      throw new TwinError(422, "Invalid fields.");
    if (
      body.records !== undefined &&
      (!Array.isArray(body.records) ||
        body.records.length < 1 ||
        body.records.length > 10 ||
        body.records.some((record) => !record || !validFields(record.fields)))
    ) {
      throw new TwinError(422, "Invalid records.");
    }
    if ((body.fields === undefined) === (body.records === undefined))
      throw new TwinError(422, "Provide fields or records.");
    return body;
  }

  function create(table: string, body: WriteBody, typecast: boolean): unknown {
    if (body.fields) return base.create(table, body.fields, typecast);
    return {
      records: body.records.map((record) => base.create(table, record.fields, typecast)),
    };
  }

  function update(
    table: string,
    id: string | undefined,
    body: WriteBody,
    typecast: boolean,
  ): unknown {
    if (id && body.fields) return base.update(table, id, body.fields, typecast);
    return {
      records: body.records.map((record) => base.update(table, record.id, record.fields, typecast)),
    };
  }

  function route(
    method: string,
    table: string,
    id: string | undefined,
    params: URLSearchParams,
    raw: string,
  ): unknown {
    if (method === "GET") return id ? base.get(table, id) : list(table, params);
    if (method === "DELETE" && id) return base.destroy(table, id);
    const body = method === "POST" || method === "PATCH" ? writeBody(raw) : null;
    const typecast = body?.typecast === true;
    if (body && method === "POST" && !id) return create(table, body, typecast);
    if (body && method === "PATCH") return update(table, id, body, typecast);
    throw new Unsupported(
      `The twin does not support ${method} on ${table}. Add the route to route() in server.ts.`,
    );
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === "/") return Response.json({ twin: base.baseId });
    try {
      const [, version, baseId, table, id, ...rest] = url.pathname
        .split("/")
        .map(decodeURIComponent);
      if (version !== "v0" || baseId !== base.baseId || !table || rest.length) {
        throw new TwinError(
          404,
          `No route matches ${method} ${url.pathname}. The twin serves /v0/${base.baseId}/<table>[/<id>].`,
        );
      }
      const result = route(method, table, id, url.searchParams, await request.text());
      if (method !== "GET") options.onChange?.(base.snapshot());
      return Response.json(result);
    } catch (error) {
      if (error instanceof TwinError)
        return Response.json({ error: { message: error.message } }, { status: error.status });
      if (
        !(error instanceof Unsupported || error instanceof SyntaxError || error instanceof URIError)
      )
        throw error;
      return Response.json(
        { error: { type: "TWIN_UNSUPPORTED", message: error.message } },
        { status: 501 },
      );
    }
  }
  return { fetch, createServer: () => createTwinServer(fetch) };
}
