import { randomBytes } from "node:crypto";
import { evaluate, ListValue, stringOf, truthy, Unsupported, type Value } from "./formula.ts";

interface FieldSchema {
  id: string;
  name: string;
  type: string;
  options?: {
    choices?: { name: string }[];
    linkedTableId?: string;
    inverseLinkFieldId?: string;
    recordLinkFieldId?: string;
    fieldIdInLinkedTable?: string;
    formula?: string;
    result?: { type: string } | null;
  };
}

interface TableSchema {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: FieldSchema[];
}

export interface BaseSchema {
  tables: TableSchema[];
}

export interface ApiRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export type Fields = Record<string, unknown>;

export type Snapshot = Record<
  string,
  { id: string; createdTime: string; values: Record<string, unknown> }[]
>;

export class TwinError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface StoredRecord {
  id: string;
  createdTime: string;
  values: Map<string, unknown>;
}

const COMPUTED = new Set([
  "formula",
  "multipleLookupValues",
  "rollup",
  "count",
  "lastModifiedTime",
  "lastModifiedBy",
  "createdTime",
  "createdBy",
  "autoNumber",
]);

const TEXT = new Set(["singleLineText", "multilineText", "richText", "email", "url", "phoneNumber"]);

const NUMBER = new Set(["number", "currency", "duration", "percent"]);

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function recordId(): string {
  return `rec${[...randomBytes(14)].map((b) => ID_CHARS[b % ID_CHARS.length]).join("")}`;
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

function invalid(message: string): TwinError {
  return new TwinError(422, message);
}

function dateCell(type: string, value: unknown, where: string): string {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw invalid(`${where} takes a date.`);
  }
  return type === "date" ? date.toISOString().slice(0, 10) : date.toISOString();
}

function selectCell(field: FieldSchema, value: unknown, where: string): string {
  const choices = field.options?.choices?.map((choice) => choice.name);
  if (typeof value !== "string" || !choices?.includes(value)) {
    throw new TwinError(
      422,
      `Insufficient permissions to create new select option ""${String(value)}"" in ${where}`,
    );
  }
  return value;
}

class Table {
  readonly schema: TableSchema;
  readonly records = new Map<string, StoredRecord>();
  private readonly byName = new Map<string, FieldSchema>();
  private readonly byId = new Map<string, FieldSchema>();

  constructor(schema: TableSchema) {
    this.schema = schema;
    for (const field of schema.fields) {
      this.byName.set(field.name, field);
      this.byId.set(field.id, field);
    }
  }

  get fields(): FieldSchema[] {
    return this.schema.fields;
  }

  fieldNamed(name: string): FieldSchema {
    const field = this.byName.get(name) ?? this.byId.get(name);
    if (!field) {
      throw new TwinError(422, `Unknown field name: "${name}"`);
    }
    return field;
  }

  record(id: string): StoredRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new TwinError(404, `${this.schema.name} has no record ${id}.`);
    }
    return record;
  }
}

export class TwinBase {
  readonly baseId: string;
  private readonly tables = new Map<string, Table>();

  private readonly rollups: Record<string, (values: unknown[]) => unknown>;

  constructor(
    schema: BaseSchema,
    baseId: string,
    options: { rollups?: Record<string, (values: unknown[]) => unknown> } = {},
  ) {
    this.rollups = options.rollups ?? {};
    this.baseId = baseId;
    for (const tableSchema of schema.tables) {
      const table = new Table(tableSchema);
      this.tables.set(tableSchema.name, table);
      this.tables.set(tableSchema.id, table);
    }
  }

  snapshot(): Snapshot {
    return Object.fromEntries(
      [...new Set(this.tables.values())].map((table) => [
        table.schema.id,
        [...table.records.values()].map((record) => ({
          id: record.id,
          createdTime: record.createdTime,
          values: Object.fromEntries(record.values),
        })),
      ]),
    );
  }

  restore(snapshot: Snapshot): void {
    for (const [tableId, records] of Object.entries(snapshot)) {
      const table = this.table(tableId);
      table.records.clear();
      for (const record of records) {
        table.records.set(record.id, {
          id: record.id,
          createdTime: record.createdTime,
          values: new Map(Object.entries(record.values)),
        });
      }
    }
  }

