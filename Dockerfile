# syntax=docker/dockerfile:1
#
# mortgage-calc — a static page bundled with Vite and served by nginx. The source
# (index.html + src/) is split into ES modules and a stylesheet; the build stage
# runs `vite build` to produce minified, content-hashed assets under dist/, which
# the runtime stage bakes into the nginx image. There is no backend and no state.
# The listen port is driven by MORTGAGE_CALC_PORT through nginx's official
# envsubst-on-templates entrypoint, so the compose stack and the container agree on
# one port from one source (matches how the Go stacks take their port from env).

# ---- build stage: bundle + minify the static assets with Vite ----
FROM node:22-alpine AS build
WORKDIR /app
# Install deps first so this layer caches unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci
# Then the source, and build -> /app/dist.
COPY . .
RUN npm run build

# ---- runtime stage: serve the built dist/ with nginx ----
FROM nginx:1.27-alpine AS runtime

# NGINX_ENVSUBST_FILTER restricts substitution to OUR vars (names containing
# MORTGAGE_CALC), so nginx runtime vars like $uri in the template are left intact
# even though they share the $-syntax. MORTGAGE_CALC_PORT is the default the
# compose stack overrides via config.env.
ENV NGINX_ENVSUBST_FILTER=MORTGAGE_CALC \
    MORTGAGE_CALC_PORT=8080

# Rendered to /etc/nginx/conf.d/default.conf at container start by the stock
# entrypoint (20-envsubst-on-templates.sh), replacing nginx's default server.
COPY default.conf.template /etc/nginx/templates/default.conf.template
# The bundled, minified, content-hashed assets from the build stage.
COPY --from=build /app/dist /usr/share/nginx/html

# Documentation only (EXPOSE can't read the env var); the real port comes from
# MORTGAGE_CALC_PORT and the compose `expose:`.
EXPOSE 8080

# Liveness: /health is a static 200 from nginx (see the template). busybox `wget`
# ships in nginx:alpine. Shell form so MORTGAGE_CALC_PORT expands at runtime.
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null "http://localhost:${MORTGAGE_CALC_PORT}/health" || exit 1

ARG VERSION=dev
LABEL org.opencontainers.image.title="mortgage-calc" \
      org.opencontainers.image.description="borrowing-power / mortgage servicing calculator (static page)" \
      org.opencontainers.image.source="https://github.com/JeremyVun/mortgage-calc" \
      org.opencontainers.image.version="${VERSION}"
