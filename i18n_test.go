package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveLanguage(t *testing.T) {
	tests := []struct {
		name   string
		query  string
		cookie string
		accept string
		want   string
	}{
		{name: "default", want: langZH},
		{name: "query beats cookie and header", query: "?lang=en", cookie: "zh", accept: "zh-CN", want: langEN},
		{name: "query accepts full tag", query: "?lang=zh-CN", cookie: "en", accept: "en", want: langZH},
		{name: "invalid query falls to cookie", query: "?lang=fr", cookie: "en", accept: "zh-CN", want: langEN},
		{name: "cookie beats header", cookie: "zh", accept: "en-US,en;q=0.9", want: langZH},
		{name: "invalid cookie falls to header", cookie: "fr", accept: "en-US,en;q=0.9", want: langEN},
		{name: "regional English", accept: "en-US,en;q=0.9", want: langEN},
		{name: "Chinese script variant", accept: "zh-Hans", want: langZH},
		{name: "q value wins over order", accept: "en;q=0.4,zh-Hans;q=0.9", want: langZH},
		{name: "unsupported then supported", accept: "fr-FR,en;q=0.8", want: langEN},
		{name: "unsupported only", accept: "fr-FR,de;q=0.9", want: langZH},
		{name: "zero q", accept: "en;q=0,zh;q=0", want: langZH},
		{name: "malformed q is ignored", accept: "en;q=bad,zh-CN;q=0.8", want: langZH},
		{name: "tie keeps header order", accept: "en;q=0.8,zh;q=0.8", want: langEN},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/"+tt.query, nil)
			if tt.cookie != "" {
				req.AddCookie(&http.Cookie{Name: languageCookieName, Value: tt.cookie})
			}
			if tt.accept != "" {
				req.Header.Set("Accept-Language", tt.accept)
			}
			assert.Equal(t, tt.want, resolveLanguage(req))
		})
	}
}

func TestLanguageFallback(t *testing.T) {
	catalogs := map[string]messageCatalog{
		langZH: {
			"only.zh": "中文",
			"empty":   "",
		},
		langEN: {
			"fallback": "English fallback",
			"empty":    "Not empty in the fallback",
		},
	}

	assert.Equal(t, []string{langZH, langEN}, languageFallbackChain(langZH))
	assert.Equal(t, []string{langEN}, languageFallbackChain(langEN))
	assert.Equal(t, []string{"fr", langEN}, languageFallbackChain("fr"))
	assert.Equal(t, "中文", translate(catalogs, langZH, "only.zh"))
	assert.Equal(t, "English fallback", translate(catalogs, langZH, "fallback"))
	assert.Equal(t, "Not empty in the fallback", translate(catalogs, langZH, "empty"))
	assert.Equal(t, "[missing:unknown]", translate(catalogs, langZH, "unknown"))
}

func TestLanguageQueryPersistsCookieAndCleansURL(t *testing.T) {
	h := NewServer().Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/about?lang=en&ref=1", nil))

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/about?ref=1", rec.Header().Get("Location"))
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	cookie := cookies[0]
	assert.Equal(t, languageCookieName, cookie.Name)
	assert.Equal(t, "en", cookie.Value)
	assert.Equal(t, "/", cookie.Path)
	assert.Equal(t, languageCookieMaxAge, cookie.MaxAge)
	assert.True(t, cookie.HttpOnly)
	assert.False(t, cookie.Secure)
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)

	// Following the redirect renders the same URL in the persisted language.
	follow := httptest.NewRequest(http.MethodGet, rec.Header().Get("Location"), nil)
	follow.AddCookie(cookie)
	followRec := httptest.NewRecorder()
	h.ServeHTTP(followRec, follow)
	require.Equal(t, http.StatusOK, followRec.Code)
	assert.Contains(t, followRec.Body.String(), `<html lang="en">`)
	assert.Contains(t, followRec.Body.String(), "About - retrogo")

	secureReq := httptest.NewRequest(http.MethodGet, "/?lang=zh", nil)
	secureReq.Header.Set("X-Forwarded-Proto", "https")
	secureRec := httptest.NewRecorder()
	h.ServeHTTP(secureRec, secureReq)
	require.Equal(t, http.StatusFound, secureRec.Code)
	secureCookies := secureRec.Result().Cookies()
	require.Len(t, secureCookies, 1)
	assert.True(t, secureCookies[0].Secure)
	assert.Equal(t, "zh", secureCookies[0].Value)
}