  private table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) {
      throw new TwinError(404, `Could not find table ${name} in the twin base.`);
    }
    return table;
  }

  list(tableName: string, query: { formula?: string; fields?: string[] }): ApiRecord[] {
    const table = this.table(tableName);
    const fields = query.fields?.map((name) => table.fieldNamed(name));
    const now = new Date();
    const rows = [...table.records.values()].filter((record) => {
      if (!query.formula) return true;
      try {
        return truthy(
          evaluate(query.formula, {
            recordId: record.id,
            now,
            field: (name) => this.formulaValue(table, record, name),
          }),
        );
      } catch (error) {
        if (error instanceof TwinError) {
          throw new TwinError(422, `Invalid formula: ${error.message}`);
        }
        throw error;
      }
    });
    return rows.map((record) => this.output(table, record, fields));
  }

  get(tableName: string, id: string): ApiRecord {
    const table = this.table(tableName);
    return this.output(table, table.record(id));
  }

  create(tableName: string, fields: Fields, typecast = false): ApiRecord {
    const table = this.table(tableName);
    const record: StoredRecord = {
      id: recordId(),
      createdTime: new Date().toISOString(),
      values: new Map(),
    };
    const values = this.accept(table, fields, typecast);
    table.records.set(record.id, record);
    this.write(table, record, values);
    return this.output(table, record);
  }

  update(tableName: string, id: string, fields: Fields, typecast = false): ApiRecord {
    const table = this.table(tableName);
    const record = table.record(id);
    this.write(table, record, this.accept(table, fields, typecast));
    return this.output(table, record);
  }

  destroy(tableName: string, id: string): { id: string; deleted: true } {
    const table = this.table(tableName);
    const record = table.record(id);
    const cleared = new Map<FieldSchema, unknown>();
    for (const field of table.fields) {
      if (field.type === "multipleRecordLinks") cleared.set(field, null);
    }
    this.write(table, record, cleared);
    table.records.delete(id);
    return { id, deleted: true };
  }

  primaryText(tableName: string, id: string): string {
    const table = this.table(tableName);
    const record = table.record(id);
    return stringOf(this.formulaValue(table, record, table.schema.primaryFieldId));
  }

  private accept(table: Table, fields: Fields, typecast: boolean): Map<FieldSchema, unknown> {
    const values = new Map<FieldSchema, unknown>();
    for (const [name, value] of Object.entries(fields)) {
      const field = table.fieldNamed(name);
      values.set(field, this.cell(table, field, value, typecast));
    }
    return values;
  }

  private cell(table: Table, field: FieldSchema, value: unknown, typecast: boolean): unknown {
    const where = `${table.schema.name}.${field.name}`;
    if (COMPUTED.has(field.type)) {
      throw invalid(`Field "${field.name}" cannot accept a value because the field is computed`);
    }
    if (value === null || value === undefined) return null;
    if (TEXT.has(field.type) || field.type === "checkbox") return value;
    if (NUMBER.has(field.type)) {
      if (typeof value !== "number") throw invalid(`${where} takes a number.`);
      return value;
    }
    switch (field.type) {
      case "date":
      case "dateTime":
        return dateCell(field.type, value, where);
      case "singleSelect":
        return selectCell(field, value, where);
      case "multipleRecordLinks":
        return this.links(field, value, typecast, where);
      default:
        throw new Unsupported(
          `${where} is a ${field.type} field. The twin cannot write that type. Add it to cell() in base.ts.`,
        );
    }
  }

  private links(field: FieldSchema, value: unknown, typecast: boolean, where: string): string[] {
    if (!Array.isArray(value)) throw invalid(`${where} takes an array of record ids.`);
    const target = this.table(field.options!.linkedTableId!);
    return [
      ...new Set(
        value.map((item) => {
          if (typeof item !== "string") {
            throw invalid(`${where} takes an array of record ids.`);
          }
          if (target.records.has(item)) return item;
          if (typecast && !item.startsWith("rec")) {
            const match = [...target.records.values()].find(
              (record) => this.primaryText(target.schema.name, record.id) === item,
            );
            if (match) return match.id;
            throw new Unsupported(
              `Typecast found no ${target.schema.name} row named "${item}", and the twin creates none. Add it to your seed data.`,
            );
          }
          throw new TwinError(422, `Record ID ${item} does not exist in ${target.schema.name}`);
        }),
      ),
    ];
  }

  private write(table: Table, record: StoredRecord, values: Map<FieldSchema, unknown>): void {
    for (const [field, value] of values) {
      if (field.type === "multipleRecordLinks") {
        const before = (record.values.get(field.id) ?? []) as string[];
        const after = (value ?? []) as string[];
        this.relink(field, record.id, before, after);
      }
      if (empty(value)) record.values.delete(field.id);
      else record.values.set(field.id, value);
    }
  }

  private relink(field: FieldSchema, id: string, before: string[], after: string[]): void {
    const inverseId = field.options?.inverseLinkFieldId;
    if (!inverseId) return;
    const target = this.table(field.options!.linkedTableId!);
    for (const otherId of before.filter((other) => !after.includes(other))) {
      const other = target.records.get(otherId);
      if (!other) continue;
      const kept = ((other.values.get(inverseId) ?? []) as string[]).filter(
        (linked) => linked !== id,
      );
      if (kept.length === 0) other.values.delete(inverseId);
      else other.values.set(inverseId, kept);
    }
    for (const otherId of after.filter((other) => !before.includes(other))) {
      const other = target.record(otherId);
      const linked = (other.values.get(inverseId) ?? []) as string[];
      if (!linked.includes(id)) other.values.set(inverseId, [...linked, id]);
    }
  }

  private output(table: Table, record: StoredRecord, fields?: FieldSchema[]): ApiRecord {
    const out: Record<string, unknown> = {};
    for (const field of fields ?? table.fields) {
      if (!fields && COMPUTED.has(field.type)) continue;
      const value = this.apiValue(table, record, field);
      if (!empty(value)) out[field.name] = value;
    }
    return { id: record.id, createdTime: record.createdTime, fields: out };
  }

  private linkedRecords(
    table: Table,
    record: StoredRecord,
    linkFieldId: string,
  ): { table: Table; records: StoredRecord[] } {
    const link = table.fieldNamed(linkFieldId);
    const target = this.table(link.options!.linkedTableId!);
    const ids = (record.values.get(link.id) ?? []) as string[];
    return { table: target, records: ids.map((id) => target.record(id)) };
  }

  private apiValue(table: Table, record: StoredRecord, field: FieldSchema): unknown {
    switch (field.type) {
      case "formula":
        return this.coerce(
          field,
          evaluate(field.options!.formula!, {
            recordId: record.id,
            now: new Date(),
            field: (name) => this.formulaValue(table, record, name),
          }),
        );
      case "multipleLookupValues":
      case "rollup": {
        const { table: target, records } = this.linkedRecords(
          table,
          record,
          field.options!.recordLinkFieldId!,
        );
        const source = target.fieldNamed(field.options!.fieldIdInLinkedTable!);
        const values = records
          .flatMap((linked) => {
            const value = this.apiValue(target, linked, source);
            return Array.isArray(value) ? value : [value];
          })
          .filter((value) => !empty(value) || value === false);
        if (field.type === "multipleLookupValues") return values;
        const rollup = this.rollups[field.name];
        if (!rollup) {
          throw new Unsupported(
            `The twin has no aggregate for the rollup ${table.schema.name}.${field.name}. Provide it in the rollups option.`,
          );
        }
        return this.coerce(field, (rollup(values) ?? null) as Value);
      }
      default:
        if (COMPUTED.has(field.type)) {
          throw new Unsupported(
            `${table.schema.name}.${field.name} is a ${field.type} field. The twin cannot compute that type. Add it to apiValue() in base.ts.`,
          );
        }
        return record.values.get(field.id);
    }
  }

  private coerce(field: FieldSchema, value: Value): unknown {
    const type = field.options?.result?.type;
    if (value === null || value === "") return null;
    switch (type) {
      case "number":
        return typeof value === "boolean" ? Number(value) : Number(stringOf(value));
      case "singleLineText":
        return stringOf(value);
      default:
        throw new Unsupported(
          `${field.name} returns a ${String(type)} formula result. The twin cannot return that type. Add it to coerce() in base.ts.`,
        );
    }
  }

  private formulaValue(table: Table, record: StoredRecord, name: string): Value {
    const field = table.fieldNamed(name);
    if (field.type === "multipleRecordLinks") {
      const target = this.table(field.options!.linkedTableId!);
      const ids = (record.values.get(field.id) ?? []) as string[];
      return new ListValue(ids.map((id) => this.primaryText(target.schema.name, id)));
    }
    const value = this.apiValue(table, record, field);
    if (Array.isArray(value)) return new ListValue(value as Value[]);
    if (value === undefined) return null;
    return value as Value;
  }
}
