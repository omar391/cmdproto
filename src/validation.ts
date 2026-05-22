import type { DescField } from "@bufbuild/protobuf";
import type { FieldSpec, MethodSpec } from "./types.js";

const COMMAND_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LONG_FLAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHORT_FLAG_RE = /^[A-Za-z0-9]$/;
const RESERVED_COMMAND_ROOTS = new Set(["cmdproto"]);
const RESERVED_LONG_FLAGS = new Set(["help", "json"]);
const RESERVED_SHORT_FLAGS = new Set(["h"]);

interface CommandBinding {
  key: string;
  tokens: string[];
  method: MethodSpec;
  source: string;
  positionalCount: number;
}

export function splitCommandPath(path: string): string[] {
  return path.trim().split(/\s+/).filter(Boolean);
}

export function normalizeCommandPath(path: string): string {
  return splitCommandPath(path).join(" ");
}

export function validateMethodSpecs(methods: MethodSpec[]): void {
  const bindings: CommandBinding[] = [];
  const seenCommands = new Map<string, CommandBinding>();

  for (const method of methods) {
    const positionalCount = validateMethodFields(method);
    for (const binding of collectCommandBindings(method, positionalCount)) {
      const existing = seenCommands.get(binding.key);
      if (existing) {
        throw new Error(
          `Duplicate command path "${binding.key}" for ${binding.method.name}; already used by ${existing.method.name}`
        );
      }
      seenCommands.set(binding.key, binding);
      bindings.push(binding);
    }
  }

  for (let index = 0; index < bindings.length; index += 1) {
    const current = bindings[index];
    if (!current) {
      continue;
    }
    for (let candidateIndex = index + 1; candidateIndex < bindings.length; candidateIndex += 1) {
      const candidate = bindings[candidateIndex];
      if (!candidate) {
        continue;
      }
      validatePrefixShadowing(current, candidate);
      validatePrefixShadowing(candidate, current);
    }
  }
}

export function renderMethodUsage(method: MethodSpec): string {
  const parts = [normalizeCommandPath(method.command.path)];

  for (const field of getPositionalFields(method)) {
    parts.push(`<${renderPlaceholder(field.name)}>`);
  }

  for (const field of getFlagFields(method)) {
    const flag = field.param.flag;
    if (!flag) {
      continue;
    }
    const names = [];
    if (flag.short) {
      names.push(`-${flag.short}`);
    }
    if (flag.long) {
      names.push(`--${flag.long}`);
    }
    parts.push(`[${names.join(", ")}]`);
  }

  return parts.join(" ");
}

function collectCommandBindings(method: MethodSpec, positionalCount: number): CommandBinding[] {
  const bindings: CommandBinding[] = [];

  for (const [label, rawPath] of [
    ["path", method.command.path],
    ...method.command.alias.map((alias) => ["alias", alias] as const)
  ]) {
    const key = validateCommandPath(method, rawPath, label);
    bindings.push({
      key,
      tokens: splitCommandPath(key),
      method,
      source: `${label} "${key}"`,
      positionalCount
    });
  }

  return bindings;
}

function validateCommandPath(method: MethodSpec, path: string, label: string): string {
  const normalized = normalizeCommandPath(path);
  const tokens = splitCommandPath(normalized);

  if (tokens.length === 0) {
    throw new Error(`${method.name} is missing cmdproto ${label}`);
  }
  if (RESERVED_COMMAND_ROOTS.has(tokens[0] ?? "")) {
    throw new Error(
      `${method.name} uses reserved command root "${tokens[0]}" in ${label} "${normalized}"`
    );
  }
  for (const token of tokens) {
    if (!COMMAND_TOKEN_RE.test(token)) {
      throw new Error(
        `${method.name} has invalid command token "${token}" in ${label} "${normalized}"`
      );
    }
  }

  return normalized;
}

