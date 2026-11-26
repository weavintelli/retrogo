package main

import (
	"net/http"
	"strconv"
	"strings"
)

const (
	languageCookieName   = "retrogo_lang"
	languageCookieMaxAge = 365 * 24 * 60 * 60
	langZH               = "zh-CN"
	langEN               = "en"
	defaultLanguage      = langZH
	missingMessagePrefix = "[missing:"
)

// localeMetadata is the allowlist for values accepted from URLs, cookies, and
// Accept-Language. Tag is emitted as html/lang; Cookie is the compact value
// used by the language switch links and persisted preference.
type localeMetadata struct {
	Tag    string
	Cookie string
	Name   string
}

var supportedLocales = []localeMetadata{
	{Tag: langZH, Cookie: "zh", Name: "中文"},
	{Tag: langEN, Cookie: "en", Name: "English"},
}

// languageFallbacks controls per-message lookup, not request parsing. English
// is the final fallback for every locale. Keep registrations acyclic; the
// resolver also stops cycles defensively.
var languageFallbacks = map[string]string{
	langZH: langEN,
}

// languageFallbackChain returns the requested locale followed by its fallback
// locales. Every chain ends at English, including an unknown or cyclic locale.
func languageFallbackChain(lang string) []string {
	chain := make([]string, 0, 2)
	seen := make(map[string]bool)
	for lang != "" && !seen[lang] {
		seen[lang] = true
		chain = append(chain, lang)
		if lang == langEN {
			return chain
		}
		next, ok := languageFallbacks[lang]
		if !ok || next == "" {
			next = langEN
		}
		lang = next
	}
	if !seen[langEN] {
		chain = append(chain, langEN)
	}
	return chain
}

// translate looks up one key through the locale's fallback chain. Empty and
// absent messages fall through; a visible marker makes incomplete catalogs
// straightforward to detect in tests and development.
func translate(catalogs map[string]messageCatalog, lang, key string) string {
	for _, candidate := range languageFallbackChain(lang) {
		if value := catalogs[candidate][key]; value != "" {
			return value
		}
	}
	return missingMessagePrefix + key + "]"
}

// T is the template helper for all user-visible copy on a page.
func (p pageData) T(key string) string {
	return translate(messageCatalogs, p.Lang, key)
}

type languageOption struct {
	Tag     string
	Name    string
	URL     string
	Current bool
}

// localizedPage builds the request-scoped part of the template data. Pages use
// one canonical URL; the selected language changes only their catalog.
func localizedPage(r *http.Request, nav string) pageData {
	lang := resolveLanguage(r)
	data := pageData{Nav: nav, Lang: lang}
	for _, locale := range supportedLocales {
		data.Languages = append(data.Languages, languageOption{
			Tag:     locale.Tag,
			Name:    locale.Name,
			URL:     requestTargetForLanguage(r, locale.Cookie),
			Current: locale.Tag == lang,
		})
	}
	return data
}

// localeNamed accepts only an allowlisted tag or cookie value. User input is
// never reflected as a language tag without passing through this registry.
func localeNamed(raw string) (localeMetadata, bool) {
	raw = strings.ToLower(strings.TrimSpace(raw))
	for _, locale := range supportedLocales {
		if raw == strings.ToLower(locale.Tag) || raw == strings.ToLower(locale.Cookie) {
			return locale, true
		}
	}
	return localeMetadata{}, false
}

// resolveLanguage applies query -> cookie -> Accept-Language -> default. The
// middleware normally turns a valid query preference into a cookie and a clean
// URL before rendering; accepting it here too keeps this function self-contained.
func resolveLanguage(r *http.Request) string {
	if r == nil {
		return defaultLanguage
	}
	if r.URL != nil {
		if locale, ok := localeNamed(r.URL.Query().Get("lang")); ok {
			return locale.Tag
		}
	}
	if cookie, err := r.Cookie(languageCookieName); err == nil {
		if locale, ok := localeNamed(cookie.Value); ok {
			return locale.Tag
		}
	}
	return acceptLanguage(r.Header.Get("Accept-Language"))
}

// acceptLanguage returns the supported locale with the highest positive q
// value. Ties retain header order. Unsupported and malformed ranges are
// ignored, and regional variants match their registered base language.
func acceptLanguage(header string) string {
	bestLang := ""
	bestQ := 0.0
	for _, item := range strings.Split(header, ",") {
		tag, params, _ := strings.Cut(item, ";")
		tag = strings.ToLower(strings.TrimSpace(tag))
		q := 1.0
		valid := true
		for _, param := range strings.Split(params, ";") {
			name, value, found := strings.Cut(strings.TrimSpace(param), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(name), "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				valid = false
				break
			}
			q = parsed
		}
		if !valid || q <= 0 || q < bestQ {
			continue
		}
		for _, locale := range supportedLocales {
			base := strings.ToLower(strings.Split(locale.Tag, "-")[0])
			if tag == base || strings.HasPrefix(tag, base+"-") {
				// Strictly greater preserves header order when q values tie.
				if q > bestQ {
					bestLang = locale.Tag
					bestQ = q
				}
				break
			}
		}
	}
	if bestLang == "" {
		return defaultLanguage
	}
	return bestLang
}

// withLanguage persists a valid ?lang= preference, then redirects to the same
// local URL without lang. Static files and probes never receive language
// cookies or redirects. Invalid values are ignored rather than reflected.
func (s *Server) withLanguage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLocalizablePage(r) {
			next.ServeHTTP(w, r)
			return
		}
		if locale, ok := localeNamed(r.URL.Query().Get("lang")); ok {
			setLanguageCookie(w, r, locale.Cookie)
			http.Redirect(w, r, requestTargetForLanguage(r, ""), http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLocalizablePage(r *http.Request) bool {
	if r == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	path := r.URL.Path
	return path != "/healthz" && path != "/static" && !strings.HasPrefix(path, "/static/")
}

func setLanguageCookie(w http.ResponseWriter, r *http.Request, lang string) {
	http.SetCookie(w, &http.Cookie{
		Name:     languageCookieName,
		Value:    lang,
		Path:     "/",
		MaxAge:   languageCookieMaxAge,
		HttpOnly: true,
		Secure:   requestUsesHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func requestUsesHTTPS(r *http.Request) bool {
	if r == nil {
		return false
	}
	forwarded, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	return r.TLS != nil || strings.EqualFold(strings.TrimSpace(forwarded), "https")
}

// requestTargetForLanguage preserves the escaped path and unrelated query
// parameters. An empty lang removes the preference from the redirect target.
func requestTargetForLanguage(r *http.Request, lang string) string {
	if r == nil || r.URL == nil {
		return "/"
	}
	q := r.URL.Query()
	if lang == "" {
		q.Del("lang")
	} else {
		q.Set("lang", lang)
	}
	target := r.URL.EscapedPath()
	if target == "" {
		target = "/"
	}
	if encoded := q.Encode(); encoded != "" {
		target += "?" + encoded
	}
	return target
}
