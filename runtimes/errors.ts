import type { JsonValue } from "@bufbuild/protobuf";

export class CmdProtoError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "CmdProtoError";
    this.code = code;
    this.details = details;
  }
}
