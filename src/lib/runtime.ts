import fs from "node:fs/promises";
import path from "node:path";

import type {
  ActiveTunnel,
  AuthHeaderToken,
  AuthSession,
  ConfigOverrides,
  EventListener,
  InstalledVersion,
  LoadConfigOptions,
  OperationInfo,
  RuntimeCallOptions,
  SpecEntry,
  ToolDefinition,
  ToolEntry,
  ToolResult,
  XcoConfig,
  XcoResponse,
} from "../types.js";
import {
  loadConfig,
  resolveCredentials,
  resolveToken,
  resolveUsername,
  saveConfig,
} from "./config.js";
import {
  downloadVersionBundle,
  extractAvailableVersions,
  fetchText,
} from "./downloader.js";
import {
  buildSessionKey,
  deleteSession,
  getTokenExpiresAt,
  isExpired,
  readSession,
  summarizeSession,
  writeSession,
} from "./auth.js";
import { executeOperation, executeRawRequest } from "./xco-client.js";
import { loadOperations } from "./openapi.js";
import {
  buildTunnelKey,
  getTunnelSettings,
  hasTunnelConfigured,
  startSshTunnel,
  stopSshTunnel,
} from "./tunnel.js";
import { buildSupportDocsUrl, fileExists, HTTP_METHODS, normalizeKeys } from "./utils.js";

