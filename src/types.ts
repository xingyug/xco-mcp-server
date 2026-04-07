/**
 * Shared TypeScript interfaces for the xco-mcp-server project.
 */

import type { ChildProcess } from "node:child_process";

/* ---- Event Bus ---- */

export interface XcoEvent {
  level?: string;
  phase?: string;
  message?: string;
  type?: string;
  tool?: string;
  version?: string;
  service?: string;
  url?: string;
  jobId?: string;
  at?: string;
  [key: string]: unknown;
}

export type EventListener = (event: Record<string, unknown>) => void;

export interface EventBus {
  emit(event: Record<string, unknown>): void;
  subscribe(listener: EventListener): () => void;
}

/* ---- Config ---- */

export interface LoadConfigOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface XcoConfig {
  cwd: string;
  xcoHome: string;
  configPath: string;
  sessionPath: string;
  manualSpecsDir: string;
  activeVersion: string | null;
  specSource: string;
  docsUrl: string | null;
  baseUrl: string | null;
  token: string | null;
  tokenEnv: string | null;
  username: string | null;
  usernameEnv: string | null;
  password: string | null;
  passwordEnv: string | null;
  readonly: boolean;
  bastionJumps: string | null;
  bastionIdentityFile: string | null;
  bastionPassword: string | null;
  bastionPasswordEnv: string | null;
  bastionPasswords: string | null;
  bastionPasswordsEnv: string | null;
  bastionPasswordAuth: boolean;
  bastionTargetHost: string | null;
  bastionTargetPort: number | null;
  bastionLocalPort: number | null;
  bastionBindHost: string | null;
  bastionStrictHostKeyChecking: boolean | null;
  tlsRejectUnauthorized: string | null;
}

export interface ConfigOverrides {
  token?: string;
  tokenEnv?: string;
  username?: string;
  usernameEnv?: string;
  password?: string;
  passwordEnv?: string;
  baseUrl?: string;
  _baseUrl?: string;
  docsUrl?: string;
  specSource?: string;
  readonly?: boolean;
  bastionJumps?: string;
  bastionIdentityFile?: string;
  bastionPassword?: string;
  bastionPasswordEnv?: string;
  bastionPasswords?: string;
  bastionPasswordsEnv?: string;
  bastionPasswordAuth?: boolean | string;
  bastionTargetHost?: string;
  bastionTargetPort?: number | string;
  bastionLocalPort?: number | string;
  bastionBindHost?: string;
  bastionStrictHostKeyChecking?: boolean | string;
  tlsRejectUnauthorized?: string;
  [key: string]: unknown;
}

/* ---- Auth ---- */

export interface AuthSession {
  version: string | null;
  baseUrl: string;
  username: string;
  tokenType: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  message: string | null;
  updatedAt: string;
}

export interface SessionStore {
  sessions: Record<string, AuthSession>;
}

export interface SessionSummary {
  cached: boolean;
  username?: string | null;
  baseUrl?: string | null;
  version?: string | null;
  tokenType?: string | null;
  hasAccessToken?: boolean;
  hasRefreshToken?: boolean;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: string | null;
  updatedAt?: string | null;
}

/* ---- Tunnel ---- */

export interface ResolvedPasswords {
  passwords: string[];
  explicit: boolean;
}

export interface TunnelSettings {
  jumps: string[];
  identityFile: string | null;
  passwordAuth: boolean;
  password: string | null;
  passwords: string[];
  explicitMultiPassword: boolean;
  passwordEnv: string | null;
  targetHost: string | null;
  targetPort: number | string | null;
  localPort: number | null;
  bindHost: string;
  strictHostKeyChecking: boolean | null;
}

export interface TunnelSpec {
  finalHop: string | undefined;
  proxyJump: string | null;
  targetHost: string;
  targetPort: number;
  bindHost: string;
  localPort: number | null;
  identityFile: string | null;
  passwordAuth: boolean;
  strictHostKeyChecking: boolean | null;
}

