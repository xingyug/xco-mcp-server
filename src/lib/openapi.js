import path from "node:path";
import { pathToFileURL } from "node:url";

import { readJson } from "./json.js";
import {
  fileExists,
  getContentSchema,
  HTTP_METHODS,
  listJsonFiles,
  makeToolName,
  pickJsonContentType,
  slugify,
  summarizeText,
} from "./utils.js";

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function resolveLocalRef(document, ref) {
  if (!ref?.startsWith("#/")) {
    return null;
  }

  return ref
    .slice(2)
    .split("/")
    .reduce((current, key) => current?.[decodeURIComponent(key)], document);
}

export function dereferenceSchema(document, schema, stack = new Set()) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (schema.$ref) {
    if (stack.has(schema.$ref)) {
      return { ...schema };
    }

    const resolved = resolveLocalRef(document, schema.$ref);
    if (!resolved) {
      return { ...schema };
    }

    const nextStack = new Set(stack);
    nextStack.add(schema.$ref);
    return dereferenceSchema(document, resolved, nextStack);
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(document, item, stack));
  }

  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      output[key] = Object.fromEntries(
        Object.entries(value).map(([propKey, propValue]) => [
          propKey,
          dereferenceSchema(document, propValue, stack),
        ]),
      );
      continue;
    }

    if (key === "items") {
      output[key] = dereferenceSchema(document, value, stack);
      continue;
    }

    if (Array.isArray(value)) {
      output[key] = value.map((item) =>
        dereferenceSchema(document, item, stack),
      );
      continue;
    }

    if (value && typeof value === "object") {
      output[key] = dereferenceSchema(document, value, stack);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function mergeParameters(pathParameters = [], operationParameters = []) {
  const merged = new Map();

  for (const parameter of [...pathParameters, ...operationParameters]) {
    const key = `${parameter?.in}:${parameter?.name}`;
    merged.set(key, parameter);
  }

  return Array.from(merged.values());
}

function compactSchema(schema, depth = 0, maxDepth = 2) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const output = {};
  const type =
    schema.type ??
    (schema.properties ? "object" : schema.items ? "array" : undefined);
  if (type) {
    output.type = type;
  }

  if (schema.description) {
    output.description = schema.description;
  }

  if (schema.enum && depth <= maxDepth) {
    output.enum = schema.enum;
  }

  if (schema.example !== undefined && depth <= 1) {
    output.example = schema.example;
  }

  if (schema.required && depth <= maxDepth) {
    output.required = schema.required;
  }

  if (depth >= maxDepth) {
    return output;
  }

  if (schema.properties && typeof schema.properties === "object") {
    output.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        compactSchema(value, depth + 1, maxDepth),
      ]),
    );
  }

  if (schema.items) {
    output.items = compactSchema(schema.items, depth + 1, maxDepth);
  }

  return output;
}

