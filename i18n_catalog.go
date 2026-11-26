package main

// messageCatalog contains short, plain-text UI messages. html/template escapes
// them at the render seam. Long documents or trusted HTML should use a separate
// content type rather than bypassing escaping here.
type messageCatalog map[string]string

// Keep both catalogs at the same keys. TestCatalogCompleteness enforces parity
// and checks every literal .T reference in the embedded templates.
var messageCatalogs = map[string]messageCatalog{
	langZH: {
		"nav.home":          "首页",
		"nav.about":         "关于",
		"language.switch":   "切换语言",
		"language.label":    "语言",
		"home.title":        "retrogo",
		"home.heading":      "首页",
		"home.description":  "由标准库 net/http 提供服务，并使用 html/template 渲染于",
		"home.clicked":      "已点击",
		"home.times":        "次",
		"about.title":       "关于 - retrogo",
		"about.heading":     "关于",
		"about.description": "retrogo：复古的 html/template 视图，搭配 esbuild + Preact 岛屿 + Tailwind v4。",
		"about.bundle":      "每个页面都加载独立、带哈希且可长期缓存的 <entry>-<hash>.js 构建文件。",
	},
	langEN: {
		"nav.home":          "Home",
		"nav.about":         "About",
		"language.switch":   "Switch language",
		"language.label":    "Language",
		"home.title":        "retrogo",
		"home.heading":      "Home",
		"home.description":  "Served by std net/http and rendered with html/template at",
		"home.clicked":      "Clicked",
		"home.times":        "times",
		"about.title":       "About - retrogo",
		"about.heading":     "About",
		"about.description": "retrogo: retro html/template views, esbuild + Preact islands + Tailwind v4.",
		"about.bundle":      "Each page loads its own hashed, immutable <entry>-<hash>.js bundle.",
	},
}
