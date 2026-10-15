import { createTwinServer } from "../../src/server.ts";

type Attributes = Record<string, string | number | boolean | string[]>;
export interface Contact {
  id: number;
  email: string;
  attributes: Attributes;
  listIds: number[];
  emailBlacklisted: boolean;
  smsBlacklisted: boolean;
  createdAt: string;
  modifiedAt: string;
}
export interface Folder {
  id: number;
  name: string;
}
export interface ContactList extends Folder {
  folderId: number;
}
export interface Seed {
  folders?: Folder[];
  lists?: ContactList[];
  contacts?: Array<Pick<Contact, "email"> & Partial<Contact>>;
}
export interface Snapshot {
  version: 1;
  folders: Folder[];
  lists: ContactList[];
  contacts: Contact[];
  nextContactId: number;
  nextListId: number;
  nextFolderId: number;
}
interface Fault {
  method: string;
  path: string;
  status: number;
  times: number;
  retryAfter: number;
}

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new ApiError(400, "invalid_parameter", message);
}
function unsupported(message: string): never {
  throw new ApiError(501, "twin_unsupported", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) unsupported(`Unsupported field: ${key}`);
  }
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid("Expected a positive integer ID");
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("Expected a nonempty string");
  return value;
}
function email(value: unknown): string {
  const result = text(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) invalid("Invalid email address");
  return result;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value)) invalid("Expected an array of IDs");
  return [...new Set(value.map(id))];
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers });
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError(404, "document_not_found", "Resource does not exist");
  return value;
}

