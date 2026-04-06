import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseJsonText(text, label = "JSON") {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${error.message}`);
  }
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
