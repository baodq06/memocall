# Builds and runs the memocall MCP server over stdio.
# Used by Glama (and anyone) to start the server and answer MCP introspection.
FROM node:22-alpine

WORKDIR /app

# Install dependencies (incl. dev deps needed to compile TypeScript)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Build
COPY src ./src
RUN npm run build

# The server speaks MCP over stdio; clients pipe JSON-RPC to stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
