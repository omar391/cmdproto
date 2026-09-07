import { readFile } from "node:fs/promises";
import { ensureCmdProtoServer } from "../../../connect/bootstrap.js";

interface RaceCapability {
  readonly baseUrl: string;
  readonly pid: number;
}

const capabilityPath = requiredEnv("CMDPROTO_RACE_CAPABILITY_PATH");
const serverPath = requiredEnv("CMDPROTO_RACE_SERVER_PATH");

const capability = await ensureCmdProtoServer<RaceCapability>({
  readCapability: async () => {
    try {
      return JSON.parse(await readFile(capabilityPath, "utf8")) as RaceCapability;
    } catch {
      return undefined;
    }
  },
  isUsable: (candidate) => (
    typeof candidate.baseUrl === "string"
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid > 0
  ),
  executable: process.execPath,
  args: [serverPath],
  pollMs: 10,
  timeoutMs: 3_000
});

process.stdout.write(JSON.stringify(capability));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
