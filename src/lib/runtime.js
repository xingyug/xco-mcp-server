import fs from "node:fs/promises";
import path from "node:path";

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
import { buildSupportDocsUrl, fileExists, HTTP_METHODS } from "./utils.js";

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

function asToolResult(result, options = {}) {
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

function extractErrorMessage(body, fallback = "Request failed.") {
  if (!body) {
    return fallback;
  }

  if (typeof body === "string") {
    return body;
  }

  if (typeof body.message === "string") {
    return body.message;
  }

  if (typeof body.error === "string") {
    return body.error;
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors
      .map((item) => item?.message ?? JSON.stringify(item))
      .join("; ");
  }

  if (typeof body.code !== "undefined" || typeof body.message !== "undefined") {
    return JSON.stringify(body);
  }

  return fallback;
}

function buildAuthConfigPatch(input = {}, config = {}) {
  return {
    specSource: input.specSource ?? config.specSource,
    docsUrl: input.docsUrl ?? config.docsUrl,
    baseUrl: input.baseUrl ?? config.baseUrl,
    username: input.username ?? config.username,
    usernameEnv: input.usernameEnv ?? config.usernameEnv,
    passwordEnv: input.passwordEnv ?? config.passwordEnv,
    tokenEnv: input.tokenEnv ?? config.tokenEnv,
    readonly: input.readonly ?? config.readonly,
    bastionJumps: input.bastionJumps ?? config.bastionJumps,
    bastionIdentityFile:
      input.bastionIdentityFile ?? config.bastionIdentityFile,
    bastionPasswordAuth:
      input.bastionPasswordAuth ?? config.bastionPasswordAuth,
    bastionPasswordEnv: input.bastionPasswordEnv ?? config.bastionPasswordEnv,
    bastionTargetHost: input.bastionTargetHost ?? config.bastionTargetHost,
    bastionTargetPort: input.bastionTargetPort ?? config.bastionTargetPort,
    bastionLocalPort: input.bastionLocalPort ?? config.bastionLocalPort,
    bastionBindHost: input.bastionBindHost ?? config.bastionBindHost,
    bastionStrictHostKeyChecking:
      input.bastionStrictHostKeyChecking ?? config.bastionStrictHostKeyChecking,
  };
}

function isImplicitAuthEndpoint(servicePrefix = "", routePath = "") {
  const fullPath = `${servicePrefix ?? ""}${routePath ?? ""}`;
  return /\/auth\/token\/(access-token|refresh|client-access-token|system-access-token|extended-system-access-token)$/.test(
    fullPath,
  );
}

async function readInstalledVersions(xcoHome) {
  const versionsDir = path.join(xcoHome, "versions");
  let entries = [];
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(versionsDir, entry.name, "manifest.json");
    if (!(await fileExists(manifestPath))) {
      continue;
    }

    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      versions.push({
        version: manifest.version ?? entry.name,
        manifestPath,
        serviceCount: manifest.services?.length ?? 0,
        downloadedAt: manifest.downloadedAt ?? null,
      });
    } catch {
      // Ignore malformed cache entries.
    }
  }

  versions.sort((left, right) => left.version.localeCompare(right.version));
  return versions;
}

export class XcoRuntime {
  constructor(config, loadOptions = {}) {
    this.config = config;
    this.loadOptions = loadOptions;
    this.specEntries = [];
    this.operations = [];
    this.operationMap = new Map();
    this.operationIdMap = new Map();
    this.sessionCache = new Map();
    this.tunnels = new Map();
    this.installCleanupHandlers();
  }

