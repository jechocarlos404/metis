FROM node:22-alpine AS build
WORKDIR /app

# Optional: drop extra-ca.crt next to this Dockerfile to trust a corporate/
# TLS-intercepting proxy during the build. No-op when the file is absent.
COPY package.json package-lock.json extra-ca*.crt ./
RUN if [ -f extra-ca.crt ]; then npm config set cafile /app/extra-ca.crt; fi
RUN npm ci

COPY astro.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=4321 NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
