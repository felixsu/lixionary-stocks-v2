# Multi-stage build for the Next.js frontend (standalone output).

FROM node:22-slim AS deps
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /srv
RUN corepack enable
COPY --from=deps /srv/node_modules ./node_modules
COPY . .
# Next.js serializes next.config (including the /api rewrite target) at BUILD
# time, so the proxy destination must be provided here, not at runtime.
ARG API_INTERNAL_URL=http://api:8850
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm build

FROM node:22-slim AS run
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /srv/.next/standalone ./
COPY --from=build /srv/.next/static ./.next/static
COPY --from=build /srv/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
