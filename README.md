# retrogo

A GitHub template that bundles multiple TypeScript entrypoints and Tailwind CSS with Bun, then serves the hashed assets through classic Go `html/template` and `net/http`.

Retro on the server, modern in the build:

- **std `net/http` only** — Go 1.22+ pattern routing (`GET /{$}`, `GET /static/`, `{id}` wildcards), security headers, graceful shutdown with no deadline. No web framework, no router dependency.
- **Bun multi-entry build** — every `.ts` / `.css` file in `web/src/entries/` is bundled by `web/build.ts` (`Bun.build`, IIFE, minified) into `web/dist/<name>-<hash>.<ext>`. `main.css` is a full Tailwind v4 build (`bun-plugin-tailwind`) with build-time lucide icons via `@iconify/tailwind4`.
- **`html/template` views** — embedded with `//go:embed`, referencing files by name and extension: `{{asset "main.css"}}`, `{{asset "home.js"}}`, `{{asset "logo.png"}}`. Hash resolution happens in `web_static.go`.
- **Immutable static serving** — `web/dist` is embedded (`//go:embed all:web/dist`) and served at `GET /static/` with `Cache-Control: public, max-age=31536000, immutable`, so hashed assets are cached forever and new builds get new URLs.
- **Optional CDN prefix** — set `ASSET_CDN_URL` to a base URL and `{{asset}}` emits that base plus `/static/<file>`. Unset or empty keeps same-origin `/static/` URLs.

## Layout

| Path | Role |
|---|---|
| `main.go` | Flags (`-listen` / `RETROGO_LISTEN`, default `:8080`), `ASSET_CDN_URL`, graceful shutdown |
| `server.go` | `http.ServeMux` with method+path patterns, security headers, page handlers |
| `web_tmpl.go` | `//go:embed web/view/*.html`, template func `asset` |
| `web_static.go` | `//go:embed all:web/dist`, `<entry>-<hash>.<ext>` matching, `/static/` handler, `ASSET_CDN_URL` prefix |
| `web/build.ts` | Bun build: bundles every entry in `src/entries/` into hashed IIFEs in `dist/` |
| `web/src/entries/` | One file per bundle: page TS entries plus `main.css` (Tailwind v4) |
| `web/view/` | Go templates; `base.html` defines shared `head` / `nav` blocks |

## Develop

```bash
# terminal 1: rebuild bundles on change (unminified, inline sourcemaps)
(cd web && bun install && bun run dev)

# terminal 2: run the server
go run .
```

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `RETROGO_LISTEN` | `:8080` | Listen address (`-listen` overrides the environment) |
| `ASSET_CDN_URL` | empty | Base URL prefixed onto static asset URLs. Empty serves `/static/` from this process |

```bash
ASSET_CDN_URL=https://cdn.example.com go run .
```

`https://cdn.example.com` and `https://cdn.example.com/` both produce `https://cdn.example.com/static/<file>`. A path on the base is kept (`https://cdn.example.com/assets/` → `https://cdn.example.com/assets/static/<file>`). The process still serves `GET /static/` so an origin-pull CDN can fetch the files. `script-src`, `style-src`, and `img-src` allow the CDN origin while the variable is set.

## Build

```bash
(cd web && bun run typecheck && bun run build)
go test ./...
go build .
```

`web/dist` is git-ignored (only `.gitkeep` is committed), so always run the frontend build before `go build`. The image does not build either one.

## Continuous integration

| Event | What runs |
| --- | --- |
| Pull request, or a push to any branch other than `main` | `go test ./...` |
| Push to `main` | the same tests, then `ghcr.io/weavintelli/retrogo:latest` |
| Push of a semver tag (`v1.2.3`, `v1.2.3-rc.1`, and any other `-` pre-release) | the same tests, the semver image tags below, and a GitHub Release |

| Git tag | Image tags |
| --- | --- |
| `v1.2.3` | `1.2.3`, `1.2`, `1` |
| `v1.2.3-rc.1` | `1.2.3-rc.1` |
| `v0.2.0` | `0.2.0`, `0.2` |
| `v0.0.1` | `0.0.1` |

Docker tags drop the leading `v`. There is no commit-SHA tag and no branch-name tag. Pre-release suffixes (`-rc`, `-beta`, `-alpha`, and any other semver pre-release) publish the full version only. Floating tags that would be only a leading zero (`0`, `0.0`) are not published. `:latest` moves only when `main` moves, not when a tag is pushed. A pre-release tag is marked as a GitHub pre-release and is not made the repository's latest release. The release description states the image tag and these floating-tag rules, and GitHub appends generated release notes. No binary archives are attached.

The image is `linux/amd64` and `linux/arm64`, built on native runners (`ubuntu-26.04` and `ubuntu-26.04-arm`) and published as one manifest list. There is no QEMU emulation.

The runner builds the frontend with Bun and the binary with Go, then the `Dockerfile` only installs a runtime (`ubuntu:26.04`, `tini`, `ca-certificates`) and copies the binary in. The runner and the image are the same Ubuntu series. The frontend stays on the runner because `main.css`'s Tailwind `@source "../../../*.go"` resolves relative to the CSS file — the checkout already has the Go files next to `web/`. Building that step in an image without the same layout makes the glob land on the container root and the build hangs scanning the whole filesystem.

## Adding a page

1. Add a route in `server.go`, e.g. `mux.HandleFunc("GET /about", s.handleAbout)`.
2. Add a view `web/view/about.html` with `{{template "head" .}}` and `<script src="{{asset "about.js"}}" defer></script>`.
3. Add an entry `web/src/entries/about.ts`.
4. `bun run build` — the new `about-<hash>.js` is picked up automatically.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Shenzhen WeavIntelli Software Co., Ltd.
