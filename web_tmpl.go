package main

import (
	"embed"
	"html/template"
)

//go:embed web/view/*.html
var webFS embed.FS

var webTmpl = template.Must(template.New("").Funcs(template.FuncMap{
	"asset": asset,
}).ParseFS(webFS, "web/view/*.html"))
