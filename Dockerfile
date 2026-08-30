# The drigodb control-plane API.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Runs unprivileged; it needs the Kubernetes API, not the host.
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
