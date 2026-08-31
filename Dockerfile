# The drigodb control-plane API.
FROM node:22-alpine AS build
WORKDIR /app
# The lockfile comes along and `npm ci` installs exactly it. `npm install`
# resolves ranges afresh on every build, so two builds of the same commit could
# differ — which is precisely what a release pipeline must not allow.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# The version this image reports on /healthz. CI passes the version it is
# releasing; a local build says "dev", which is the honest answer for one.
ARG DRIGODB_VERSION=dev
ENV DRIGODB_VERSION=${DRIGODB_VERSION}

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Runs unprivileged; it needs the Kubernetes API, not the host.
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
