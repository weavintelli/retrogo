# Runtime only. The workflow builds the frontend and the binary on the
# runner (ubuntu-26.04 or ubuntu-26.04-arm) and the build context is that
# binary plus this file. tini is in universe; official Ubuntu images already
# enable it.
FROM ubuntu:26.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
	tini \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
COPY retrogo /retrogo
ENV LISTEN=:8080
# Optional. ASSET_CDN_URL prefixes /static/ asset URLs (for example
# https://cdn.example.com). Leave it unset to serve those URLs from this process.
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["/retrogo"]
