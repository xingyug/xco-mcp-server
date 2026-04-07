import fs from "node:fs/promises";
import path from "node:path";

import type {
  DownloadOptions,
  EventListener,
  FetchTextOptions,
  Manifest,
  ManifestService,
  OpenApiDocument,
  ServiceReference,
} from "../types.js";
import { tryParseJson, writeJson } from "./json.js";
import {
  buildSupportDocsUrl,
  HTTP_METHODS,
  inferServiceSlugFromTitle,
  summarizeText,
  uniqueBy,
} from "./utils.js";

const ANCHOR_REGEX = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gim;

function stripHtml(fragment: string): string {
  return summarizeText(fragment.replace(/<[^>]+>/g, " "));
}

function normalizeSpecSource(value: unknown): string {
  const raw = typeof value === "string" ? value : "official";
  const normalized = raw.trim().toLowerCase();
  if (["official", "instance", "auto"].includes(normalized)) {
    return normalized;
  }

  throw new Error(
    `Unsupported spec source "${raw}". Expected official, instance, or auto.`,
  );
}

function resolveDocumentUrl(href: string, pageUrl: string): string | null {
  if (!href || /^javascript:/i.test(href) || href.startsWith("#")) {
    return null;
  }

  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

function isOpenApiSpec(value: unknown): value is OpenApiDocument {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).paths &&
    (typeof (value as Record<string, unknown>).openapi === "string" || typeof (value as Record<string, unknown>).swagger === "string"),
  );
}