  installCleanupHandlers() {
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

  closeTunnels() {
    for (const tunnel of this.tunnels.values()) {
      stopSshTunnel(tunnel, "SIGTERM");
      tunnel.child.stderr?.destroy();
      tunnel.child.unref();
      tunnel.cleanup?.();
    }
    this.tunnels.clear();
    this.sessionCache.clear();
    XcoRuntime.instances.delete(this);
  }

  async reload() {
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

  getTools() {
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

    return [...META_TOOLS, ...generatedTools];
  }

  async describeBundle() {
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
      bastionPasswordAuth: Boolean(this.config.bastionPasswordAuth),
      bastionPasswordEnvConfigured: Boolean(this.config.bastionPasswordEnv),
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
            Object.keys(pathItem ?? {}).filter((k) => HTTP_METHODS.has(k))
              .length,
          0,
        ),
      })),
      installedVersions,
    };
  }

  async discoverRemoteVersions() {
    const html = await fetchText(buildSupportDocsUrl("4.0.0"));
    return extractAvailableVersions(html);
  }

  async setupVersion(input, options = {}) {
    const version = input.version;
    if (!version) {
      throw new Error("setupVersion requires a version.");
    }

    const specSource = input.specSource ?? this.config.specSource ?? "official";
    const docsUrl =
      specSource === "instance" || specSource === "auto"
        ? this.resolveDocsUrl(input)
        : (input.docsUrl ?? this.config.docsUrl ?? null);
    const requestDocsUrl =
      specSource === "instance" || specSource === "auto"
        ? await this.resolveRequestDocsUrl(input, options)
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

  async useVersion(input) {
    if (!input.version) {
      throw new Error("useVersion requires a version.");
    }

    const manifestPath = path.join(
      this.config.xcoHome,
      "versions",
      input.version,
      "manifest.json",
    );
    if (!(await fileExists(manifestPath))) {
      throw new Error(
        `XCO version ${input.version} is not installed. Run setup first.`,
      );
    }

    this.config = await saveConfig(this.config, {
      activeVersion: input.version,
      ...buildAuthConfigPatch(input, this.config),
    });

    await this.reload();
    return {
      activeVersion: this.config.activeVersion,
      baseUrl: this.config.baseUrl,
    };
  }

  getOperationById(serviceSlug, operationId) {
    return (
      this.operationIdMap.get(`${serviceSlug}:${operationId}`)?.operation ??
      null
    );
  }

  getAuthOperation(operationId) {
    const operation = this.getOperationById("auth", operationId);
    if (!operation) {
      throw new Error(
        `Auth operation ${operationId} is not available for XCO ${this.config.activeVersion ?? "current"} bundle.`,
      );
    }

    return operation;
  }

  resolveBaseUrl(overrides = {}) {
    return (
      overrides.baseUrl ?? overrides._baseUrl ?? this.config.baseUrl ?? null
    );
  }

  resolveDocsUrl(overrides = {}) {
    const configuredDocsUrl = overrides.docsUrl ?? this.config.docsUrl ?? null;
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

  async resolveRequestBaseUrl(overrides = {}, options = {}) {
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

    const onEvent = options.onEvent ?? (() => {});
    onEvent({
      level: "info",
      phase: "ssh-tunnel",
      message: `Opening SSH tunnel through ${settings.jumps.join(" -> ")}`,
    });

    const tunnel = await startSshTunnel(baseUrl, settings);
    this.tunnels.set(tunnelKey, tunnel);

    const url = new URL(baseUrl);
    url.hostname = tunnel.bindHost;
    url.port = String(tunnel.localPort);
    return url.toString();
  }

  async resolveRequestDocsUrl(overrides = {}, options = {}) {
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

  enforceReadonly(operationOrMethod, routePath = "") {
    if (!this.config.readonly) {
      return;
    }

    const method =
      typeof operationOrMethod === "string"
        ? String(operationOrMethod).toUpperCase()
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

  async getSessionFor(baseUrl, username) {
    if (!baseUrl || !username) {
      return null;
    }

    const key = buildSessionKey({
      version: this.config.activeVersion,
      baseUrl,
      username,
    });

    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key);
    }

    const session = await readSession(this.config.sessionPath, key);
    this.sessionCache.set(key, session);
    return session;
  }

  async saveSession(session) {
    const key = buildSessionKey({
      version: session.version,
      baseUrl: session.baseUrl,
      username: session.username,
    });

    this.sessionCache.set(key, session);
    await writeSession(this.config.sessionPath, key, session);
    return session;
  }

  async clearSession(input = {}) {
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

  async getAuthStatus(input = {}) {
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

  async loginWithPassword(input = {}, options = {}) {
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

    const onEvent = options.onEvent ?? (() => {});
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

    const accessToken = response.body?.["access-token"];
    if (!accessToken) {
      throw new Error("XCO login succeeded but no access-token was returned.");
    }

    return await this.saveSession({
      version: this.config.activeVersion,
      baseUrl: logicalBaseUrl,
      username: credentials.username,
      tokenType: response.body?.["token-type"] ?? "Bearer",
      accessToken,
      refreshToken: response.body?.["refresh-token"] ?? null,
      accessTokenExpiresAt: getTokenExpiresAt(accessToken),
      message: response.body?.message ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  async refreshSession(input = {}, existingSession = null, options = {}) {
    const logicalBaseUrl = this.resolveBaseUrl(input);
    const baseUrl = await this.resolveRequestBaseUrl(input, options);
    const credentials = resolveCredentials(this.config, input);
    const session =
      existingSession ??
      (await this.getSessionFor(logicalBaseUrl, credentials.username));

    if (!session?.refreshToken) {
      throw new Error("No cached refresh token is available.");
    }

    const onEvent = options.onEvent ?? (() => {});
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

    const accessToken = response.body?.["access-token"];
    if (!accessToken) {
      throw new Error(
        "XCO refresh succeeded but no access-token was returned.",
      );
    }

    return await this.saveSession({
      ...session,
      tokenType: response.body?.["token-type"] ?? session.tokenType ?? "Bearer",
      accessToken,
      refreshToken:
        response.body?.["refresh-token"] ?? session.refreshToken ?? null,
      accessTokenExpiresAt: getTokenExpiresAt(accessToken),
      message: response.body?.message ?? session.message ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  async ensureAuthSession(input = {}, options = {}) {
    const baseUrl = this.resolveBaseUrl(input);
    if (!baseUrl) {
      throw new Error(
        "Missing XCO base URL. Set XCO_BASE_URL, configure it during setup, or pass baseUrl explicitly.",
      );
    }

    const credentials = resolveCredentials(this.config, input);
    let session = await this.getSessionFor(baseUrl, credentials.username);

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

  async getAuthHeaderToken(input = {}, options = {}) {
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

  async callGeneratedTool(name, input, options = {}) {
    const entry = this.operationMap.get(name);
    if (!entry) {
      throw new Error(`Unknown tool "${name}".`);
    }

    this.enforceReadonly(entry.operation);

    let token = null;
    let retryable = false;
    if (entry.operation.requiresAuth) {
      const authState = await this.getAuthHeaderToken(input ?? {}, options);
      token = authState.token;
      retryable = authState.retryable;
    } else {
      token = resolveToken(this.config, input ?? {});
    }

    const requestBaseUrl = await this.resolveRequestBaseUrl(
      input ?? {},
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
      const session = await this.ensureAuthSession(input ?? {}, {
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

  async callMetaTool(name, input, options = {}) {
    if (name === "xco_setup_version") {
      return await this.setupVersion(input ?? {}, options);
    }

    if (name === "xco_use_version") {
      return await this.useVersion(input ?? {});
    }

    if (name === "xco_auth_login") {
      this.config = {
        ...this.config,
        baseUrl: input?.baseUrl ?? this.config.baseUrl,
        username: input?.username ?? this.config.username,
        usernameEnv: input?.usernameEnv ?? this.config.usernameEnv,
        password: input?.password ?? this.config.password,
        passwordEnv: input?.passwordEnv ?? this.config.passwordEnv,
      };

      const session = await this.loginWithPassword(input ?? {}, options);
      if (input?.persistConfig) {
        this.config = await saveConfig(
          this.config,
          buildAuthConfigPatch(input, this.config),
        );
      }

      return {
        activeVersion: this.config.activeVersion,
        auth: await this.getAuthStatus(input ?? {}),
        session: summarizeSession(session),
      };
    }

    if (name === "xco_auth_status") {
      return await this.getAuthStatus(input ?? {});
    }

    if (name === "xco_auth_logout") {
      return await this.clearSession(input ?? {});
    }

    if (name === "xco_list_versions") {
      return {
        activeVersion: this.config.activeVersion,
        installed: await readInstalledVersions(this.config.xcoHome),
        remote: input?.remote ? await this.discoverRemoteVersions() : undefined,
      };
    }

    if (name === "xco_describe_bundle") {
      return await this.describeBundle();
    }

    if (name === "xco_raw_request") {
      const fullPath = `${input?.servicePrefix ?? ""}${input?.path ?? ""}`;
      const authenticate =
        input?.authenticate ?? !isImplicitAuthEndpoint("", fullPath);
      this.enforceReadonly(input?.method ?? "GET", fullPath);
      let token = resolveToken(this.config, input ?? {});
      let retryable = false;

      if (!token && authenticate) {
        const authState = await this.getAuthHeaderToken(input ?? {}, options);
        token = authState.token;
        retryable = authState.retryable;
      }

      const requestBaseUrl = await this.resolveRequestBaseUrl(
        input ?? {},
        options,
      );
      let response = await executeRawRequest(this.config, token, {
        ...(input ?? {}),
        baseUrl: requestBaseUrl,
      });
      if (authenticate && response.status === 401 && retryable) {
        const session = await this.ensureAuthSession(input ?? {}, {
          ...options,
          forceRenew: true,
        });
        response = await executeRawRequest(this.config, session.accessToken, {
          ...(input ?? {}),
          baseUrl: requestBaseUrl,
        });
      }

      return response;
    }

    throw new Error(`Unknown meta tool "${name}".`);
  }

  async callTool(name, input = {}, options = {}) {
    const onEvent = options.onEvent ?? (() => {});
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
        message: error.message,
      });
      throw error;
    }
  }

  async callToolForMcp(name, input = {}, options = {}) {
    try {
      const result = await this.callTool(name, input, options);
      return asToolResult(result);
    } catch (error) {
      return asToolResult(
        {
          error: error.message,
        },
        { isError: true },
      );
    }
  }
}

XcoRuntime.cleanupInstalled = false;
XcoRuntime.instances = new Set();

export async function createRuntime(options = {}) {
  const config = await loadConfig(options);
  const runtime = new XcoRuntime(config, options);
  await runtime.reload();
  return runtime;
}