function validateMethodFields(method: MethodSpec): number {
  const seenFlags = new Map<string, string>();
  const seenPositionals = new Map<number, string>();

  for (const field of method.fields) {
    const positional = field.param.positional?.index;
    const flag = field.param.flag;

    if (positional && flag) {
      throw new Error(
        `${method.name}.${field.name} cannot be both positional and flag-bound in cmdproto`
      );
    }

    if (positional) {
      if (!supportsPositional(field.descriptor)) {
        throw new Error(
          `${method.name}.${field.name} must be scalar or enum to be positional in cmdproto`
        );
      }
      if (seenPositionals.has(positional)) {
        throw new Error(
          `${method.name} reuses positional index ${positional} for ${field.name} and ${seenPositionals.get(positional)}`
        );
      }
      seenPositionals.set(positional, field.name);
    }

    if (flag) {
      if (!supportsFlag(field.descriptor)) {
        throw new Error(
          `${method.name}.${field.name} must be scalar, enum, or repeated scalar/enum to be a flag in cmdproto`
        );
      }
      registerFlag(seenFlags, method, field, "long", flag.long);
      registerFlag(seenFlags, method, field, "short", flag.short);
    }
  }

  const indices = [...seenPositionals.keys()].sort((left, right) => left - right);
  for (let expected = 1; expected <= indices.length; expected += 1) {
    if (indices[expected - 1] !== expected) {
      throw new Error(
        `${method.name} must use contiguous positional indexes starting at 1; missing ${expected}`
      );
    }
  }

  return indices.length;
}

function registerFlag(
  seenFlags: Map<string, string>,
  method: MethodSpec,
  field: FieldSpec,
  kind: "long" | "short",
  rawValue: string
): void {
  const value = rawValue.trim();
  if (!value) {
    return;
  }

  if (kind === "long") {
    if (!LONG_FLAG_RE.test(value)) {
      throw new Error(`${method.name}.${field.name} has invalid long flag "${value}"`);
    }
    if (RESERVED_LONG_FLAGS.has(value)) {
      throw new Error(`${method.name}.${field.name} uses reserved long flag "--${value}"`);
    }
  } else {
    if (!SHORT_FLAG_RE.test(value)) {
      throw new Error(`${method.name}.${field.name} has invalid short flag "${value}"`);
    }
    if (RESERVED_SHORT_FLAGS.has(value)) {
      throw new Error(`${method.name}.${field.name} uses reserved short flag "-${value}"`);
    }
  }

  const key = `${kind}:${value}`;
  const existing = seenFlags.get(key);
  if (existing) {
    throw new Error(
      `${method.name} reuses ${kind} flag "${value}" for ${field.name} and ${existing}`
    );
  }
  seenFlags.set(key, field.name);
}

function validatePrefixShadowing(shorter: CommandBinding, longer: CommandBinding): void {
  if (shorter.positionalCount === 0) {
    return;
  }
  if (shorter.tokens.length >= longer.tokens.length) {
    return;
  }
  if (!isPrefix(shorter.tokens, longer.tokens)) {
    return;
  }

  throw new Error(
    `${shorter.method.name} ${shorter.source} is a prefix of ${longer.method.name} ${longer.source}; commands with positional arguments cannot shadow longer command paths`
  );
}

function isPrefix(prefix: string[], tokens: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function supportsPositional(field: DescField): boolean {
  return field.fieldKind === "scalar" || field.fieldKind === "enum";
}

function supportsFlag(field: DescField): boolean {
  if (field.fieldKind === "scalar" || field.fieldKind === "enum") {
    return true;
  }
  return (
    field.fieldKind === "list" &&
    (field.listKind === "scalar" || field.listKind === "enum")
  );
}

function renderPlaceholder(fieldName: string): string {
  return fieldName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function getPositionalFields(method: MethodSpec): FieldSpec[] {
  return method.fields
    .filter((field) => field.param.positional && !field.param.hidden)
    .sort(
      (left, right) =>
        (left.param.positional?.index ?? Number.MAX_SAFE_INTEGER) -
        (right.param.positional?.index ?? Number.MAX_SAFE_INTEGER)
    );
}

function getFlagFields(method: MethodSpec): FieldSpec[] {
  return method.fields
    .filter((field) => field.param.flag && !field.param.hidden)
    .sort((left, right) => left.name.localeCompare(right.name));
}
