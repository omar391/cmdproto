export function formatTable(entries) {
  const width = entries.reduce((longest, [label]) => Math.max(longest, label.length), 0) + 2;
  return entries.map(([label, description]) => `  ${label.padEnd(width)}${description}`);
}

export function renderUsage(headline, sections = []) {
  const lines = [`Usage: ${headline}`];

  for (const section of sections) {
    if (!section.entries.length) {
      continue;
    }
    lines.push("", section.heading + ":");
    lines.push(...formatTable(section.entries));
  }

  return lines.join("\n");
}

export function normalizeToken(value) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "app";
}

export function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