func TestInvalidOrNonPageLanguageQueryDoesNotPersist(t *testing.T) {
	h := NewServer().Handler()
	tests := []struct {
		name   string
		method string
		target string
		status int
	}{
		{name: "unsupported locale", method: http.MethodGet, target: "/about?lang=fr", status: http.StatusOK},
		{name: "non-page method", method: http.MethodPost, target: "/?lang=en", status: http.StatusMethodNotAllowed},
		{name: "health probe", method: http.MethodGet, target: "/healthz?lang=en", status: http.StatusOK},
		{name: "static asset", method: http.MethodGet, target: "/static/missing.js?lang=en", status: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.target, nil))
			assert.Equal(t, tt.status, rec.Code)
			assert.Empty(t, rec.Result().Cookies())
			assert.NotEqual(t, http.StatusFound, rec.Code)
		})
	}
}

func TestPagesBilingual(t *testing.T) {
	h := NewServer().Handler()
	tests := []struct {
		name    string
		path    string
		cookie  string
		accept  string
		lang    string
		title   string
		heading string
		phrase  string
	}{
		{name: "home default Chinese", path: "/", lang: langZH, title: "retrogo", heading: "首页", phrase: "已点击"},
		{name: "home English cookie", path: "/", cookie: "en", accept: "zh-CN", lang: langEN, title: "retrogo", heading: "Home", phrase: "Clicked"},
		{name: "home Chinese cookie", path: "/", cookie: "zh", accept: "en", lang: langZH, title: "retrogo", heading: "首页", phrase: "已点击"},
		{name: "home English header", path: "/", accept: "en-US,en;q=0.9", lang: langEN, title: "retrogo", heading: "Home", phrase: "Clicked"},
		{name: "about Chinese", path: "/about", lang: langZH, title: "关于 - retrogo", heading: "关于", phrase: "复古的 html/template 视图"},
		{name: "about English", path: "/about", cookie: "en", lang: langEN, title: "About - retrogo", heading: "About", phrase: "Preact islands"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.cookie != "" {
				req.AddCookie(&http.Cookie{Name: languageCookieName, Value: tt.cookie})
			}
			if tt.accept != "" {
				req.Header.Set("Accept-Language", tt.accept)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			assert.Empty(t, rec.Result().Cookies(), "rendering must not change the preference")
			body := rec.Body.String()
			assert.Contains(t, body, `<html lang="`+tt.lang+`">`)
			assert.Contains(t, body, "<title>"+tt.title+"</title>")
			assert.Contains(t, body, `<div class="card-header">`+tt.heading+`</div>`)
			assert.Contains(t, body, tt.phrase)
			assert.Contains(t, body, ">中文</a>")
			assert.Contains(t, body, ">English</a>")
			assert.Equal(t, 1, strings.Count(body, `aria-current="true"`))
			assert.NotContains(t, body, missingMessagePrefix)
		})
	}
}

func TestLanguageLinksPreserveCurrentTarget(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/about?ref=1", nil)
	req.AddCookie(&http.Cookie{Name: languageCookieName, Value: "zh"})
	rec := httptest.NewRecorder()
	NewServer().Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `href="/about?lang=zh&amp;ref=1"`)
	assert.Contains(t, body, `href="/about?lang=en&amp;ref=1"`)
}

func TestLanguageRedirectKeepsEscapedPath(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/about%0D%0AX-Evil:yes?lang=en&x=1", nil)
	target := requestTargetForLanguage(req, "")
	assert.NotContains(t, target, "\r")
	assert.NotContains(t, target, "\n")
	assert.Contains(t, target, "%0D%0A")
	assert.Equal(t, "x=1", strings.SplitN(target, "?", 2)[1])
}

func TestCatalogCompleteness(t *testing.T) {
	for key, zh := range messageCatalogs[langZH] {
		assert.NotEmpty(t, zh, "zh message %s", key)
		en, ok := messageCatalogs[langEN][key]
		assert.True(t, ok, "en message missing %s", key)
		assert.NotEmpty(t, en, "en message %s", key)
	}
	for key := range messageCatalogs[langEN] {
		_, ok := messageCatalogs[langZH][key]
		assert.True(t, ok, "zh message missing %s", key)
	}

	// Every literal message referenced from a template exists in both catalogs.
	re := regexp.MustCompile(`\.T\s+"([^"]+)"`)
	refs := 0
	require.NoError(t, fs.WalkDir(webFS, "web/view", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		body, err := webFS.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range re.FindAllStringSubmatch(string(body), -1) {
			refs++
			key := match[1]
			_, zhOK := messageCatalogs[langZH][key]
			_, enOK := messageCatalogs[langEN][key]
			assert.True(t, zhOK, "zh template key missing: %s in %s", key, path)
			assert.True(t, enOK, "en template key missing: %s in %s", key, path)
		}
		return nil
	}))
	assert.Positive(t, refs)
}
