export class Unsupported extends Error {}

export class ListValue {
  readonly items: Value[];

  constructor(items: Value[]) {
    this.items = items;
  }
}

export type Value = string | number | boolean | Date | ListValue | null;

export interface FormulaScope {
  field(name: string): Value;
  recordId: string;
  now: Date;
}

const TOKEN =
  /\s+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{[^}]*\}|[A-Z_][A-Z_0-9]*|\d+(?:\.\d+)?|>=|<=|!=|[(),=<>&+-]/giy;

function tokenize(formula: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < formula.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(formula);
    if (!match) {
      throw new Unsupported(
        `No token matches the formula at "${formula.slice(at, at + 20)}". Extend TOKEN in formula.ts.`,
      );
    }
    if (match[0].trim() !== "") tokens.push(match[0]);
  }
  return tokens;
}

const DATE_UNITS_MS: Record<string, number> = {
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
};

export function stringOf(value: Value): string {
  if (value instanceof ListValue) return value.items.map(stringOf).join(", ");
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function truthy(value: Value): boolean {
  if (value instanceof ListValue) return value.items.some(truthy);
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "";
  if (typeof value === "boolean") return value;
  return true;
}

function blank(value: Value): boolean {
  return value === null || value === "" || (value instanceof ListValue && value.items.length === 0);
}

function dateOf(value: Value): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(stringOf(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Unsupported(`"${stringOf(value)}" is not a date.`);
  }
  return parsed;
}

function numberOf(value: Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === "") return 0;
  const number = Number(stringOf(value));
  if (Number.isNaN(number)) {
    throw new Unsupported(`"${stringOf(value)}" is not a number.`);
  }
  return number;
}

function flatten(values: Value[]): Value[] {
  return values.flatMap((value) => (value instanceof ListValue ? flatten(value.items) : [value]));
}

function compare(operator: string, left: Value, right: Value): boolean {
  if (blank(left) || blank(right)) {
    const same = blank(left) && blank(right);
    if (operator === "=") return same;
    if (operator === "!=") return !same;
    return false;
  }
  let a: number | string;
  let b: number | string;
  if (left instanceof Date || right instanceof Date) {
    a = dateOf(left).getTime();
    b = dateOf(right).getTime();
  } else if (typeof left === "number" || typeof right === "number") {
    a = numberOf(left);
    b = numberOf(right);
  } else {
    a = stringOf(left);
    b = stringOf(right);
  }
  switch (operator) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    default:
      return a <= b;
  }
}

type FormulaFunction = (args: Value[], scope: FormulaScope) => Value;

const arg = (args: Value[], index: number): Value => args[index] ?? null;
const text = (args: Value[], index: number): string => stringOf(arg(args, index));

function dateCompare(after: boolean): FormulaFunction {
  return (args) => {
    const [left = null, right = null] = args;
    if (blank(left) || blank(right)) return false;
    return after ? dateOf(left) > dateOf(right) : dateOf(left) < dateOf(right);
  };
}

function switchCase(args: Value[]): Value {
  const [subject = null, ...cases] = args;
  for (let i = 0; i + 1 < cases.length; i += 2) {
    if (compare("=", subject, cases[i]!)) return cases[i + 1]!;
  }
  return cases.length % 2 === 1 ? cases[cases.length - 1]! : null;
}

function dateAdd(args: Value[]): Value {
  if (blank(arg(args, 0))) return null;
  const step = DATE_UNITS_MS[text(args, 2).toLowerCase()];
  if (step === undefined)
    throw new Unsupported(
      `DATEADD does not support the unit ${text(args, 2)}. Add it to DATE_UNITS_MS in formula.ts.`,
    );
  return new Date(dateOf(arg(args, 0)).getTime() + numberOf(arg(args, 1)) * step);
}