function schemaFromParameter(document, parameter) {
  const resolvedParameter = parameter?.$ref
    ? resolveLocalRef(document, parameter.$ref)
    : parameter;
  const schema = resolvedParameter?.schema
    ? dereferenceSchema(document, resolvedParameter.schema)
    : { type: "string" };

  return {
    ...schema,
    description: summarizeText(
      [resolvedParameter?.description, `Location: ${resolvedParameter?.in}`]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

function buildInputSchema(document, pathItem, operation) {
  const properties = {};
  const required = [];
  const parameters = mergeParameters(pathItem.parameters, operation.parameters);

  for (const parameter of parameters) {
    const resolvedParameter = parameter?.$ref
      ? resolveLocalRef(document, parameter.$ref)
      : parameter;
    if (!resolvedParameter?.name) {
      continue;
    }

    properties[resolvedParameter.name] = schemaFromParameter(
      document,
      resolvedParameter,
    );
    if (resolvedParameter.required) {
      required.push(resolvedParameter.name);
    }
  }

  const bodyDescriptor = getContentSchema(operation.requestBody?.content);
  if (bodyDescriptor.schema) {
    properties.body = {
      ...compactSchema(dereferenceSchema(document, bodyDescriptor.schema)),
      description: summarizeText(
        [
          operation.requestBody?.description,
          bodyDescriptor.contentType
            ? `Content-Type: ${bodyDescriptor.contentType}`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    };

    if (operation.requestBody?.required) {
      required.push("body");
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function operationRequiresAuth(document, operation) {
  const security = operation.security ?? document.security;
  if (!Array.isArray(security)) {
    return false;
  }

  return security.length > 0;
}

function describeOperation(
  document,
  service,
  routePath,
  method,
  pathItem,
  operation,
) {
  const serverUrl = document.servers?.[0]?.url ?? null;
  const serverPathname = serverUrl
    ? new URL(serverUrl, "http://placeholder.local").pathname
    : "";
  const operationId = operation.operationId ?? null;
  const toolName = makeToolName(
    service.serviceSlug,
    operationId,
    method,
    routePath,
  );
  const contentType = pickJsonContentType(operation.requestBody?.content);

  return {
    name: toolName,
    title:
      operation.summary ??
      operationId ??
      `${method.toUpperCase()} ${routePath}`,
    description: summarizeText(
      [
        service.title,
        operation.description ?? operation.summary,
        `HTTP ${method.toUpperCase()} ${serverPathname}${routePath}`,
      ]
        .filter(Boolean)
        .join(" "),
    ),
    inputSchema: buildInputSchema(document, pathItem, operation),
    operation: {
      serviceSlug: service.serviceSlug,
      serviceTitle: service.title,
      serviceDocUrl: service.docUrl ?? null,
      serviceVersion: document.info?.version ?? service.version ?? null,
      serverPathname,
      method: method.toUpperCase(),
      path: routePath,
      operationId,
      summary: operation.summary ?? null,
      description: operation.description ?? null,
      tags: operation.tags ?? [],
      requiresAuth: operationRequiresAuth(document, operation),
      parameters: mergeParameters(
        pathItem.parameters,
        operation.parameters,
      ).map((parameter) =>
        parameter?.$ref
          ? resolveLocalRef(document, parameter.$ref)
          : deepClone(parameter),
      ),
      requestContentType: contentType,
      requestBodyRequired: Boolean(operation.requestBody?.required),
      requestBodySchema: contentType
        ? dereferenceSchema(
            document,
            operation.requestBody?.content?.[contentType]?.schema,
          )
        : null,
      rawOperation: deepClone(operation),
    },
  };
}

function inferServiceTitle(spec, filePath) {
  return spec.info?.title ?? path.basename(filePath, ".json");
}

function inferServiceSlug(spec, filePath) {
  const fileSlug = slugify(path.basename(filePath, ".json"));
  const infoTitle = spec.info?.title ? slugify(spec.info.title) : null;
  return infoTitle ?? fileSlug;
}

export async function loadSpecEntries(config) {
  const entries = [];

  if (config.activeVersion) {
    const versionDir = path.join(
      config.xcoHome,
      "versions",
      config.activeVersion,
    );
    const manifestPath = path.join(versionDir, "manifest.json");
    if (await fileExists(manifestPath)) {
      const manifest = await readJson(manifestPath);
      for (const service of manifest.services ?? []) {
        const specPath = path.join(versionDir, service.specFile);
        const spec = await readJson(specPath);
        entries.push({
          serviceSlug: service.serviceSlug ?? inferServiceSlug(spec, specPath),
          title: service.title ?? inferServiceTitle(spec, specPath),
          docUrl: service.docUrl ?? null,
          version: manifest.version,
          specPath,
          spec,
        });
      }

      return entries;
    }
  }

  const files = await listJsonFiles(config.manualSpecsDir);
  for (const specPath of files) {
    const spec = await readJson(specPath);
    entries.push({
      serviceSlug: inferServiceSlug(spec, specPath),
      title: inferServiceTitle(spec, specPath),
      version: spec.info?.version ?? null,
      specPath,
      spec,
      docUrl: pathToFileURL(specPath).href,
    });
  }

  return entries;
}

export async function loadOperations(config) {
  const specEntries = await loadSpecEntries(config);
  const operations = [];

  for (const entry of specEntries) {
    for (const [routePath, pathItem] of Object.entries(
      entry.spec.paths ?? {},
    )) {
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!HTTP_METHODS.has(method)) {
          continue;
        }

        operations.push(
          describeOperation(
            entry.spec,
            entry,
            routePath,
            method,
            pathItem,
            operation,
          ),
        );
      }
    }
  }

  operations.sort((left, right) => left.name.localeCompare(right.name));
  return {
    specEntries,
    operations,
  };
}
