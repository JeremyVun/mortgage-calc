# Buildx bake target for mortgage-calc. Mirrors the analytics stack's layout:
# versions.hcl cascades GLOBAL_VERSION → per-image versions. Pass versions.hcl
# LAST so its cascade wins the merge (bake: last definition of a variable wins);
# the `default = "latest"` here is the fallback when versions.hcl is omitted.
#
#   docker buildx bake -f docker-bake.hcl -f versions.hcl                                  # build (tagged 0.1.0-alpha)
#   docker buildx bake -f docker-bake.hcl -f versions.hcl --push                           # build + push (multi-arch)
#   docker buildx bake mortgage-calc --set mortgage-calc.platform=linux/amd64 --load       # local single-arch load (tagged latest)
variable "REGISTRY"              { default = "registry.jeremyvun.com" }
variable "MORTGAGE_CALC_VERSION" { default = "latest" }

group "default" {
  targets = ["mortgage-calc"]
}

target "mortgage-calc" {
  # Build context is the repo root: the Dockerfile COPYs index.html +
  # default.conf.template from here.
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runtime"
  # Static nginx image → portable to both common arches. Multi-arch images can't be
  # --load-ed locally, so use --push (or --set mortgage-calc.platform=linux/amd64
  # --load for a single-arch local build).
  platforms = ["linux/amd64", "linux/arm64"]
  args = {
    VERSION = "${MORTGAGE_CALC_VERSION}"
  }
  tags = [
    "${REGISTRY}/mortgage-calc:${MORTGAGE_CALC_VERSION}",
    "${REGISTRY}/mortgage-calc:latest"
  ]
}
