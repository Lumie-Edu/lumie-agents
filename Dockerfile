FROM node:22-alpine AS builder

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install webview-ui dependencies
COPY webview-ui/package.json webview-ui/package-lock.json ./webview-ui/
RUN cd webview-ui && npm ci

# Copy source
COPY shared/ ./shared/
COPY webview-ui/ ./webview-ui/
COPY server/ ./server/
COPY tsconfig.json ./

# Build webview-ui (outputs to dist/webview/)
RUN cd webview-ui && npm run build

FROM node:22-alpine

WORKDIR /app

# Copy built webview and server source
COPY --from=builder /app/dist/webview/ ./dist/webview/
COPY --from=builder /app/server/ ./server/
COPY --from=builder /app/shared/ ./shared/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3000
# HOME will be overridden by the pod spec to match the shared volume
EXPOSE 3000

CMD ["npx", "tsx", "server/index.ts"]