const META_TOOLS = [
  {
    name: "xco_setup_version",
    title: "Setup XCO Version",
    description:
      "Download the OpenAPI bundle for a specific XCO version from official docs, instance docs, or both, and optionally activate it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: {
          type: "string",
          description: "XCO version to download, for example 3.7.0",
        },
        specSource: {
          type: "string",
          description:
            "Spec source mode: official, instance, or auto. Auto tries instance docs first and falls back to official docs.",
          enum: ["official", "instance", "auto"],
        },
        docsUrl: {
          type: "string",
          description:
            "Optional instance docs landing page or direct Redoc/OpenAPI URL. If omitted in instance/auto mode, /docs/ is derived from baseUrl.",
        },
        baseUrl: {
          type: "string",
          description:
            "Optional XCO instance base URL to persist for subsequent calls.",
        },
        username: {
          type: "string",
          description:
            "Optional XCO username to persist for password-based login.",
        },
        usernameEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the XCO username from.",
        },
        passwordEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the XCO password from.",
        },
        tokenEnv: {
          type: "string",
          description:
            "Optional environment variable name to read a static bearer token from.",
        },
        readonly: {
          type: "boolean",
          description:
            "When true, only read operations are exposed and write calls are blocked.",
        },
        bastionJumps: {
          type: "string",
          description:
            "Comma-separated SSH bastion chain, for example user@jump1,user@jump2.",
        },
        bastionIdentityFile: {
          type: "string",
          description: "Optional SSH private key path for bastion access.",
        },
        bastionPasswordAuth: {
          type: "boolean",
          description:
            "Explicit opt-in for non-interactive bastion password auth. Not recommended unless key-based SSH is unavailable.",
        },
        bastionPassword: {
          type: "string",
          description:
            "Optional one-time bastion password. It is not persisted to config.",
        },
        bastionPasswordEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the bastion password from.",
        },
        bastionPasswordsEnv: {
          type: "string",
          description:
            "Optional comma-separated environment variable names for per-hop bastion passwords (one per jump host in order).",
        },
        bastionTargetHost: {
          type: "string",
          description:
            "Optional XCO host override reachable from the bastion chain.",
        },
        bastionTargetPort: {
          type: "integer",
          description:
            "Optional XCO port override reachable from the bastion chain.",
        },
        bastionLocalPort: {
          type: "integer",
          description:
            "Optional fixed local tunnel port. By default an ephemeral port is used.",
        },
        bastionBindHost: {
          type: "string",
          description:
            "Optional local bind host for the SSH tunnel. Defaults to 127.0.0.1.",
        },
        bastionStrictHostKeyChecking: {
          type: "boolean",
          description:
            "Optional SSH StrictHostKeyChecking setting for the bastion tunnel.",
        },
        tlsRejectUnauthorized: {
          type: "string",
          description:
            'Set to "0" to disable TLS certificate validation (for corporate XCO instances with self-signed certs).',
        },
        overwrite: {
          type: "boolean",
          description: "When true, force re-download of cached service specs.",
        },
        activate: {
          type: "boolean",
          description:
            "When true, switch the active bundle to this version after download.",
        },
      },
      required: ["version"],
    },
  },
  {
    name: "xco_use_version",
    title: "Switch Active XCO Version",
    description:
      "Switch the runtime to an already-downloaded XCO version bundle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: {
          type: "string",
          description: "Installed XCO version to activate.",
        },
        specSource: {
          type: "string",
          description:
            "Persisted spec source mode for future setup operations.",
          enum: ["official", "instance", "auto"],
        },
        docsUrl: {
          type: "string",
          description:
            "Persisted instance docs landing page or direct Redoc/OpenAPI URL.",
        },
        baseUrl: {
          type: "string",
          description: "Optional XCO instance base URL to persist.",
        },
        username: {
          type: "string",
          description:
            "Optional XCO username to persist for password-based login.",
        },
        usernameEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the XCO username from.",
        },
        passwordEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the XCO password from.",
        },
        tokenEnv: {
          type: "string",
          description:
            "Optional environment variable name to read a static bearer token from.",
        },
        readonly: {
          type: "boolean",
          description:
            "When true, only read operations are exposed and write calls are blocked.",
        },
        bastionJumps: {
          type: "string",
          description:
            "Comma-separated SSH bastion chain, for example user@jump1,user@jump2.",
        },
        bastionIdentityFile: {
          type: "string",
          description: "Optional SSH private key path for bastion access.",
        },
        bastionPasswordAuth: {
          type: "boolean",
          description:
            "Explicit opt-in for non-interactive bastion password auth. Not recommended unless key-based SSH is unavailable.",
        },
        bastionPassword: {
          type: "string",
          description:
            "Optional one-time bastion password. It is not persisted to config.",
        },
        bastionPasswordEnv: {
          type: "string",
          description:
            "Optional environment variable name to read the bastion password from.",
        },
        bastionPasswordsEnv: {
          type: "string",
          description:
            "Optional comma-separated environment variable names for per-hop bastion passwords (one per jump host in order).",
        },
        bastionTargetHost: {
          type: "string",
          description:
            "Optional XCO host override reachable from the bastion chain.",
        },
        bastionTargetPort: {
          type: "integer",
          description:
            "Optional XCO port override reachable from the bastion chain.",
        },
        bastionLocalPort: {
          type: "integer",
          description:
            "Optional fixed local tunnel port. By default an ephemeral port is used.",
        },
        bastionBindHost: {
          type: "string",
          description:
            "Optional local bind host for the SSH tunnel. Defaults to 127.0.0.1.",
        },
        bastionStrictHostKeyChecking: {
          type: "boolean",
          description:
            "Optional SSH StrictHostKeyChecking setting for the bastion tunnel.",
        },
        tlsRejectUnauthorized: {
          type: "string",
          description:
            'Set to "0" to disable TLS certificate validation (for corporate XCO instances with self-signed certs).',
        },
      },
      required: ["version"],
    },
  },
  {
    name: "xco_list_versions",
    title: "List Versions",
    description:
      "List installed XCO versions and optionally discover versions listed on the official docs site.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        remote: {
          type: "boolean",
          description:
            "When true, also scrape the official support docs to discover published versions.",
        },
      },
    },
  },
  {
    name: "xco_describe_bundle",
    title: "Describe Active Bundle",
    description:
      "Describe the currently active XCO bundle, loaded services, and generated tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "xco_auth_login",
    title: "Login To XCO",
    description:
      "Authenticate to XCO with username and password, cache the access token, and enable auto-refresh.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: {
          type: "string",
          description: "Optional XCO instance base URL override.",
        },
        username: {
          type: "string",
          description: "XCO username.",
        },
        password: {
          type: "string",
          description: "XCO password.",
        },
        usernameEnv: {
          type: "string",
          description: "Environment variable name for the username.",
        },
        passwordEnv: {
          type: "string",
          description: "Environment variable name for the password.",
        },
        persistConfig: {
          type: "boolean",
          description:
            "When true, persist baseUrl, username, usernameEnv, and passwordEnv into the local config.",
        },
      },
    },
  },
  {
    name: "xco_auth_status",
    title: "Auth Status",
    description:
      "Show whether static tokens, username/password auth, and cached refreshable sessions are available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: {
          type: "string",
          description: "Optional XCO instance base URL override.",
        },
        username: {
          type: "string",
          description: "Optional XCO username override.",
        },
      },
    },
  },
  {
    name: "xco_auth_logout",
    title: "Logout From XCO",
    description:
      "Clear the cached login session for the current base URL, version, and username.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: {
          type: "string",
          description: "Optional XCO instance base URL override.",
        },
        username: {
          type: "string",
          description: "Optional XCO username override.",
        },
      },
    },
  },
  {
    name: "xco_raw_request",
    title: "Raw XCO Request",
    description:
      "Send a raw HTTP request to the configured XCO instance without going through generated tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: {
          type: "string",
          description: "HTTP method, for example GET or POST.",
        },
        servicePrefix: {
          type: "string",
          description: "Optional API prefix such as /v1/tenant.",
        },
        path: {
          type: "string",
          description: "Relative API path such as /tenants.",
        },
        query: {
          type: "object",
          additionalProperties: true,
          description: "Query parameters object.",
        },
        body: {
          type: "object",
          additionalProperties: true,
          description: "JSON request body.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Additional HTTP headers.",
        },
        baseUrl: {
          type: "string",
          description: "Optional per-call override for the XCO base URL.",
        },
        authenticate: {
          type: "boolean",
          description:
            "When true, attach a bearer token and auto-login if needed. Defaults to true except for login endpoints.",
        },
      },
      required: ["method", "path"],
    },
  },
];

