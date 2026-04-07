import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OperationParameter,
  PathItem,
  SpecEntry,
  ToolEntry,
  XcoConfig,
} from "../types.js";
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

function deepClone<T>(value: T): T {
  return value === undefined ? undefined as T : JSON.parse(JSON.stringify(value)) as T;
}

export function resolveLocalRef(document: OpenApiDocument, ref: string | undefined | null): unknown {
  if (!ref?.startsWith("#/")) {
    return null;
  }

  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((current: unknown, key: string) => current != null ? (current as Record<string, unknown>)[decodeURIComponent(key)] : undefined, document);
}

export function dereferenceSchema(document: OpenApiDocument, schema: unknown, stack = new Set<string>()): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const s = schema as Record<string, unknown>;

  if (s.$ref) {
    if (stack.has(s.$ref as string)) {
      return { ...s };
    }

    const resolved = resolveLocalRef(document, s.$ref as string);
    if (!resolved) {
      return { ...s };
    }

    const nextStack = new Set(stack);
    nextStack.add(s.$ref as string);
    return dereferenceSchema(document, resolved, nextStack);
  }

  if (Array.isArray(schema)) {
    return schema.map((item: unknown) => dereferenceSchema(document, item, stack));
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if (key === "properties" && value && typeof value === "object") {
      output[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propKey, propValue]) => [
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
      output[key] = value.map((item: unknown) =>
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

function mergeParameters(pathParameters: OperationParameter[] = [], operationParameters: OperationParameter[] = []): OperationParameter[] {
  const merged = new Map<string, OperationParameter>();

  for (const parameter of [...pathParameters, ...operationParameters]) {
    const key = `${parameter.in}:${parameter.name}`;
    merged.set(key, parameter);
  }

  return Array.from(merged.values());
}

function compactSchema(schema: unknown, depth = 0, maxDepth = 2): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const s = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const type =
    s.type ??
    (s.properties ? "object" : s.items ? "array" : undefined);
  if (type) {
    output.type = type;
  }

  if (s.description) {
    output.description = s.description;
  }

  if (s.enum && depth <= maxDepth) {
    output.enum = s.enum;
  }

  if (s.example !== undefined && depth <= 1) {
    output.example = s.example;
  }

  if (s.required && depth <= maxDepth) {
    output.required = s.required;
  }

  if (depth >= maxDepth) {
    return output;
  }

  if (s.properties && typeof s.properties === "object") {
    output.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([key, value]) => [
        key,
        compactSchema(value, depth + 1, maxDepth),
      ]),
    );
  }

  if (s.items) {
    output.items = compactSchema(s.items, depth + 1, maxDepth);
  }

  return output;
}

function schemaFromParameter(document: OpenApiDocument, parameter: OperationParameter): JsonSchema {
  const resolvedParameter = parameter.$ref
    ? resolveLocalRef(document, parameter.$ref) as OperationParameter
    : parameter;
  const schema = resolvedParameter.schema
    ? dereferenceSchema(document, resolvedParameter.schema) as JsonSchema
    : { type: "string" };

  return {
    ...schema,
    description: summarizeText(
      [resolvedParameter.description, `Location: ${resolvedParameter.in}`]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

function buildInputSchema(document: OpenApiDocument, pathItem: PathItem, operation: OpenApiOperation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameters = mergeParameters(
    pathItem.parameters,
    operation.parameters,
  );

  for (const parameter of parameters) {
    const resolvedParameter = parameter.$ref
      ? resolveLocalRef(document, parameter.$ref) as OperationParameter
      : parameter;
    if (!resolvedParameter.name) {
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

  const bodyDescriptor = getContentSchema(operation.requestBody?.content as Record<string, Record<string, unknown>>);
  if (bodyDescriptor.schema) {
    properties.body = {
      ...(compactSchema(dereferenceSchema(document, bodyDescriptor.schema)) as JsonSchema),
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

function operationRequiresAuth(document: OpenApiDocument, operation: OpenApiOperation): boolean {
  const security = operation.security ?? document.security;
  if (!Array.isArray(security)) {
    return false;
  }

  return security.length > 0;
}

function describeOperation(
  document: OpenApiDocument,
  service: SpecEntry,
  routePath: string,
  method: string,
  pathItem: PathItem,
  operation: OpenApiOperation,
): ToolEntry {
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
  const contentType = pickJsonContentType(operation.requestBody?.content as Record<string, unknown>);

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
        parameter.$ref
          ? resolveLocalRef(document, parameter.$ref) as OperationParameter
          : deepClone(parameter),
      ),
      requestContentType: contentType,
      requestBodyRequired: Boolean(operation.requestBody?.required),
      requestBodySchema: contentType
        ? dereferenceSchema(
            document,
            operation.requestBody?.content?.[contentType]?.schema,
          ) as JsonSchema | null
        : null,
      rawOperation: deepClone(operation) as Record<string, unknown>,
    },
  };
}

function inferServiceTitle(spec: OpenApiDocument, filePath: string): string {
  return spec.info?.title ?? path.basename(filePath, ".json");
}

function inferServiceSlug(spec: OpenApiDocument, filePath: string): string {
  const fileSlug = slugify(path.basename(filePath, ".json"));
  const infoTitle = spec.info?.title ? slugify(spec.info.title) : null;
  return infoTitle ?? fileSlug;
}

export async function loadSpecEntries(config: XcoConfig): Promise<SpecEntry[]> {
  const entries: SpecEntry[] = [];

  if (config.activeVersion) {
    const versionDir = path.join(
      config.xcoHome,
      "versions",
      config.activeVersion,
    );
    const manifestPath = path.join(versionDir, "manifest.json");
    if (await fileExists(manifestPath)) {
      const manifest = (await readJson(manifestPath)) as Record<string, unknown>;
      for (const service of (manifest.services as Record<string, unknown>[] | undefined) ?? []) {
        const specPath = path.join(versionDir, service.specFile as string);
        const spec = (await readJson(specPath)) as OpenApiDocument;
        entries.push({
          serviceSlug: (service.serviceSlug as string | undefined) ?? inferServiceSlug(spec, specPath),
          title: (service.title as string | undefined) ?? inferServiceTitle(spec, specPath),
          docUrl: (service.docUrl as string | undefined) ?? null,
          version: manifest.version as string,
          specPath,
          spec,
        });
      }

      return entries;
    }
  }

  const files = await listJsonFiles(config.manualSpecsDir);
  for (const specPath of files) {
    const spec = (await readJson(specPath)) as OpenApiDocument;
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

export async function loadOperations(config: XcoConfig): Promise<{ specEntries: SpecEntry[]; operations: ToolEntry[] }> {
  const specEntries = await loadSpecEntries(config);
  const operations: ToolEntry[] = [];

  for (const entry of specEntries) {
    for (const [routePath, pathItem] of Object.entries(
      entry.spec.paths ?? {},
    )) {
      for (const [method, operation] of Object.entries(pathItem)) {
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
            operation as OpenApiOperation,
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
