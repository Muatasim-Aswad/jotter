package webassets

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
)

type BuildInfo struct {
	Version     *string `json:"version"`
	Revision    string  `json:"revision"`
	CommittedAt *string `json:"committedAt"`
	BuiltAt     string  `json:"builtAt"`
}

func Identity(assets fs.FS) (BuildInfo, error) {
	data, err := fs.ReadFile(assets, "version.json")
	if err != nil {
		return BuildInfo{}, fmt.Errorf("read build identity: %w", err)
	}
	var identity BuildInfo
	if err := json.Unmarshal(data, &identity); err != nil {
		return BuildInfo{}, fmt.Errorf("decode build identity: %w", err)
	}
	if identity.Version == nil || *identity.Version == "" || identity.Revision == "" || identity.BuiltAt == "" {
		return BuildInfo{}, fmt.Errorf("build identity is incomplete")
	}
	return identity, nil
}

func Handler(assets fs.FS) http.Handler {
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/version.json" {
			response.Header().Set("Cache-Control", "no-store")
			response.Header().Set("Content-Type", "application/json")
		}
		if request.URL.Path == "/about" || request.URL.Path == "/about/" {
			request = request.Clone(request.Context())
			request.URL.Path = "/"
		}
		files.ServeHTTP(response, request)
	})
}