const META_TOOL_NAMES = new Set(META_TOOLS.map((tool) => tool.name));

const READONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type ToolInput = Record<string, unknown>;

function asToolResult(result: unknown, options: { isError?: boolean } = {}): ToolResult {
  return {
    isError: Boolean(options.isError),
    structuredContent: result,
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function extractErrorMessage(body: unknown, fallback = "Request failed."): string {
  if (!body) {
    return fallback;
  }

  if (typeof body === "string") {
    return body;
  }

  const record = body as Record<string, unknown>;

  if (typeof record.message === "string") {
    return record.message;
  }

  if (typeof record.error === "string") {
    return record.error;
  }

  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return (record.errors as Record<string, unknown>[])
      .map((item) => (item.message as string | undefined) ?? JSON.stringify(item))
      .join("; ");
  }

  if (typeof record.code !== "undefined" || typeof record.message !== "undefined") {
    return JSON.stringify(body);
  }

  return fallback;
}

function buildAuthConfigPatch(
  input: ToolInput = {},
  config: Partial<XcoConfig> = {},
): ConfigOverrides {
  return {
    specSource: (input.specSource ?? config.specSource) as string | undefined,
    docsUrl: (input.docsUrl ?? config.docsUrl) as string | undefined,
    baseUrl: (input.baseUrl ?? config.baseUrl) as string | undefined,
    username: (input.username ?? config.username) as string | undefined,
    usernameEnv: (input.usernameEnv ?? config.usernameEnv) as string | undefined,
    passwordEnv: (input.passwordEnv ?? config.passwordEnv) as string | undefined,
    tokenEnv: (input.tokenEnv ?? config.tokenEnv) as string | undefined,
    readonly: (input.readonly ?? config.readonly) as boolean | undefined,
    bastionJumps: (input.bastionJumps ?? config.bastionJumps) as string | undefined,
    bastionIdentityFile:
      (input.bastionIdentityFile ?? config.bastionIdentityFile) as string | undefined,
    bastionPasswordAuth:
      (input.bastionPasswordAuth ?? config.bastionPasswordAuth) as boolean | undefined,
    bastionPasswordEnv: (input.bastionPasswordEnv ?? config.bastionPasswordEnv) as string | undefined,
    bastionPasswordsEnv: (input.bastionPasswordsEnv ?? config.bastionPasswordsEnv) as string | undefined,
    bastionTargetHost: (input.bastionTargetHost ?? config.bastionTargetHost) as string | undefined,
    bastionTargetPort: (input.bastionTargetPort ?? config.bastionTargetPort) as number | string | undefined,
    bastionLocalPort: (input.bastionLocalPort ?? config.bastionLocalPort) as number | undefined,
    bastionBindHost: (input.bastionBindHost ?? config.bastionBindHost) as string | undefined,
    bastionStrictHostKeyChecking:
      (input.bastionStrictHostKeyChecking ?? config.bastionStrictHostKeyChecking) as boolean | undefined,
    tlsRejectUnauthorized:
      (input.tlsRejectUnauthorized ?? config.tlsRejectUnauthorized) as string | undefined,
  };
}

function isImplicitAuthEndpoint(servicePrefix = "", routePath = ""): boolean {
  const fullPath = `${servicePrefix}${routePath}`;
  return /\/auth\/token\/(access-token|refresh|client-access-token|system-access-token|extended-system-access-token)$/.test(
    fullPath,
  );
}

async function readInstalledVersions(xcoHome: string): Promise<InstalledVersion[]> {
  const versionsDir = path.join(xcoHome, "versions");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const versions: InstalledVersion[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(versionsDir, entry.name, "manifest.json");
    if (!(await fileExists(manifestPath))) {
      continue;
    }

    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
      versions.push({
        version: (manifest.version as string | undefined) ?? entry.name,
        manifestPath,
        serviceCount: (manifest.services as unknown[] | undefined)?.length ?? 0,
        downloadedAt: (manifest.downloadedAt as string | undefined) ?? null,
      });
    } catch {
      // Ignore malformed cache entries.
    }
  }

  versions.sort((left, right) => left.version.localeCompare(right.version));
  return versions;
}

