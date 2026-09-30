package main

import (
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
