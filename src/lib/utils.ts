import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

export function slugify(value: string): string {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export function versionToSlug(version: string): string {
  return String(version).trim();
}

export function versionToSupportPath(version: string): string {
  return versionToSlug(version).replaceAll(".", "-");
}

export function buildSupportDocsUrl(version: string): string {
  return `https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-${versionToSupportPath(version)}/`;
}

export function summarizeText(value: unknown, fallback = ""): string {
  if (!value) {
    return fallback;
  }

  return String(value).replace(/\s+/g, " ").trim();
}

export function inferServiceSlugFromTitle(title: string, docUrl: string): string {
  if (title) {
    return slugify(
      title
        .replace(/^ExtremeCloud Orchestrator\s+/i, "")
        .replace(/\s+Service API Reference.*$/i, "")
        .replace(/\s+API Reference.*$/i, ""),
    );
  }

  const basename = path.basename(new URL(docUrl).pathname, ".html");
  return slugify(basename);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listJsonFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".json")) {
        output.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  output.sort();
  return output;
}

export function mergeDefined(...objects: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const object of objects) {
    if (!object || typeof object !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(object)) {
      if (value !== undefined) {
        output[key] = value;
      }
    }
  }

  return output;
}

export function makeToolName(serviceSlug: string, operationId: string | null, method: string, routePath: string): string {
  const safeServiceSlug = String(serviceSlug).replace(/-/g, "_");

  if (operationId) {
    return `${safeServiceSlug}__${slugify(operationId).replace(/-/g, "_")}`;
  }

  const routeSlug = slugify(`${method} ${routePath}`).replace(/-/g, "_");
  return `${safeServiceSlug}__${routeSlug}`;
}

export function pickJsonContentType(content: Record<string, unknown> = {}): string | null {
  if (content["application/json"]) {
    return "application/json";
  }

  const first = Object.keys(content)[0];
  return first ?? null;
}

export function getContentSchema(content: Record<string, Record<string, unknown>> = {}): { contentType: string | null; schema: unknown } {
  const contentType = pickJsonContentType(content);
  if (!contentType) {
    return { contentType: null, schema: null };
  }

  return {
    contentType,
    schema: (content[contentType] as Record<string, unknown>)?.schema ?? null,
  };
}

export function encodeQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      encodeQueryValue(searchParams, key, item);
    }
    return;
  }

  if (typeof value === "object") {
    searchParams.append(key, JSON.stringify(value));
    return;
  }

  searchParams.append(key, String(value));
}

export function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${label} must be an object.`);
}

export function toAbsolutePath(cwd: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
