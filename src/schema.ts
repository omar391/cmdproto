import { readFileSync } from "node:fs";
import {
  createFileRegistry,
  fromBinary,
  getOption,
  hasOption,
  type DescExtension,
  type DescField,
  type DescMethod
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import type {
  CmdProtoSchema,
  CommandOptions,
  FieldSpec,
  FlagOptions,
  MethodSpec,
  ParamOptions,
  PositionalOptions
} from "./types.js";
import { validateMethodSpecs } from "./validation.js";

const COMMAND_OPTION = "cmdproto.v1.command";
const PARAM_OPTION = "cmdproto.v1.param";

export function loadSchemaFromFile(path: string): CmdProtoSchema {
  return loadSchemaFromBinary(readFileSync(path));
}

export function loadSchemaFromBinary(bytes: Uint8Array): CmdProtoSchema {
  const fileDescriptorSet = fromBinary(FileDescriptorSetSchema, bytes);
  const registry = createFileRegistry(fileDescriptorSet);
  const commandOption = requireExtension(registry.getExtension(COMMAND_OPTION), COMMAND_OPTION);
  const paramOption = requireExtension(registry.getExtension(PARAM_OPTION), PARAM_OPTION);
  const methods = discoverMethods(commandOption, paramOption, registry);
  validateMethodSpecs(methods);

  return {
    registry,
    fileDescriptorSet,
    descriptorBytes: bytes,
    methods,
    methodByName: new Map(methods.map((method) => [method.name, method]))
  };
}

function requireExtension(
  extension: DescExtension | undefined,
  typeName: string
): DescExtension {
  if (!extension) {
    throw new Error(`Descriptor set does not include ${typeName}`);
  }
  return extension;
}

function discoverMethods(
  commandOption: DescExtension,
  paramOption: DescExtension,
  registry: ReturnType<typeof createFileRegistry>
): MethodSpec[] {
  const methods: MethodSpec[] = [];

  for (const descriptor of registry) {
    if (descriptor.kind !== "service") {
      continue;
    }

    for (const method of descriptor.methods) {
      if (!hasOption(method, commandOption)) {
        continue;
      }

      const command = normalizeCommandOptions(
        getOption(method, commandOption) as CommandOptions
      );
      if (!command.path) {
        throw new Error(`${descriptor.typeName}.${method.name} is missing cmdproto command path`);
      }

      methods.push({
        name: `${descriptor.typeName}.${method.name}`,
        serviceName: descriptor.typeName,
        rpcName: method.name,
        input: method.input,
        output: method.output,
        descriptor: method,
        command,
        fields: discoverFields(method, paramOption)
      });
    }
  }

  return methods.sort((left, right) => left.name.localeCompare(right.name));
}

function discoverFields(method: DescMethod, paramOption: DescExtension): FieldSpec[] {
  return method.input.fields.map((field) => ({
    name: field.name,
    jsonName: field.jsonName,
    localName: field.localName,
    descriptor: field,
    param: hasOption(field, paramOption)
      ? normalizeParamOptions(getOption(field, paramOption) as ParamOptions)
      : normalizeParamOptions()
  }));
}

function normalizeCommandOptions(value?: Partial<CommandOptions>): CommandOptions {
  return {
    path: value?.path ?? "",
    summary: value?.summary ?? "",
    alias: [...(value?.alias ?? [])],
    example: [...(value?.example ?? [])],
    hidden: value?.hidden ?? false,
    deprecated: value?.deprecated ?? false
  };
}

function normalizeParamOptions(value?: Partial<ParamOptions>): ParamOptions {
  const positional = normalizePositional(value?.positional);
  const flag = normalizeFlag(value?.flag);

  return {
    ...(positional ? { positional } : {}),
    ...(flag ? { flag } : {}),
    help: value?.help ?? "",
    hidden: value?.hidden ?? false
  };
}

function normalizePositional(
  value?: Partial<PositionalOptions>
): PositionalOptions | undefined {
  if (!value?.index) {
    return undefined;
  }
  return { index: value.index };
}

function normalizeFlag(value?: Partial<FlagOptions>): FlagOptions | undefined {
  const long = value?.long ?? "";
  const short = value?.short ?? "";

  if (!long && !short) {
    return undefined;
  }
  return { long, short };
}

export function getFieldSpec(method: MethodSpec, field: DescField): FieldSpec {
  const spec = method.fields.find((candidate) => candidate.descriptor === field);
  if (!spec) {
    throw new Error(`Field ${field.name} is not part of ${method.name}`);
  }
  return spec;
}