export interface TunnelCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  spec: TunnelSpec;
}

export interface AskpassHelper {
  path: string;
  env: Record<string, string>;
  cleanup(): void;
}

export interface ActiveTunnel {
  child: ChildProcess;
  localPort: number | null;
  bindHost: string;
  logicalBaseUrl: string;
  targetHost: string;
  targetPort: number;
  cleanup(): void;
}

/* ---- OpenAPI / Operations ---- */

export interface OperationParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  $ref?: string;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  example?: unknown;
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface OperationInfo {
  serviceSlug: string;
  serviceTitle: string;
  serviceDocUrl: string | null;
  serviceVersion: string | null;
  serverPathname: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  tags: string[];
  requiresAuth: boolean;
  parameters: OperationParameter[];
  requestContentType: string | null;
  requestBodyRequired: boolean;
  requestBodySchema: JsonSchema | null;
  rawOperation: Record<string, unknown>;
}

export interface ToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationInfo;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface SpecEntry {
  serviceSlug: string;
  title: string;
  version: string | null;
  specPath: string;
  spec: OpenApiDocument;
  docUrl: string | null;
}

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
    [key: string]: unknown;
  };
  servers?: Array<{ url?: string; [key: string]: unknown }>;
  paths?: Record<string, PathItem>;
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export interface PathItem {
  parameters?: OperationParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
  [key: string]: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OperationParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export type SecurityRequirement = Record<string, string[]>;

/* ---- Downloader ---- */

export interface ServiceReference {
  title: string;
  docUrl: string;
  fetchUrl?: string;
  serviceSlug: string;
  embeddedSpec?: OpenApiDocument;
}

export interface ManifestService {
  title: string;
  serviceSlug: string;
  docUrl: string;
  specFile: string;
  specTitle: string | null;
  specVersion: string | null;
  operationCount: number;
  reused?: boolean;
}

export interface Manifest {
  version: string;
  requestedSpecSource: string;
  resolvedSpecSource: string;
  resolvedDocsVersion: string;
  sourceIndexUrl: string;
  sourceFetchUrl: string;
  downloadedAt: string;
  services: ManifestService[];
}

export interface DownloadOptions {
  xcoHome?: string;
  overwrite?: boolean;
  onEvent?: EventListener;
  specSource?: string;
  docsUrl?: string | null;
  requestDocsUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

export interface FetchTextOptions {
  fetchImpl?: typeof globalThis.fetch;
}

/* ---- XCO Client ---- */

export interface XcoResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | string | null;
}

export interface RawRequestInput {
  method?: string;
  servicePrefix?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrl?: string | null;
  [key: string]: unknown;
}

/* ---- MCP Dispatch ---- */

export interface McpDispatch {
  dispatch(method: string, params: Record<string, unknown> | undefined): Promise<unknown>;
}

/* ---- MCP Messages ---- */

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/* ---- MCP HTTP Transport ---- */

export interface McpSession {
  id: string;
  initialized: boolean;
}

/* ---- Runtime ---- */

export interface ToolResult {
  isError: boolean;
  structuredContent: unknown;
  content: Array<{ type: string; text: string }>;
}

export interface AuthHeaderToken {
  token: string;
  source: string;
  retryable: boolean;
}

export interface InstalledVersion {
  version: string;
  manifestPath: string;
  serviceCount: number;
  downloadedAt: string | null;
}

export interface RuntimeCallOptions {
  onEvent?: EventListener;
  forceRenew?: boolean;
}

export interface SetupInput extends ConfigOverrides {
  version: string;
  overwrite?: boolean;
  activate?: boolean;
}

export interface UseVersionInput extends ConfigOverrides {
  version: string;
}

export interface LoginInput extends ConfigOverrides {
  persistConfig?: boolean;
}

export interface AuthStatusInput {
  baseUrl?: string;
  username?: string;
  [key: string]: unknown;
}
