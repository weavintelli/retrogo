package main

import (
	"embed"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// cdnURLEnv is the runtime base URL prefixed onto /static/ asset URLs.
// Unset or empty keeps same-origin paths served by this process.
const cdnURLEnv = "RETROGO_CDN_URL"

// web/dist holds the bundles built by the bun project in web/
// (`bun run build`); only .gitkeep is committed, so run the frontend build
// before compiling the binary.
//
//go:embed all:web/dist
var staticFS embed.FS

var distFS = func() fs.FS {
	sub, err := fs.Sub(staticFS, "web/dist")
	if err != nil {
		panic(err)
	}
	return sub
}()

var staticFiles = func() []string {
	entries, err := fs.ReadDir(distFS, ".")
	if err != nil {
		panic(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		names = append(names, e.Name())
	}
	return names
}()

// matchAsset finds "<name>-<hash>.<ext>" or a plain "<name>.<ext>" among
// files. A hashed bundle wins when both exist. The hash is one Bun content
// hash ([A-Za-z0-9_-]+), so a name like "home-bad.name.js" does not match.
func matchAsset(files []string, name, ext string) string {
	plain := name + "." + ext
	prefix := name + "-"
	suffix := "." + ext
	var hashed string
	plainFound := false
	for _, f := range files {
		if f == plain {
			plainFound = true
			continue
		}
		if !strings.HasPrefix(f, prefix) || !strings.HasSuffix(f, suffix) || len(f) <= len(prefix)+len(suffix) {
			continue
		}
		if isAssetHash(f[len(prefix):len(f)-len(suffix)]) && hashed == "" {
			hashed = f
		}
	}
	if hashed != "" {
		return hashed
	}
	if plainFound {
		return plain
	}
	return ""
}

func isAssetHash(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// jsAsset resolves a bundle entry name ("home") to its URL
// ("/static/home-1a2b3c4d.js", or that path prefixed with RETROGO_CDN_URL).
// When the bundle has not been built it falls back to the unhashed name,
// which 404s until `bun run build` has run.
func jsAsset(name string) string {
	return prefixStaticURL(assetPath(name, "js"))
}

// cssAsset is the stylesheet counterpart of jsAsset ("/static/main-1a2b3c4d.css").
func cssAsset(name string) string {
	return prefixStaticURL(assetPath(name, "css"))
}

func assetPath(name, ext string) string {
	if match := matchAsset(staticFiles, name, ext); match != "" {
		return "/static/" + match
	}
	return "/static/" + name + "." + ext
}

// cdnBase is RETROGO_CDN_URL with surrounding space and trailing slashes
// removed. Empty means direct, same-origin /static/ URLs. Trailing slashes
// are dropped so the base joins the absolute /static/... path with one slash
// and the scheme's "://" is left intact.
func cdnBase() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv(cdnURLEnv)), "/")
}

func prefixStaticURL(path string) string {
	base := cdnBase()
	if base == "" {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

// cdnOrigin is the scheme://host of RETROGO_CDN_URL for CSP, or "" when the
// base is unset, empty, or not an absolute http(s) URL with a safe host.
func cdnOrigin() string {
	raw := strings.TrimSpace(os.Getenv(cdnURLEnv))
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || !isCSPHost(u.Host) {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func isCSPHost(host string) bool {
	if host == "" {
		return false
	}
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == ':', r == '[', r == ']':
		default:
			return false
		}
	}
	return true
}

// staticHandler serves the embedded bundles. Hashed names are immutable, so a
// file that exists is cached aggressively (overriding the global no-store
// header). Missing paths and directories stay no-store and are not listed.
func staticHandler() http.Handler {
	files := http.StripPrefix("/static/", http.FileServerFS(distFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/static/")
		if name == "" || strings.Contains(name, "/") || strings.HasPrefix(name, ".") || !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		info, err := fs.Stat(distFS, name)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		files.ServeHTTP(w, r)
	})
}
