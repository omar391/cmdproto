import { loadSchemaFromFile } from "../src/index.js";

const schemaPath = process.argv[2];

if (!schemaPath) {
  console.error("Usage: tsx scripts/validate-schema.ts <schema.binpb>");
  process.exit(1);
}

try {
  loadSchemaFromFile(schemaPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