function parseSemver(value: unknown): { major: number; minor: number; patch: number } | null {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function getOfficialDocsVersion(version: string): string {
  const parsed = parseSemver(version);
  if (!parsed || parsed.patch === 0) {
    return version;
  }

  return `${parsed.major}.${parsed.minor}.0`;
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is not available in this Node runtime.");
  }

  const response = await fetchImpl(url, {
    headers: {
      "user-agent": "xco-mcp-server/0.1",
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
}

export function extractAvailableVersions(supportDocsHtml: string): string[] {
  const matches = supportDocsHtml.match(/Version\s+(\d+\.\d+\.\d+)/g) ?? [];
  return Array.from(
    new Set(matches.map((match) => match.replace(/^Version\s+/i, "").trim())),
  ).sort();
}

export function extractServiceReferences(
  supportDocsHtml: string,
  fetchPageUrl = "https://placeholder.local/",
  publicPageUrl = fetchPageUrl,
): ServiceReference[] {
  const references: ServiceReference[] = [];

  for (const match of supportDocsHtml.matchAll(ANCHOR_REGEX)) {
    const fetchUrl = resolveDocumentUrl(match[2], fetchPageUrl);
    const publicDocUrl = resolveDocumentUrl(match[2], publicPageUrl);
    if (!fetchUrl || !publicDocUrl) {
      continue;
    }

    const innerHtml = match[3];
    const headerMatch = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/im.exec(innerHtml);
    const title = stripHtml(headerMatch?.[1] ?? innerHtml);
    if (!/api reference/i.test(title)) {
      continue;
    }

    const serviceSlug = inferServiceSlugFromTitle(title, publicDocUrl);

    references.push({
      title,
      docUrl: publicDocUrl,
      fetchUrl,
      serviceSlug,
    });
  }

  return uniqueBy(references, (item) => item.fetchUrl ?? item.docUrl);
}

export function extractSpecFromRedocHtml(docHtml: string): OpenApiDocument {
  const marker = "const __redoc_state = ";
  const start = docHtml.indexOf(marker);
  if (start === -1) {
    throw new Error("Unable to locate Redoc state in API reference page.");
  }

  const afterStart = start + marker.length;
  const trailingHtml = docHtml.slice(afterStart);
  const endMatch = /;\s*var container\b/.exec(trailingHtml);
  if (!endMatch) {
    throw new Error("Unable to find the end of the embedded Redoc state.");
  }

  const stateJson = trailingHtml.slice(0, endMatch.index).trim();
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(stateJson) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Failed to parse embedded Redoc state JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const spec = (state.spec as Record<string, unknown> | undefined)?.data as OpenApiDocument | undefined;

  if (!spec?.openapi || !spec.paths) {
    throw new Error("Embedded Redoc state does not contain an OpenAPI spec.");
  }

  return spec;
}

export function extractSpecFromDocument(documentText: string): OpenApiDocument {
  const directSpec = tryParseJson(documentText.trim());
  if (isOpenApiSpec(directSpec)) {
    return directSpec;
  }

  return extractSpecFromRedocHtml(documentText);
}

interface DiscoverSourceOptions extends FetchTextOptions {
  specSource?: string;
  requestDocsUrl?: string | null;
  docsUrl?: string | null;
}

interface DiscoverResult {
  source: {
    kind: string;
    docsVersion?: string;
    indexUrl: string;
    publicUrl: string;
  };
  references: ServiceReference[];
}

async function discoverSource(version: string, options: DiscoverSourceOptions = {}): Promise<DiscoverResult | null> {
  const specSource = normalizeSpecSource(options.specSource);
  const candidates: {
    kind: string;
    docsVersion?: string;
    indexUrl: string;
    publicUrl: string;
  }[] = [];

  if (specSource === "instance" || specSource === "auto") {
    if (options.requestDocsUrl) {
      candidates.push({
        kind: "instance",
        indexUrl: options.requestDocsUrl,
        publicUrl: options.docsUrl ?? options.requestDocsUrl,
      });
    } else if (specSource === "instance") {
      throw new Error(
        "specSource=instance requires docsUrl or a baseUrl-derived instance docs URL.",
      );
    }
  }

  if (specSource === "official" || specSource === "auto") {
    const docsVersion = getOfficialDocsVersion(version);
    const officialSupportDocsUrl = buildSupportDocsUrl(docsVersion);
    candidates.push({
      kind: "official",
      docsVersion,
      indexUrl: officialSupportDocsUrl,
      publicUrl: officialSupportDocsUrl,
    });
  }

  for (const candidate of candidates) {
    let indexText: string;
    try {
      indexText = await fetchText(candidate.indexUrl, options);
    } catch {
      continue;
    }
    const references = extractServiceReferences(
      indexText,
      candidate.indexUrl,
      candidate.publicUrl,
    );
    if (references.length > 0) {
      return {
        source: candidate,
        references,
      };
    }

    try {
      const spec = extractSpecFromDocument(indexText);
      return {
        source: candidate,
        references: [
          {
            title: spec.info?.title ?? `XCO ${version} OpenAPI`,
            docUrl: candidate.publicUrl,
            serviceSlug: inferServiceSlugFromTitle(
              spec.info?.title ?? "openapi",
              candidate.publicUrl,
            ),
            embeddedSpec: spec,
          },
        ],
      };
    } catch {
      // Try the next candidate source.
    }
  }

  return null;
}

export async function downloadVersionBundle(version: string, options: DownloadOptions = {}): Promise<Manifest> {
  const xcoHome = options.xcoHome ?? path.join(process.cwd(), ".xco");
  const versionDir = path.join(xcoHome, "versions", version);
  const servicesDir = path.join(versionDir, "services");
  const overwrite = Boolean(options.overwrite);
  const onEvent: EventListener = options.onEvent ?? ((() => { /* no-op */ }) as EventListener);
  const requestedSpecSource = normalizeSpecSource(options.specSource);

  onEvent({
    level: "info",
    phase: "spec-discovery",
    message: `Discovering API docs for XCO ${version}`,
    version,
  });

  const discovered = await discoverSource(version, options);
  if (!discovered) {
    throw new Error(
      `No API reference links or embedded OpenAPI specs were found for XCO ${version}.`,
    );
  }

  await fs.mkdir(servicesDir, { recursive: true });

  const services: ManifestService[] = [];
  for (const reference of discovered.references) {
    const specFileName = `${reference.serviceSlug}.json`;
    const specFilePath = path.join(servicesDir, specFileName);

    if (!overwrite) {
      try {
        const existing = JSON.parse(await fs.readFile(specFilePath, "utf8")) as OpenApiDocument;
        services.push({
          title: reference.title,
          serviceSlug: reference.serviceSlug,
          docUrl: reference.docUrl,
          specFile: path.relative(versionDir, specFilePath),
          specTitle: existing.info?.title ?? null,
          specVersion: existing.info?.version ?? null,
          operationCount: Object.values(existing.paths ?? {}).reduce(
            (count: number, pathItem) =>
              count +
              Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k))
                .length,
            0,
          ),
          reused: true,
        });
        onEvent({
          level: "info",
          phase: "reuse-spec",
          version,
          service: reference.serviceSlug,
          message: `Reused cached spec for ${reference.serviceSlug}`,
        });
        continue;
      } catch {
        // Fetch below.
      }
    }

    onEvent({
      level: "info",
      phase: "download-service",
      version,
      service: reference.serviceSlug,
      message: `Fetching ${reference.title}`,
      url: reference.fetchUrl ?? reference.docUrl,
    });

    const spec =
      reference.embeddedSpec ??
      extractSpecFromDocument(
        await fetchText(reference.fetchUrl ?? reference.docUrl, options),
      );
    await writeJson(specFilePath, spec);

    services.push({
      title: reference.title,
      serviceSlug: reference.serviceSlug,
      docUrl: reference.docUrl,
      specFile: path.relative(versionDir, specFilePath),
      specTitle: spec.info?.title ?? null,
      specVersion: spec.info?.version ?? null,
      operationCount: Object.values(spec.paths ?? {}).reduce(
        (count: number, pathItem) =>
          count +
          Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k)).length,
        0,
      ),
      reused: false,
    });
  }

  const manifest: Manifest = {
    version,
    requestedSpecSource,
    resolvedSpecSource: discovered.source.kind,
    resolvedDocsVersion: discovered.source.docsVersion ?? version,
    sourceIndexUrl: discovered.source.publicUrl,
    sourceFetchUrl: discovered.source.indexUrl,
    downloadedAt: new Date().toISOString(),
    services,
  };

  await writeJson(path.join(versionDir, "manifest.json"), manifest);
  return manifest;
}