export function createBrevoTwin(
  options: {
    apiKey?: string;
    seed?: Seed;
    snapshot?: Snapshot;
    onChange?: (snapshot: Snapshot) => void;
  } = {},
) {
  const apiKey = options.apiKey ?? "twin-key";
  const contacts = new Map<number, Contact>();
  const lists = new Map<number, ContactList>();
  const folders = new Map<number, Folder>();
  const faults: Fault[] = [];
  const requests: Array<{ method: string; path: string; status: number }> = [];
  let nextContactId = 1;
  let nextListId = 1;
  let nextFolderId = 1;

  function snapshot(): Snapshot {
    return structuredClone({
      version: 1,
      contacts: [...contacts.values()],
      lists: [...lists.values()],
      folders: [...folders.values()],
      nextContactId,
      nextListId,
      nextFolderId,
    });
  }

  function findContact(identifier: string) {
    return /^\d+$/.test(identifier)
      ? contacts.get(Number(identifier))
      : [...contacts.values()].find((contact) => contact.email === identifier.toLowerCase());
  }

  function contactValues(body: Record<string, unknown>, current?: Contact): Contact {
    fields(body, [
      "email",
      "attributes",
      "listIds",
      "unlinkListIds",
      "emailBlacklisted",
      "smsBlacklisted",
      "updateEnabled",
    ]);
    if ("updateEnabled" in body && typeof body.updateEnabled !== "boolean")
      invalid("Invalid updateEnabled");
    const attributes = body.attributes === undefined ? {} : object(body.attributes);
    for (const value of Object.values(attributes)) {
      if (
        !(
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (Array.isArray(value) && value.every((item) => typeof item === "string"))
        )
      ) {
        invalid("Invalid attribute value");
      }
    }
    const address = email(attributes.EMAIL ?? body.email ?? current?.email);
    const duplicate = findContact(address);
    if (duplicate && duplicate.id !== current?.id) {
      throw new ApiError(400, "duplicate_parameter", "Contact already exists");
    }
    const add = body.listIds === undefined ? [] : ids(body.listIds);
    const remove = body.unlinkListIds === undefined ? [] : ids(body.unlinkListIds);
    for (const listId of [...add, ...remove]) required(lists.get(listId));
    for (const key of ["emailBlacklisted", "smsBlacklisted"]) {
      if (key in body && typeof body[key] !== "boolean") invalid(`Invalid ${key}`);
    }
    const merged = { ...current?.attributes, ...attributes } as Attributes;
    delete merged.EMAIL;
    const now = new Date().toISOString();
    return {
      id: current?.id ?? nextContactId,
      email: address,
      attributes: merged,
      listIds: [...new Set([...(current?.listIds ?? []), ...add])].filter(
        (listId) => !remove.includes(listId),
      ),
      emailBlacklisted:
        (body.emailBlacklisted as boolean | undefined) ??
        (current && current.email === address ? current.emailBlacklisted : false),
      smsBlacklisted:
        (body.smsBlacklisted as boolean | undefined) ?? current?.smsBlacklisted ?? false,
      createdAt: current?.createdAt ?? now,
      modifiedAt: now,
    };
  }

  function load(seed: Seed) {
    fields(object(seed), ["folders", "lists", "contacts"]);
    contacts.clear();
    lists.clear();
    folders.clear();
    nextContactId = 1;
    nextListId = 1;
    nextFolderId = 1;
    for (const folder of seed.folders ?? []) {
      fields(object(folder), ["id", "name"]);
      const row = { id: id(folder.id), name: text(folder.name) };
      if (folders.has(row.id)) invalid("Duplicate folder ID");
      folders.set(row.id, row);
      nextFolderId = Math.max(nextFolderId, row.id + 1);
    }
    for (const list of seed.lists ?? []) {
      fields(object(list), ["id", "name", "folderId"]);
      const row = { id: id(list.id), name: text(list.name), folderId: id(list.folderId) };
      required(folders.get(row.folderId));
      if (lists.has(row.id)) invalid("Duplicate list ID");
      lists.set(row.id, row);
      nextListId = Math.max(nextListId, row.id + 1);
    }
    for (const contact of seed.contacts ?? []) {
      fields(object(contact), [
        "id",
        "email",
        "attributes",
        "listIds",
        "emailBlacklisted",
        "smsBlacklisted",
        "createdAt",
        "modifiedAt",
      ]);
      const { id: contactId, createdAt, modifiedAt, ...body } = contact;
      const row = contactValues(body);
      row.id = contactId === undefined ? nextContactId : id(contactId);
      if (contacts.has(row.id)) invalid("Duplicate contact ID");
      for (const stamp of [createdAt, modifiedAt]) {
        if (
          stamp !== undefined &&
          (typeof stamp !== "string" || !Number.isFinite(Date.parse(stamp)))
        )
          invalid("Invalid timestamp");
      }
      row.createdAt = createdAt ?? row.createdAt;
      row.modifiedAt = modifiedAt ?? row.modifiedAt;
      contacts.set(row.id, row);
      nextContactId = Math.max(nextContactId, row.id + 1);
    }
  }

  load(options.seed ?? {});
  const initial = snapshot();
  if (options.snapshot) {
    const state = options.snapshot;
    if (state.version !== 1) invalid("Unsupported snapshot version");
    load({ contacts: state.contacts, lists: state.lists, folders: state.folders });
    for (const [saved, minimum] of [
      [state.nextContactId, nextContactId],
      [state.nextListId, nextListId],
      [state.nextFolderId, nextFolderId],
    ])
      if (id(saved) < minimum!) invalid("Invalid snapshot ID sequence");
    nextContactId = state.nextContactId;
    nextListId = state.nextListId;
    nextFolderId = state.nextFolderId;
  }

  function page<T extends { id: number }>(rows: T[], url: URL, key: string, max: number) {
    fields(Object.fromEntries(url.searchParams), ["limit", "offset", "sort"]);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const sort = url.searchParams.get("sort") ?? "desc";
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > max ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      invalid("Invalid pagination");
    if (sort !== "asc" && sort !== "desc") invalid("Invalid sort");
    rows.sort((a, b) => (sort === "desc" ? b.id - a.id : a.id - b.id));
    return json({ [key]: rows.slice(offset, offset + limit), count: rows.length });
  }

  function listInfo(list: ContactList) {
    const members = [...contacts.values()].filter((contact) => contact.listIds.includes(list.id));
    return {
      ...list,
      totalSubscribers: members.length,
      totalBlacklisted: members.filter((contact) => contact.emailBlacklisted).length,
      uniqueSubscribers: members.filter((contact) => !contact.emailBlacklisted).length,
    };
  }

  async function body(request: Request) {
    try {
      return object(await request.json());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return invalid("Invalid JSON body");
    }
  }

  async function route(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("api-key") !== apiKey)
      throw new ApiError(401, "unauthorized", "Invalid API key");
    const path = url.pathname;
    const method = request.method;
    if (path.startsWith("/_twin/")) {
      if (method === "GET" && path === "/_twin/state") return json(snapshot());
      if (method === "GET" && path === "/_twin/requests") return json(requests);
      if (method === "POST" && path === "/_twin/reset") {
        load({ contacts: initial.contacts, lists: initial.lists, folders: initial.folders });
        faults.length = 0;
        requests.length = 0;
        options.onChange?.(snapshot());
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "/_twin/faults") {
        const value = await body(request);
        fields(value, ["method", "path", "status", "times", "retryAfter"]);
        const status = Number(value.status);
        const times = value.times === undefined ? 1 : id(value.times);
        const retryAfter = value.retryAfter ?? 1;
        if (![429, 500, 502, 503, 504].includes(status)) invalid("Unsupported fault status");
        if (!Number.isSafeInteger(retryAfter) || Number(retryAfter) < 0)
          invalid("Invalid retryAfter");
        const faultPath = text(value.path);
        const faultMethod = text(value.method);
        if (
          !faultPath.startsWith("/v3/") ||
          !["GET", "POST", "PUT", "DELETE"].includes(faultMethod)
        )
          invalid("Invalid fault target");
        faults.push({
          method: faultMethod,
          path: faultPath,
          status,
          times,
          retryAfter: Number(retryAfter),
        });
        return new Response(null, { status: 204 });
      }
      return unsupported(`Unsupported control route: ${method} ${path}`);
    }
    const fault = faults.find(
      (entry) => entry.times > 0 && entry.path === path && entry.method === method,
    );
    if (fault) {
      fault.times -= 1;
      return json(
        {
          code: fault.status === 429 ? "too_many_requests" : "internal_error",
          message: "Injected twin failure",
        },
        fault.status,
        fault.status === 429 ? { "Retry-After": String(fault.retryAfter) } : {},
      );
    }
    if (path === "/v3/contacts" && method === "GET")
      return page([...contacts.values()], url, "contacts", 1000);
    if (path === "/v3/contacts/lists" && method === "GET")
      return page([...lists.values()].map(listInfo), url, "lists", 50);
    if (path === "/v3/contacts/folders" && method === "GET")
      return page([...folders.values()], url, "folders", 50);
    const folderLists = path.match(/^\/v3\/contacts\/folders\/(\d+)\/lists$/);
    const listContacts = path.match(/^\/v3\/contacts\/lists\/(\d+)\/contacts$/);
    if (method === "GET" && folderLists) {
      const folderId = Number(folderLists[1]);
      required(folders.get(folderId));
      return page(
        [...lists.values()].filter((list) => list.folderId === folderId).map(listInfo),
        url,
        "lists",
        50,
      );
    }
    if (method === "GET" && listContacts) {
      const listId = Number(listContacts[1]);
      required(lists.get(listId));
      return page(
        [...contacts.values()].filter((contact) => contact.listIds.includes(listId)),
        url,
        "contacts",
        500,
      );
    }
    if (url.search) unsupported(`Unsupported query parameters for ${method} ${path}`);
    if (path === "/v3/contacts" && method === "POST") {
      const value = await body(request);
      const existing = findContact(email(value.email));
      if (existing && value.updateEnabled !== true)
        throw new ApiError(400, "duplicate_parameter", "Contact already exists");
      const row = contactValues(value, existing);
      contacts.set(row.id, row);
      if (!existing) nextContactId += 1;
      return existing ? new Response(null, { status: 204 }) : json({ id: row.id }, 201);
    }
    if ((path === "/v3/contacts/folders" || path === "/v3/contacts/lists") && method === "POST") {
      const value = await body(request);
      const isList = path.endsWith("/lists");
      fields(value, isList ? ["name", "folderId"] : ["name"]);
      const name = text(value.name);
      if (isList) {
        const folderId = id(value.folderId);
        required(folders.get(folderId));
        const row = { id: nextListId++, name, folderId };
        lists.set(row.id, row);
        return json({ id: row.id }, 201);
      }
      const row = { id: nextFolderId++, name };
      folders.set(row.id, row);
      return json({ id: row.id }, 201);
    }
    const list = path.match(/^\/v3\/contacts\/lists\/(\d+)$/);
    if (method === "GET" && list) return json(listInfo(required(lists.get(Number(list[1])))));
    const contact = path.match(/^\/v3\/contacts\/([^/]+)$/);
    if (contact && !["lists", "folders", "attributes"].includes(contact[1]!)) {
      if (!["GET", "PUT", "DELETE"].includes(method))
        return unsupported(`Unsupported method: ${method} ${path}`);
      let identifier: string;
      try {
        identifier = decodeURIComponent(contact[1]!);
      } catch {
        return invalid("Invalid identifier encoding");
      }
      const row = required(findContact(identifier));
      if (method === "GET") return json(row);
      if (method === "DELETE") contacts.delete(row.id);
      else {
        const value = await body(request);
        fields(value, [
          "attributes",
          "listIds",
          "unlinkListIds",
          "emailBlacklisted",
          "smsBlacklisted",
        ]);
        contacts.set(row.id, contactValues(value, row));
      }
      return new Response(null, { status: 204 });
    }
    return unsupported(`Unsupported Brevo route: ${method} ${path}`);
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      response = await route(request, url);
      if (response.ok && request.method !== "GET" && url.pathname.startsWith("/v3/"))
        options.onChange?.(snapshot());
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      response = json({ code: error.code, message: error.message }, error.status);
    }
    if (url.pathname.startsWith("/v3/"))
      requests.push({ method: request.method, path: url.pathname, status: response.status });
    return response;
  }

  return { fetch, snapshot, createServer: () => createTwinServer(fetch) };
}
