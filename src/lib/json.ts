import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath: string): Promise<unknown> {
  const contents = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseJsonText(text: string, label = "JSON"): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${(error as Error).message}`);
  }
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