export class XcoRuntime {
  config: XcoConfig;
  loadOptions: LoadConfigOptions;
  specEntries: SpecEntry[];
  operations: ToolEntry[];
  operationMap: Map<string, ToolEntry>;
  operationIdMap: Map<string, ToolEntry>;
  sessionCache: Map<string, AuthSession | null>;
  tunnels: Map<string, ActiveTunnel>;
  pendingTunnels: Map<string, Promise<ActiveTunnel>>;

  static cleanupInstalled: boolean;
  static instances: Set<XcoRuntime>;

  constructor(config: XcoConfig, loadOptions: LoadConfigOptions = {}) {
    this.config = config;
    this.loadOptions = loadOptions;
    this.specEntries = [];
    this.operations = [];
    this.operationMap = new Map();
    this.operationIdMap = new Map();
    this.sessionCache = new Map();
    this.tunnels = new Map();
    this.pendingTunnels = new Map();
    this.installCleanupHandlers();
  }

  installCleanupHandlers(): void {
    if (XcoRuntime.cleanupInstalled) {
      XcoRuntime.instances.add(this);
      return;
    }

    XcoRuntime.instances = new Set([this]);
    const cleanup = () => {
      for (const instance of XcoRuntime.instances) {
        instance.closeTunnels();
      }
    };

    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
    XcoRuntime.cleanupInstalled = true;
  }

  closeTunnels(): void {
    for (const tunnel of this.tunnels.values()) {
      stopSshTunnel(tunnel, "SIGTERM");
      tunnel.child.stderr?.destroy();
      tunnel.child.unref();
      tunnel.cleanup();
    }
    this.tunnels.clear();
    this.sessionCache.clear();
    XcoRuntime.instances.delete(this);
  }

  async reload(): Promise<this> {
    this.config = await loadConfig(this.loadOptions);
    const loaded = await loadOperations(this.config);
    this.specEntries = loaded.specEntries;
    this.operations = loaded.operations;
    this.operationMap = new Map(
      this.operations.map((item) => [item.name, item]),
    );
    this.operationIdMap = new Map(
      this.operations
        .filter((item) => item.operation.operationId)
        .map((item) => [
          `${item.operation.serviceSlug}:${item.operation.operationId}`,
          item,
        ]),
    );
    return this;
  }

  getTools(): ToolDefinition[] {
    const generatedTools = this.operations
      .filter(
        (operation) =>
          !this.config.readonly ||
          READONLY_METHODS.has(operation.operation.method),
      )
      .map((operation) => ({
        name: operation.name,
        title: operation.title,
        description: operation.description,
        inputSchema: operation.inputSchema,
      }));

    return [...META_TOOLS as ToolDefinition[], ...generatedTools];
  }

