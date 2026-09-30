package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMatchAsset(t *testing.T) {
	files := []string{
		".gitkeep",
		"home.js",
		"home-1a2b3c4d.js",
		"home-bad.name.js",
		"homepage-abcd.js",
		"main-5e6f7a8b.css",
		"about.js",
		"widget-ab_cd-ef.js",
	}
	tests := []struct {
		name, ext, want string
	}{
		{"home", "js", "home-1a2b3c4d.js"},
		{"main", "css", "main-5e6f7a8b.css"},
		{"about", "js", "about.js"},
		{"missing", "js", ""},
		{"home", "css", ""},
		{"homepage", "js", "homepage-abcd.js"},
		{"widget", "js", "widget-ab_cd-ef.js"},
	}
	for _, tt := range tests {
		t.Run(tt.name+"."+tt.ext, func(t *testing.T) {
			assert.Equal(t, tt.want, matchAsset(files, tt.name, tt.ext))
		})
	}
}

func TestPrefixStaticURL(t *testing.T) {
	const path = "/static/home-1a2b3c4d.js"
	tests := []struct {
		name, base, want string
	}{
		{"unset", "", path},
		{"blank", "   ", path},
		{"origin", "https://cdn.example.com", "https://cdn.example.com/static/home-1a2b3c4d.js"},
		{"trailing slash", "https://cdn.example.com/", "https://cdn.example.com/static/home-1a2b3c4d.js"},
		{"extra slashes", "https://cdn.example.com///", "https://cdn.example.com/static/home-1a2b3c4d.js"},
		{"path prefix", "https://cdn.example.com/assets", "https://cdn.example.com/assets/static/home-1a2b3c4d.js"},
		{"path prefix slash", "https://cdn.example.com/assets/", "https://cdn.example.com/assets/static/home-1a2b3c4d.js"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(cdnURLEnv, tt.base)
			assert.Equal(t, tt.want, prefixStaticURL(path))
			assert.NotContains(t, prefixStaticURL(path), "//static")
			assert.NotContains(t, prefixStaticURL(path), "https:/static")
		})
	}
}

func TestAssetURLUsesCDNBase(t *testing.T) {
	t.Setenv(cdnURLEnv, "")
	assert.True(t, strings.HasPrefix(jsAsset("home"), "/static/"))
	assert.True(t, strings.HasPrefix(cssAsset("main"), "/static/"))

	t.Setenv(cdnURLEnv, "https://cdn.example.com/")
	assert.Equal(t, "https://cdn.example.com"+assetPath("home", "js"), jsAsset("home"))
	assert.Equal(t, "https://cdn.example.com"+assetPath("main", "css"), cssAsset("main"))
}

func TestCDNOrigin(t *testing.T) {
	tests := []struct {
		name, base, want string
	}{
		{"empty", "", ""},
		{"https path", "https://cdn.example.com/assets/", "https://cdn.example.com"},
		{"port", "https://cdn.example.com:8443", "https://cdn.example.com:8443"},
		{"http", "http://cdn.example.com", "http://cdn.example.com"},
		{"ipv6", "https://[2001:db8::1]/static", "https://[2001:db8::1]"},
		{"protocol relative", "//cdn.example.com", ""},
		{"javascript", "javascript:alert(1)", ""},
		{"csp injection", "https://cdn.example.com/;default-src *", "https://cdn.example.com"},
		{"bad host", "https://cdn.example.com;script-src evil", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(cdnURLEnv, tt.base)
			assert.Equal(t, tt.want, cdnOrigin())
		})
	}
}
