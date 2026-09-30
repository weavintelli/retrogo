# retrogo

A GitHub template that bundles multiple TypeScript entrypoints and Tailwind CSS with Bun, then serves the hashed assets through classic Go `html/template` and `net/http`.

Retro on the server, modern in the build:

- **std `net/http` only** — Go 1.22+ pattern routing (`GET /{$}`, `GET /static/`, `{id}` wildcards), security headers, graceful shutdown with no deadline. No web framework, no router dependency.
- **Bun multi-entry build** — every `.ts` / `.css` file in `web/src/entries/` is bundled by `web/build.ts` (`Bun.build`, IIFE, minified) into `web/dist/<name>-<hash>.<ext>`. `main.css` is a full Tailwind v4 build (`bun-plugin-tailwind`) with build-time lucide icons via `@iconify/tailwind4`.
- **`html/template` views** — embedded with `//go:embed`, referencing bundles only by entry name: `{{cssAsset "main"}}`, `{{jsAsset "home"}}`. Hash resolution happens in `web_static.go`.
- **Immutable static serving** — `web/dist` is embedded (`//go:embed all:web/dist`) and served at `GET /static/` with `Cache-Control: public, max-age=31536000, immutable`, so hashed assets are cached forever and new builds get new URLs.

## Layout

| Path | Role |
|---|---|
| `main.go` | Flags (`-listen` / `RETROGO_LISTEN`, default `:8080`), graceful shutdown |
| `server.go` | `http.ServeMux` with method+path patterns, security headers, page handlers |
| `web_tmpl.go` | `//go:embed web/view/*.html`, template funcs `jsAsset` / `cssAsset` |
| `web_static.go` | `//go:embed all:web/dist`, `<entry>-<hash>.<ext>` matching, `/static/` handler |
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

## Build

```bash
(cd web && bun run typecheck && bun run build)
go test ./...
go build .
```

`web/dist` is git-ignored (only `.gitkeep` is committed), so always run the frontend build before `go build` — in Docker, do it in an `oven/bun` stage.

## Continuous integration

| Event | What runs |
| --- | --- |
| Pull request, or a push to any branch other than `main` | `go test ./...` |
| Push to `main` | the same tests, then `ghcr.io/weavintelli/retrogo:latest` |
| Push of a semver tag (`v1.2.3`, `v1.2.3-rc.1`, and any other `-` pre-release) | the same tests, then the semver image tags below |

| Git tag | Image tags |
| --- | --- |
| `v1.2.3` | `1.2.3`, `1.2`, `1` |
| `v1.2.3-rc.1` | `1.2.3-rc.1` |
| `v0.2.0` | `0.2.0`, `0.2` |
| `v0.0.1` | `0.0.1` |

Docker tags drop the leading `v`. There is no commit-SHA tag and no branch-name tag. Pre-release suffixes (`-rc`, `-beta`, `-alpha`, and any other semver pre-release) publish the full version only. Floating tags that would be only a leading zero (`0`, `0.0`) are not published. `:latest` moves only when `main` moves, not when a tag is pushed. There is no binary archive release.

The image is `linux/amd64` and `linux/arm64`, built on native runners (`ubuntu-26.04` and `ubuntu-26.04-arm`) and published as one manifest list. There is no QEMU emulation.

The image is built from the multi-stage `Dockerfile` (`oven/bun` for the frontend, `golang` for the binary, `debian:bookworm-slim` at runtime). The bun stage mirrors the repo layout (`WORKDIR /repo/web`, `COPY *.go /repo/`) because `main.css`'s Tailwind `@source "../../../*.go"` resolves relative to the CSS file — without the Go files next to `web/`, the glob lands on the container root and the build hangs scanning the whole filesystem.

## Adding a page

1. Add a route in `server.go`, e.g. `mux.HandleFunc("GET /about", s.handleAbout)`.
2. Add a view `web/view/about.html` with `{{template "head" .}}` and `<script src="{{jsAsset "about"}}" defer></script>`.
3. Add an entry `web/src/entries/about.ts`.
4. `bun run build` — the new `about-<hash>.js` is picked up automatically.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Shenzhen WeavIntelli Software Co., Ltd.
