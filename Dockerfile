FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/xingyug/xco-mcp-server" \
      org.opencontainers.image.description="MCP/CLI/HTTP server for ExtremeCloud Orchestrator" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and bundled specs
COPY src/ src/
COPY specs/ specs/
COPY LICENSE NOTICE README.md ./

# Non-root user for security
RUN addgroup -S xco && adduser -S xco -G xco && chown -R xco:xco /app
USER xco

# Default to HTTP server (serves REST API + MCP Streamable HTTP on /mcp)
# Override XCO_HTTP_HOST to 0.0.0.0 so the container accepts external connections
ENV XCO_HTTP_HOST=0.0.0.0
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["node"]
CMD ["src/http-server.js"]
