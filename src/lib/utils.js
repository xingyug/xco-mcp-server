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

export function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export function versionToSlug(version) {
  return String(version).trim();
}

export function versionToSupportPath(version) {
  return versionToSlug(version).replaceAll(".", "-");
}

export function buildSupportDocsUrl(version) {
  return `https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-${versionToSupportPath(version)}/`;
}

export function summarizeText(value, fallback = "") {
  if (!value) {
    return fallback;
  }

  return String(value).replace(/\s+/g, " ").trim();
}

export function inferServiceSlugFromTitle(title, docUrl) {
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

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listJsonFiles(rootDir) {
  const output = [];

  async function walk(currentDir) {
    let entries = [];
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

export function mergeDefined(...objects) {
  const output = {};

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

export function makeToolName(serviceSlug, operationId, method, routePath) {
  const safeServiceSlug = String(serviceSlug).replace(/-/g, "_");

  if (operationId) {
    return `${safeServiceSlug}__${slugify(operationId).replace(/-/g, "_")}`;
  }

  const routeSlug = slugify(`${method} ${routePath}`).replace(/-/g, "_");
  return `${safeServiceSlug}__${routeSlug}`;
}

export function pickJsonContentType(content = {}) {
  if (content["application/json"]) {
    return "application/json";
  }

  const first = Object.keys(content)[0];
  return first ?? null;
}

export function getContentSchema(content = {}) {
  const contentType = pickJsonContentType(content);
  if (!contentType) {
    return { contentType: null, schema: null };
  }

  return {
    contentType,
    schema: content[contentType]?.schema ?? null,
  };
}

export function encodeQueryValue(searchParams, key, value) {
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

export function ensureObject(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} must be an object.`);
}

export function toAbsolutePath(cwd, value) {
  if (!value) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function uniqueBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
