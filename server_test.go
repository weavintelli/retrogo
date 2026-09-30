package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
		t.Run(tt.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			require.Equal(t, http.StatusOK, rec.Code)
			body := rec.Body.String()
			for _, want := range tt.want {
				assert.Contains(t, body, want)
			}
			assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
			csp := rec.Header().Get("Content-Security-Policy")
			assert.NotContains(t, csp, "unsafe-inline")
			assert.Contains(t, csp, "style-src 'self'")
			assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
		})
	}
}

func TestMethodNotAllowed(t *testing.T) {
	rec := httptest.NewRecorder()
	NewServer().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestRenderMissingTemplate(t *testing.T) {
	rec := httptest.NewRecorder()
	NewServer().render(rec, "missing.html", nil)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "<html")
}

func TestStaticCaching(t *testing.T) {
	h := NewServer().Handler()

	for _, path := range []string{"/static/", "/static/.gitkeep", "/static/missing.js"} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			require.Equal(t, http.StatusNotFound, rec.Code)
			assert.NotContains(t, rec.Header().Get("Cache-Control"), "immutable")
		})
	}

	name := matchAsset(staticFiles, "home", "js")
	if name == "" {
		t.Skip("home bundle not built")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/"+name, nil))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
	assert.Contains(t, rec.Header().Get("Content-Type"), "javascript")
}