  async describeBundle(): Promise<Record<string, unknown>> {
    const installedVersions = await readInstalledVersions(this.config.xcoHome);
    const authStatus = await this.getAuthStatus();
    return {
      activeVersion: this.config.activeVersion,
      specSource: this.config.specSource,
      docsUrl: this.config.docsUrl,
      baseUrl: this.config.baseUrl,
      tokenConfigured: Boolean(resolveToken(this.config)),
      readonly: this.config.readonly,
      bastionJumps: getTunnelSettings(this.config).jumps,
      bastionPasswordAuth: this.config.bastionPasswordAuth,
      bastionPasswordEnvConfigured: Boolean(this.config.bastionPasswordEnv),
      bastionPasswordsEnvConfigured: Boolean(this.config.bastionPasswordsEnv),
      tlsRejectUnauthorized: this.config.tlsRejectUnauthorized,
      auth: authStatus,
      manualSpecsDir: this.config.manualSpecsDir,
      xcoHome: this.config.xcoHome,
      serviceCount: this.specEntries.length,
      operationCount: this.operations.length,
      services: this.specEntries.map((entry) => ({
        serviceSlug: entry.serviceSlug,
        title: entry.title,
        version: entry.version,
        specPath: entry.specPath,
        operationCount: Object.values(entry.spec.paths ?? {}).reduce(
          (count, pathItem) =>
            count +
            Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k))
              .length,
          0,
        ),
      })),
      installedVersions,
    };
  }

  async discoverRemoteVersions(): Promise<string[]> {
    const html = await fetchText(buildSupportDocsUrl("4.0.0"));
    return extractAvailableVersions(html);
  }

  async setupVersion(input: ToolInput, options: RuntimeCallOptions = {}): Promise<Record<string, unknown>> {
    const version = input.version as string;
    if (!version) {
      throw new Error("setupVersion requires a version.");
    }

    const specSource = (input.specSource ?? this.config.specSource) as string;
    const docsUrl =
      specSource === "instance" || specSource === "auto"
        ? this.resolveDocsUrl(input as Record<string, string>)
        : ((input.docsUrl ?? this.config.docsUrl ?? null) as string | null);
    const requestDocsUrl =
      specSource === "instance" || specSource === "auto"
        ? await this.resolveRequestDocsUrl(input as Record<string, string>, options)
        : null;

    const manifest = await downloadVersionBundle(version, {
      xcoHome: this.config.xcoHome,
      overwrite: Boolean(input.overwrite),
      specSource,
      docsUrl,
      requestDocsUrl,
      onEvent: options.onEvent,
    });

    const nextConfig = await saveConfig(this.config, {
      activeVersion:
        input.activate === false ? this.config.activeVersion : version,
      ...buildAuthConfigPatch(input, this.config),
    });

    this.config = nextConfig;
    await this.reload();

    return {
      activeVersion: this.config.activeVersion,
      manifest,
    };
  }

  async useVersion(input: ToolInput): Promise<Record<string, unknown>> {
    if (!input.version) {
      throw new Error("useVersion requires a version.");
    }

    const version = input.version as string;

    const manifestPath = path.join(
      this.config.xcoHome,
      "versions",
      version,
      "manifest.json",
    );
    if (!(await fileExists(manifestPath))) {
      throw new Error(
        `XCO version ${version} is not installed. Run setup first.`,
      );
    }

    this.config = await saveConfig(this.config, {
      activeVersion: version,
      ...buildAuthConfigPatch(input, this.config),
    });

    await this.reload();
    return {
      activeVersion: this.config.activeVersion,
      baseUrl: this.config.baseUrl,
    };
  }

  getOperationById(serviceSlug: string, operationId: string): OperationInfo | null {
    return (
      this.operationIdMap.get(`${serviceSlug}:${operationId}`)?.operation ??
      null
    );
  }

  getAuthOperation(operationId: string): OperationInfo {
    const operation = this.getOperationById("auth", operationId);
    if (!operation) {
      throw new Error(
        `Auth operation ${operationId} is not available for XCO ${this.config.activeVersion ?? "current"} bundle.`,
      );
    }

    return operation;
  }

  resolveBaseUrl(overrides: ToolInput = {}): string | null {
    return (
      (overrides.baseUrl ?? overrides._baseUrl ?? this.config.baseUrl ?? null) as string | null
    );
  }

  resolveDocsUrl(overrides: ToolInput = {}): string | null {
    const configuredDocsUrl = (overrides.docsUrl ?? this.config.docsUrl ?? null) as string | null;
    if (configuredDocsUrl) {
      try {
        return new URL(configuredDocsUrl).toString();
      } catch {
        const baseUrl = this.resolveBaseUrl(overrides);
        if (!baseUrl) {
          throw new Error(
            "docsUrl is relative but no XCO base URL is available to resolve it.",
          );
        }

        return new URL(configuredDocsUrl, baseUrl).toString();
      }
    }

    const baseUrl = this.resolveBaseUrl(overrides);
    if (!baseUrl) {
      return null;
    }

    return new URL("/docs/", baseUrl).toString();
  }

  async resolveRequestBaseUrl(overrides: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<string | null> {
    const baseUrl = this.resolveBaseUrl(overrides);
    if (!baseUrl) {
      return baseUrl;
    }

    if (!hasTunnelConfigured(this.config, overrides)) {
      return baseUrl;
    }

    const settings = getTunnelSettings(this.config, overrides);
    const tunnelKey = buildTunnelKey(baseUrl, settings);
    const existing = this.tunnels.get(tunnelKey);
    if (
      existing &&
      !existing.child.killed &&
      existing.child.exitCode === null
    ) {
      const url = new URL(baseUrl);
      url.hostname = existing.bindHost;
      url.port = String(existing.localPort);
      return url.toString();
    }

    // Serialize concurrent tunnel startups for the same key
    const pendingPromise = this.pendingTunnels.get(tunnelKey);
    if (pendingPromise) {
      const tunnel = await pendingPromise;
      const url = new URL(baseUrl);
      url.hostname = tunnel.bindHost;
      url.port = String(tunnel.localPort);
      return url.toString();
    }

    const onEvent: EventListener = options.onEvent ?? (() => { /* noop */ });
    onEvent({
      level: "info",
      phase: "ssh-tunnel",
      message: `Opening SSH tunnel through ${settings.jumps.join(" -> ")}`,
    });

    const tunnelPromise = startSshTunnel(baseUrl, settings);
    this.pendingTunnels.set(tunnelKey, tunnelPromise);

    try {
      const tunnel = await tunnelPromise;
      this.tunnels.set(tunnelKey, tunnel);

      const url = new URL(baseUrl);
      url.hostname = tunnel.bindHost;
      url.port = String(tunnel.localPort);
      return url.toString();
    } finally {
      this.pendingTunnels.delete(tunnelKey);
    }
  }

  async resolveRequestDocsUrl(overrides: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<string | null> {
    const docsUrl = this.resolveDocsUrl(overrides);
    if (!docsUrl) {
      return null;
    }

    if (!hasTunnelConfigured(this.config, overrides)) {
      return docsUrl;
    }

    const baseUrl = this.resolveBaseUrl(overrides);
    if (!baseUrl) {
      return docsUrl;
    }

    const logicalBase = new URL(baseUrl);
    const logicalDocs = new URL(docsUrl, baseUrl);
    if (logicalDocs.origin !== logicalBase.origin) {
      return logicalDocs.toString();
    }

    const requestBaseUrl = await this.resolveRequestBaseUrl(overrides, options);
    if (!requestBaseUrl) {
      return logicalDocs.toString();
    }

    const requestBase = new URL(requestBaseUrl);
    logicalDocs.protocol = requestBase.protocol;
    logicalDocs.host = requestBase.host;
    return logicalDocs.toString();
  }

  enforceReadonly(operationOrMethod: string | OperationInfo, routePath = ""): void {
    if (!this.config.readonly) {
      return;
    }

    const method =
      typeof operationOrMethod === "string"
        ? operationOrMethod.toUpperCase()
        : operationOrMethod.method;
    if (READONLY_METHODS.has(method)) {
      return;
    }

    const pathLabel =
      typeof operationOrMethod === "string"
        ? routePath
        : `${operationOrMethod.serverPathname}${operationOrMethod.path}`;
    throw new Error(
      `Readonly mode is enabled. ${method} ${pathLabel} is blocked.`,
    );
  }

  async getSessionFor(baseUrl: string | null, username: string | null): Promise<AuthSession | null> {
    if (!baseUrl || !username) {
      return null;
    }

    const key = buildSessionKey({
      version: this.config.activeVersion,
      baseUrl,
      username,
    });

    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key) ?? null;
    }

    const session = await readSession(this.config.sessionPath, key);
    this.sessionCache.set(key, session);
    return session;
  }

  async saveSession(session: AuthSession): Promise<AuthSession> {
    const key = buildSessionKey({
      version: session.version,
      baseUrl: session.baseUrl,
      username: session.username,
    });

    await writeSession(this.config.sessionPath, key, session);
    this.sessionCache.set(key, session);
    return session;
  }

  async clearSession(input: ToolInput = {}): Promise<Record<string, unknown>> {
    const baseUrl = this.resolveBaseUrl(input);
    const username = resolveUsername(this.config, input);
    if (!baseUrl || !username) {
      return {
        cleared: false,
        reason:
          "No baseUrl/username combination is available to identify a cached session.",
      };
    }

    const key = buildSessionKey({
      version: this.config.activeVersion,
      baseUrl,
      username,
    });

    this.sessionCache.delete(key);
    await deleteSession(this.config.sessionPath, key);

    return {
      cleared: true,
      activeVersion: this.config.activeVersion,
      baseUrl,
      username,
    };
  }

  async getAuthStatus(input: ToolInput = {}): Promise<Record<string, unknown>> {
    const baseUrl = this.resolveBaseUrl(input);
    const token = resolveToken(this.config, input);
    const credentials = resolveCredentials(this.config, input);
    const session = await this.getSessionFor(baseUrl, credentials.username);

    return {
      activeVersion: this.config.activeVersion,
      baseUrl,
      tokenConfigured: Boolean(token),
      usernameConfigured: Boolean(credentials.username),
      passwordConfigured: Boolean(credentials.password),
      session: summarizeSession(session),
    };
  }

  async loginWithPassword(input: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<AuthSession> {
    const logicalBaseUrl = this.resolveBaseUrl(input);
    if (!logicalBaseUrl) {
      throw new Error(
        "Missing XCO base URL. Set XCO_BASE_URL, configure it during setup, or pass baseUrl explicitly.",
      );
    }
    const baseUrl = await this.resolveRequestBaseUrl(input, options);

    const credentials = resolveCredentials(this.config, input);
    if (!credentials.username || !credentials.password) {
      throw new Error(
        "Missing XCO username/password. Set XCO_USERNAME and XCO_PASSWORD, configure passwordEnv, or call xco_auth_login with credentials.",
      );
    }

    const onEvent: EventListener = options.onEvent ?? (() => { /* noop */ });
    onEvent({
      level: "info",
      phase: "auth-login",
      message: `Logging in to XCO as ${credentials.username}`,
    });

    const response = await executeOperation(
      this.config,
      null,
      this.getAuthOperation("CreateAccessToken"),
      {
        body: {
          username: credentials.username,
          password: credentials.password,
        },
      },
      {
        baseUrl,
      },
    );

    if (!response.ok) {
      throw new Error(
        `XCO login failed: ${response.status} ${extractErrorMessage(response.body, response.statusText)}`,
      );
    }

    const accessToken = (response.body as Record<string, unknown>)["access-token"] as string | undefined;
    if (!accessToken) {
      throw new Error("XCO login succeeded but no access-token was returned.");
    }

    const body = response.body as Record<string, unknown>;
    return await this.saveSession({
      version: this.config.activeVersion,
      baseUrl: logicalBaseUrl,
      username: credentials.username,
      tokenType: (body["token-type"] as string | undefined) ?? "Bearer",
      accessToken,
      refreshToken: (body["refresh-token"] as string | undefined) ?? null,
      accessTokenExpiresAt: getTokenExpiresAt(accessToken),
      message: (body.message as string | undefined) ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  async refreshSession(input: ToolInput = {}, existingSession: AuthSession | null = null, options: RuntimeCallOptions = {}): Promise<AuthSession> {
    const logicalBaseUrl = this.resolveBaseUrl(input);
    const baseUrl = await this.resolveRequestBaseUrl(input, options);
    const credentials = resolveCredentials(this.config, input);
    const session =
      existingSession ??
      (await this.getSessionFor(logicalBaseUrl, credentials.username));

    if (!session?.refreshToken) {
      throw new Error("No cached refresh token is available.");
    }

    const onEvent: EventListener = options.onEvent ?? (() => { /* noop */ });
    onEvent({
      level: "info",
      phase: "auth-refresh",
      message: `Refreshing XCO access token for ${session.username}`,
    });

    const response = await executeOperation(
      this.config,
      null,
      this.getAuthOperation("RefreshAccessToken"),
      {
        body: {
          "grant-type": "refresh_token",
          "refresh-token": session.refreshToken,
        },
      },
      {
        baseUrl,
      },
    );

    if (!response.ok) {
      throw new Error(
        `XCO token refresh failed: ${response.status} ${extractErrorMessage(response.body, response.statusText)}`,
      );
    }

    const accessToken = (response.body as Record<string, unknown>)["access-token"] as string | undefined;
    if (!accessToken) {
      throw new Error(
        "XCO refresh succeeded but no access-token was returned.",
      );
    }

    const body = response.body as Record<string, unknown>;
    return await this.saveSession({
      ...session,
      tokenType: (body["token-type"] as string | undefined) ?? session.tokenType,
      accessToken,
      refreshToken:
        (body["refresh-token"] as string | undefined) ?? session.refreshToken,
      accessTokenExpiresAt: getTokenExpiresAt(accessToken),
      message: (body.message as string | undefined) ?? session.message,
      updatedAt: new Date().toISOString(),
    });
  }

  async ensureAuthSession(input: ToolInput = {}, options: RuntimeCallOptions & { forceRenew?: boolean } = {}): Promise<AuthSession> {
    const baseUrl = this.resolveBaseUrl(input);
    if (!baseUrl) {
      throw new Error(
        "Missing XCO base URL. Set XCO_BASE_URL, configure it during setup, or pass baseUrl explicitly.",
      );
    }

    const credentials = resolveCredentials(this.config, input);
    const session = await this.getSessionFor(baseUrl, credentials.username);

    if (
      !options.forceRenew &&
      session?.accessToken &&
      !isExpired(session.accessTokenExpiresAt)
    ) {
      return session;
    }

    if (session?.refreshToken) {
      try {
        return await this.refreshSession(input, session, options);
      } catch (error) {
        if (!credentials.username || !credentials.password) {
          throw error;
        }
      }
    }

    return await this.loginWithPassword(input, options);
  }

  async getAuthHeaderToken(input: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<AuthHeaderToken> {
    const explicitToken = resolveToken(this.config, input);
    if (explicitToken) {
      return {
        token: explicitToken,
        source: "static",
        retryable: false,
      };
    }

    const session = await this.ensureAuthSession(input, options);
    return {
      token: session.accessToken,
      source: "session",
      retryable: true,
    };
  }

  async callGeneratedTool(name: string, input: ToolInput, options: RuntimeCallOptions = {}): Promise<XcoResponse> {
    const entry = this.operationMap.get(name);
    if (!entry) {
      throw new Error(`Unknown tool "${name}".`);
    }

    this.enforceReadonly(entry.operation);

    let token: string | null;
    let retryable = false;
    if (entry.operation.requiresAuth) {
      const authState = await this.getAuthHeaderToken(input, options);
      token = authState.token;
      retryable = authState.retryable;
    } else {
      token = resolveToken(this.config, input);
    }

    const requestBaseUrl = await this.resolveRequestBaseUrl(
      input,
      options,
    );
    let response = await executeOperation(
      this.config,
      token,
      entry.operation,
      input,
      {
        baseUrl: requestBaseUrl,
        onEvent: options.onEvent,
      },
    );

    if (entry.operation.requiresAuth && response.status === 401 && retryable) {
      const session = await this.ensureAuthSession(input, {
        ...options,
        forceRenew: true,
      });

      response = await executeOperation(
        this.config,
        session.accessToken,
        entry.operation,
        input,
        {
          baseUrl: requestBaseUrl,
          onEvent: options.onEvent,
        },
      );
    }

    return response;
  }

  async callMetaTool(name: string, input: ToolInput, options: RuntimeCallOptions = {}): Promise<unknown> {
    input = normalizeKeys(input as Record<string, unknown>) as ToolInput;

    if (name === "xco_setup_version") {
      return await this.setupVersion(input, options);
    }

    if (name === "xco_use_version") {
      return await this.useVersion(input);
    }

    if (name === "xco_auth_login") {
      this.config = {
        ...this.config,
        baseUrl: (input.baseUrl as string | undefined) ?? this.config.baseUrl,
        username: (input.username as string | undefined) ?? this.config.username,
        usernameEnv: (input.usernameEnv as string | undefined) ?? this.config.usernameEnv,
        password: (input.password as string | undefined) ?? this.config.password,
        passwordEnv: (input.passwordEnv as string | undefined) ?? this.config.passwordEnv,
      };

      const session = await this.loginWithPassword(input, options);
      if (input.persistConfig) {
        this.config = await saveConfig(
          this.config,
          buildAuthConfigPatch(input, this.config),
        );
      }

      return {
        activeVersion: this.config.activeVersion,
        auth: await this.getAuthStatus(input),
        session: summarizeSession(session),
      };
    }

    if (name === "xco_auth_status") {
      return await this.getAuthStatus(input);
    }

    if (name === "xco_auth_logout") {
      return await this.clearSession(input);
    }

    if (name === "xco_list_versions") {
      return {
        activeVersion: this.config.activeVersion,
        installed: await readInstalledVersions(this.config.xcoHome),
        remote: input.remote ? await this.discoverRemoteVersions() : undefined,
      };
    }

    if (name === "xco_describe_bundle") {
      return await this.describeBundle();
    }

    if (name === "xco_raw_request") {
      const fullPath = `${(input.servicePrefix as string | undefined) ?? ""}${(input.path as string | undefined) ?? ""}`;
      const authenticate: boolean =
        (input.authenticate as boolean | undefined) ?? !isImplicitAuthEndpoint("", fullPath);
      this.enforceReadonly((input.method as string | undefined) ?? "GET", fullPath);
      let token: string | null = resolveToken(this.config, input);
      let retryable = false;

      if (!token && authenticate) {
        const authState = await this.getAuthHeaderToken(input, options);
        token = authState.token;
        retryable = authState.retryable;
      }

      const requestBaseUrl = await this.resolveRequestBaseUrl(
        input,
        options,
      );
      let response = await executeRawRequest(this.config, token, {
        ...input,
        baseUrl: requestBaseUrl,
      });
      if (authenticate && response.status === 401 && retryable) {
        const session = await this.ensureAuthSession(input, {
          ...options,
          forceRenew: true,
        });
        response = await executeRawRequest(this.config, session.accessToken, {
          ...input,
          baseUrl: requestBaseUrl,
        });
      }

      return response;
    }

    throw new Error(`Unknown meta tool "${name}".`);
  }

  async callTool(name: string, input: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<unknown> {
    const onEvent: EventListener = options.onEvent ?? (() => { /* noop */ });
    onEvent({
      level: "info",
      phase: "call-start",
      tool: name,
      message: `Calling ${name}`,
    });

    try {
      const result = META_TOOL_NAMES.has(name)
        ? await this.callMetaTool(name, input, options)
        : await this.callGeneratedTool(name, input, options);

      onEvent({
        level: "info",
        phase: "call-complete",
        tool: name,
        message: `Completed ${name}`,
      });

      return result;
    } catch (error) {
      onEvent({
        level: "error",
        phase: "call-error",
        tool: name,
        message: (error as Error).message,
      });
      throw error;
    }
  }

  async callToolForMcp(name: string, input: ToolInput = {}, options: RuntimeCallOptions = {}): Promise<ToolResult> {
    try {
      const result = await this.callTool(name, input, options);
      return asToolResult(result);
    } catch (error) {
      return asToolResult(
        {
          error: (error as Error).message,
        },
        { isError: true },
      );
    }
  }
}

XcoRuntime.cleanupInstalled = false;
XcoRuntime.instances = new Set<XcoRuntime>();

export async function createRuntime(options: LoadConfigOptions = {}): Promise<XcoRuntime> {
  const config = await loadConfig(options);

  // Apply TLS certificate validation setting
  if (config.tlsRejectUnauthorized !== null) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED =
      config.tlsRejectUnauthorized;
  }

  const runtime = new XcoRuntime(config, options);
  await runtime.reload();
  return runtime;
}
