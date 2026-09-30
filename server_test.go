package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPages(t *testing.T) {
	h := NewServer().Handler()
	tests := []struct {
		path string
		want []string
	}{
		{"/healthz", []string{"OK"}},
		{"/", []string{"Home", "Clicked", jsAsset("home"), cssAsset("main")}},
		{"/about", []string{"About", "nav-link active", jsAsset("about")}},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tt.path, rec.Code)
		}
		body := rec.Body.String()
		for _, want := range tt.want {
			if !strings.Contains(body, want) {
				t.Errorf("%s: body missing %q", tt.path, want)
			}
		}
		cc := rec.Header().Get("Cache-Control")
		if cc != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", tt.path, cc)
		}
		csp := rec.Header().Get("Content-Security-Policy")
		if strings.Contains(csp, "unsafe-inline") || !strings.Contains(csp, "style-src 'self'") {
			t.Errorf("%s: CSP = %q", tt.path, csp)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing nosniff", tt.path)
		}
	}
}

func TestMethodNotAllowed(t *testing.T) {
	rec := httptest.NewRecorder()
	NewServer().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: status %d, want 405", rec.Code)
	}
}

func TestRenderMissingTemplate(t *testing.T) {
	rec := httptest.NewRecorder()
	NewServer().render(rec, "missing.html", nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("error response leaked HTML: %q", rec.Body.String())
	}
}

func TestStaticCaching(t *testing.T) {
	h := NewServer().Handler()

	for _, path := range []string{"/static/", "/static/.gitkeep", "/static/missing.js"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", path, rec.Code)
		}
		if strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("%s: 404 cached as immutable (%s)", path, rec.Header().Get("Cache-Control"))
		}
	}

	name := matchAsset(staticFiles, "home", "js")
	if name == "" {
		t.Skip("home bundle not built")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/"+name, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /static/%s: status %d", name, rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("Content-Type = %q", ct)
	}
}
