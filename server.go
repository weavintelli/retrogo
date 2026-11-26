package main

import (
	"bytes"
	"log"
	"net/http"
	"strings"
	"time"
)

type pageData struct {
	Nav       string
	Time      string
	Lang      string
	Languages []languageOption
}

type Server struct{}

func NewServer() *Server {
	return &Server{}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /{$}", s.handleHome)
	mux.HandleFunc("GET /about", s.handleAbout)
	mux.Handle("GET /static/", staticHandler())
	return s.withSecurityHeaders(s.withLanguage(mux))
}

func (s *Server) withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		scriptSrc := "'self'"
		styleSrc := "'self'"
		imgSrc := "'self' data:"
		// ASSET_CDN_URL prefixes every static URL (scripts, styles, and
		// images), so those loads from that origin have to be allowed.
		if origin := cdnOrigin(); origin != "" {
			scriptSrc += " " + origin
			styleSrc += " " + origin
			imgSrc += " " + origin
		}
		h.Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'none'",
			"script-src " + scriptSrc,
			"style-src " + styleSrc,
			"img-src " + imgSrc,
			"connect-src 'self'",
			"form-action 'self'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
		}, "; "))
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("OK"))
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	data := localizedPage(r, "home")
	data.Time = time.Now().Format(time.DateTime)
	s.render(w, "home.html", data)
}

func (s *Server) handleAbout(w http.ResponseWriter, r *http.Request) {
	s.render(w, "about.html", localizedPage(r, "about"))
}

func (s *Server) render(w http.ResponseWriter, name string, data any) {
	var buf bytes.Buffer
	if err := webTmpl.ExecuteTemplate(&buf, name, data); err != nil {
		log.Println("template:", name, err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := w.Write(buf.Bytes()); err != nil {
		log.Println("write:", name, err)
	}
}
