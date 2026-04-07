import { URL } from "node:url";

import type { EventListener, OperationInfo, RawRequestInput, XcoConfig, XcoResponse } from "../types.js";
import { encodeQueryValue, ensureObject } from "./utils.js";
import { isParseFailure, tryParseJson } from "./json.js";

interface OperationArgs {
  body?: unknown;
  _headers?: Record<string, string>;
  [key: string]: unknown;
}

interface ExecuteOptions {
  baseUrl?: string | null;
  onEvent?: EventListener;
}

function replacePathParameters(routePath: string, args: OperationArgs, parameters: OperationInfo["parameters"]): string {
  let output = routePath;

  for (const parameter of parameters.filter((item) => item.in === "path")) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter "${parameter.name}".`);
    }

    output = output.replaceAll(
      `{${parameter.name}}`,
      encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value)),
    );
  }

  return output;
}

function mergePath(basePath: string | null | undefined, leafPath: string | null | undefined): string {
  const left = (basePath ?? "").replace(/\/+$/, "");
  const right = (leafPath ?? "").replace(/^\/+/, "");

  if (!left && !right) {
    return "/";
  }

  if (!left) {
    return `/${right}`;
  }

  if (!right) {
    return left.startsWith("/") ? left : `/${left}`;
  }

  const merged = `${left}/${right}`;
  return merged.startsWith("/") ? merged : `/${merged}`;
}

function buildUrl(baseUrl: string, operation: OperationInfo, args: OperationArgs): URL {
  const url = new URL(baseUrl);
  const pathWithParams = replacePathParameters(
    operation.path,
    args,
    operation.parameters,
  );
  url.pathname = mergePath(
    url.pathname,
    mergePath(operation.serverPathname, pathWithParams),
  );

  const searchParams = new URLSearchParams(url.search);
  for (const parameter of operation.parameters.filter(
    (item) => item.in === "query",
  )) {
    encodeQueryValue(searchParams, parameter.name, args[parameter.name]);
  }

  url.search = searchParams.toString();
  return url;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }

    output[key] = typeof value === "string" ? value : JSON.stringify(value);
  }

  return output;
}

function buildBody(operation: OperationInfo, args: OperationArgs): string | null {
  if (args.body === undefined) {
    return null;
  }

  if (
    !operation.requestContentType ||
    operation.requestContentType.includes("json")
  ) {
    return JSON.stringify(args.body);
  }

  if (typeof args.body === "string") {
    return args.body;
  }

  return JSON.stringify(args.body);
}

export async function executeOperation(
  config: XcoConfig,
  token: string | null,
  operation: OperationInfo,
  args: OperationArgs = {},
  options: ExecuteOptions = {},
): Promise<XcoResponse> {
  const baseUrl = options.baseUrl ?? config.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "Missing XCO base URL. Set XCO_BASE_URL, configure it during setup, or pass baseUrl explicitly.",
    );
  }

  ensureObject(args, "Tool arguments");
  const url = buildUrl(baseUrl, operation, args);
  const headers = normalizeHeaders({
    ...args._headers,
    accept: "application/json",
    ...(operation.requestContentType && args.body !== undefined
      ? { "content-type": operation.requestContentType }
      : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  const response = await fetch(url, {
    method: operation.method,
    headers,
    body: buildBody(operation, args),
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseContentType = response.headers.get("content-type") ?? "";
  const responseText = await response.text();
  const responseBody = responseContentType.includes("json")
    ? (() => { const parsed = tryParseJson(responseText); return isParseFailure(parsed) ? responseText : parsed; })()
    : responseText;

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: url.toString(),
    headers: responseHeaders,
    body: responseBody as Record<string, unknown> | string | null,
  };
}

export async function executeRawRequest(config: XcoConfig, token: string | null, input: RawRequestInput = {}): Promise<XcoResponse> {
  ensureObject(input, "Raw request input");
  const baseUrl = input.baseUrl ?? config.baseUrl;
  if (!baseUrl) {
    throw new Error("Missing XCO base URL for raw request.");
  }

  const url = new URL(baseUrl);
  url.pathname = mergePath(
    url.pathname,
    mergePath(input.servicePrefix ?? "", input.path ?? ""),
  );
  for (const [key, value] of Object.entries(input.query ?? {})) {
    encodeQueryValue(url.searchParams, key, value);
  }

  const headers = normalizeHeaders({
    accept: "application/json",
    ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...input.headers,
  });

  const response = await fetch(url, {
    method: (input.method ?? "GET").toUpperCase(),
    headers,
    body: input.body === undefined ? null : JSON.stringify(input.body),
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseContentType = response.headers.get("content-type") ?? "";
  const responseText = await response.text();
  const responseBody = responseContentType.includes("json")
    ? (() => { const parsed = tryParseJson(responseText); return isParseFailure(parsed) ? responseText : parsed; })()
    : responseText;

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: url.toString(),
    headers: responseHeaders,
    body: responseBody as Record<string, unknown> | string | null,
  };
}