const FUNCTIONS: Record<string, FormulaFunction> = {
  TRUE: () => true,
  FALSE: () => false,
  BLANK: () => null,
  NOW: (_, scope) => scope.now,
  RECORD_ID: (_, scope) => scope.recordId,
  AND: (args) => args.every(truthy),
  OR: (args) => args.some(truthy),
  IF: (args) => (truthy(arg(args, 0)) ? arg(args, 1) : arg(args, 2)),
  SWITCH: switchCase,
  LOWER: (args) => text(args, 0).toLowerCase(),
  UPPER: (args) => text(args, 0).toUpperCase(),
  RIGHT: (args) => text(args, 0).slice(-numberOf(arg(args, 1))),
  FIND: (args) => text(args, 1).indexOf(text(args, 0)) + 1,
  TRIM: (args) => text(args, 0).trim(),
  SUM: (args) => flatten(args).reduce<number>((sum, value) => sum + numberOf(value), 0),
  ARRAYJOIN: (args) =>
    flatten([arg(args, 0)])
      .map(stringOf)
      .join(args.length > 1 ? text(args, 1) : ", "),
  IS_AFTER: dateCompare(true),
  IS_BEFORE: dateCompare(false),
  DATEADD: dateAdd,
};

function callFunction(name: string, args: Value[], scope: FormulaScope): Value {
  const implementation = FUNCTIONS[name];
  if (!implementation)
    throw new Unsupported(
      `The formula function ${name}() is not implemented. Add it to FUNCTIONS in formula.ts.`,
    );
  return implementation(args, scope);
}

class Parser {
  private at = 0;
  private readonly tokens: string[];
  private readonly scope: FormulaScope;

  constructor(tokens: string[], scope: FormulaScope) {
    this.tokens = tokens;
    this.scope = scope;
  }

  run(): Value {
    const value = this.comparison();
    if (this.at !== this.tokens.length) {
      throw new Unsupported(
        `Cannot parse the rest of the formula: "${this.tokens.slice(this.at).join(" ")}".`,
      );
    }
    return value;
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Unsupported("The formula ends early.");
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) throw new Unsupported(`Expected "${token}" but found "${found}".`);
  }

  private comparison(): Value {
    const left = this.concatenation();
    const operator = this.peek();
    if (!operator || !["=", "!=", ">", "<", ">=", "<="].includes(operator)) {
      return left;
    }
    this.at += 1;
    return compare(operator, left, this.concatenation());
  }

  private concatenation(): Value {
    let value = this.additive();
    while (this.peek() === "&") {
      this.at += 1;
      value = stringOf(value) + stringOf(this.additive());
    }
    return value;
  }

  private additive(): Value {
    let value = this.unary();
    for (let op = this.peek(); op === "+" || op === "-"; op = this.peek()) {
      this.at += 1;
      const right = numberOf(this.unary());
      value = op === "+" ? numberOf(value) + right : numberOf(value) - right;
    }
    return value;
  }

  private unary(): Value {
    if (this.peek() === "-") {
      this.at += 1;
      return -numberOf(this.unary());
    }
    return this.primary();
  }

  private primary(): Value {
    const token = this.next();
    if (token === "(") {
      const value = this.comparison();
      this.expect(")");
      return value;
    }
    if (token.startsWith("{")) return this.scope.field(token.slice(1, -1));
    if (token.startsWith('"') || token.startsWith("'")) {
      return token.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (/^\d/.test(token)) return Number(token);
    if (!/^[A-Z_]/i.test(token)) throw new Unsupported(`Unexpected token "${token}".`);
    return callFunction(token.toUpperCase(), this.args(), this.scope);
  }

  private args(): Value[] {
    this.expect("(");
    const values: Value[] = [];
    if (this.peek() !== ")") {
      values.push(this.comparison());
      while (this.peek() === ",") {
        this.at += 1;
        values.push(this.comparison());
      }
    }
    this.expect(")");
    return values;
  }
}

export function evaluate(formula: string, scope: FormulaScope): Value {
  return new Parser(tokenize(formula), scope).run();
}
