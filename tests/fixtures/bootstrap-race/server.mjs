import { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";

const capabilityPath = requiredEnv("CMDPROTO_RACE_CAPABILITY_PATH");
const lockPath = requiredEnv("CMDPROTO_RACE_LOCK_PATH");
const attemptsPath = requiredEnv("CMDPROTO_RACE_ATTEMPTS_PATH");

let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
    throw error;
  }
  await appendFile(attemptsPath, "loser\n");
  process.exit(23);
}

try {
  await lock.writeFile(String(process.pid));
  await appendFile(attemptsPath, "winner\n");
  await waitForBothStarters();
  // Publish after the old fixed 500 ms grace to prove the losing caller uses
  // its configured deadline instead of an internal timing guess.
  await delay(700);

  const terminated = new Promise((resolve) => {
    process.once("SIGTERM", resolve);
  });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await writeFile(capabilityPath, JSON.stringify({
      baseUrl: "http://race.test",
      pid: process.pid
    }), { mode: 0o600 });
    await terminated;
  } finally {
    clearInterval(keepAlive);
  }
} finally {
  await rm(capabilityPath, { force: true });
  await lock.close();
  await rm(lockPath, { force: true });
}

async function waitForBothStarters() {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const attempts = (await readFile(attemptsPath, "utf8"))
        .split("\n")
        .filter(Boolean);
      if (attempts.length === 2) return;
    } catch {
      // The first append may not be visible yet.
    }
    await delay(10);
  }
  throw new Error("both isolated starters did not reach the race barrier");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
