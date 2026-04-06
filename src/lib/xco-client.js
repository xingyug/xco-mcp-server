import { URL } from "node:url";

import { encodeQueryValue, ensureObject } from "./utils.js";
import { tryParseJson } from "./json.js";

function replacePathParameters(routePath, args, parameters) {
  let output = routePath;

  for (const parameter of parameters.filter((item) => item?.in === "path")) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter "${parameter.name}".`);
    }

    output = output.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }

  return output;
}

function mergePath(basePath, leafPath) {
  const left = String(basePath ?? "").replace(/\/+$/, "");
  const right = String(leafPath ?? "").replace(/^\/+/, "");

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

function buildUrl(baseUrl, operation, args) {
  const url = new URL(baseUrl);
  const pathWithParams = replacePathParameters(operation.path, args, operation.parameters);
  url.pathname = mergePath(url.pathname, mergePath(operation.serverPathname, pathWithParams));

  const searchParams = new URLSearchParams(url.search);
  for (const parameter of operation.parameters.filter((item) => item?.in === "query")) {
    encodeQueryValue(searchParams, parameter.name, args[parameter.name]);
  }

  url.search = searchParams.toString();
  return url;
}

function normalizeHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }

    output[key] = String(value);
  }

  return output;
}

function buildBody(operation, args) {
  if (args.body === undefined) {
    return null;
  }

  if (!operation.requestContentType || operation.requestContentType.includes("json")) {
    return JSON.stringify(args.body);
  }

  if (typeof args.body === "string") {
    return args.body;
  }

  return JSON.stringify(args.body);
}

export async function executeOperation(config, token, operation, args = {}, options = {}) {
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
    ? (tryParseJson(responseText) ?? responseText)
    : responseText;

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: url.toString(),
    headers: responseHeaders,
    body: responseBody,
  };
}

export async function executeRawRequest(config, token, input = {}) {
  ensureObject(input, "Raw request input");
  const baseUrl = input.baseUrl ?? config.baseUrl;
  if (!baseUrl) {
    throw new Error("Missing XCO base URL for raw request.");
  }

  const url = new URL(baseUrl);
  url.pathname = mergePath(url.pathname, mergePath(input.servicePrefix ?? "", input.path ?? ""));
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
    method: String(input.method ?? "GET").toUpperCase(),
    headers,
    body: input.body === undefined ? null : JSON.stringify(input.body),
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseContentType = response.headers.get("content-type") ?? "";
  const responseText = await response.text();
  const responseBody = responseContentType.includes("json")
    ? (tryParseJson(responseText) ?? responseText)
    : responseText;

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: url.toString(),
    headers: responseHeaders,
    body: responseBody,
  };
}
