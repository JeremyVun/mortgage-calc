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

# ---- brotli stage: compile ngx_brotli as a dynamic module ----
# Built FROM the SAME nginx image as the runtime so the module ABI matches, and
# configured --with-compat so the stock nginx binary can load the resulting .so.
# The nginx version is read from this very image (nginx -v) so the source we build
# against can never drift from the binary that loads it. Only the *_static module
# is kept — we serve precompressed files, so the on-the-fly filter isn't needed.
FROM nginx:1.27-alpine AS brotli
RUN apk add --no-cache build-base cmake git pcre-dev zlib-dev openssl-dev linux-headers
RUN git clone --depth=1 --recurse-submodules --shallow-submodules \
      https://github.com/google/ngx_brotli /ngx_brotli \
 && cmake -S /ngx_brotli/deps/brotli -B /ngx_brotli/deps/brotli/out \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /ngx_brotli/deps/brotli/out --target brotlienc --config Release -j"$(nproc)"
RUN set -eux; \
    ver="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"; \
    wget -qO /nginx.tar.gz "https://nginx.org/download/nginx-${ver}.tar.gz"; \
    tar -xzf /nginx.tar.gz -C /; \
    cd "/nginx-${ver}"; \
    ./configure --with-compat --add-dynamic-module=/ngx_brotli >/dev/null; \
    make -j"$(nproc)" modules; \
    mkdir -p /modules; \
    cp objs/ngx_http_brotli_static_module.so /modules/

# ---- runtime stage: serve the built dist/ with nginx ----
FROM nginx:1.27-alpine AS runtime

# NGINX_ENVSUBST_FILTER restricts substitution to OUR vars (names containing
# MORTGAGE_CALC), so nginx runtime vars like $uri in the template are left intact
# even though they share the $-syntax. MORTGAGE_CALC_PORT is the default the
# compose stack overrides via config.env.
ENV NGINX_ENVSUBST_FILTER=MORTGAGE_CALC \
    MORTGAGE_CALC_PORT=8080

# The compiled brotli_static module. load_module is a MAIN-context directive, so
# it can't live in the conf.d server template — prepend it to nginx.conf instead.
# /etc/nginx/modules is the stock symlink to /usr/lib/nginx/modules.
COPY --from=brotli /modules/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/
RUN sed -i '1i load_module modules/ngx_http_brotli_static_module.so;' /etc/nginx/nginx.conf

# Rendered to /etc/nginx/conf.d/default.conf at container start by the stock
# entrypoint (20-envsubst-on-templates.sh), replacing nginx's default server.
COPY default.conf.template /etc/nginx/templates/default.conf.template
# The bundled, minified, content-hashed assets from the build stage — including
# the precompressed index.html.br / index.html.gz the static modules serve.
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
