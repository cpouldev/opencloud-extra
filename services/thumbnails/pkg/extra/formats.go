// Package extra describes the additional thumbnail providers in OpenCloud Extra.
package extra

import (
	_ "embed"
	"encoding/json"
	"mime"
	"path/filepath"
	"strings"
)

//go:embed formats.json
var manifest []byte

type formatGroup struct {
	Kind       string   `json:"kind"`
	Extensions []string `json:"extensions"`
	MimeTypes  []string `json:"mime_types"`
}

// Format identifies a renderer and a safe suffix for its temporary input file.
type Format struct {
	Kind      string
	Extension string
}

var groups = func() []formatGroup {
	var formats []formatGroup
	if err := json.Unmarshal(manifest, &formats); err != nil {
		panic(err)
	}
	return formats
}()

// Lookup also considers names because formats such as AI, RAW and font files
// are often reported as application/octet-stream or another generic MIME type.
// Ambiguous MIME types (PostScript, ZIP, RAR) never enable a provider on their own.
func Lookup(mimeType, filename string) (Format, bool) {
	mediaType, _, _ := mime.ParseMediaType(mimeType)
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == ".ts" && (strings.HasPrefix(mediaType, "text/") || mediaType == "application/typescript") {
		return Format{Kind: "text", Extension: ext}, true
	}
	if ext != "" {
		for _, group := range groups {
			for _, candidate := range group.Extensions {
				if ext == candidate {
					return Format{Kind: group.Kind, Extension: ext}, true
				}
			}
		}
		// Do not interpret excluded formats as an extensionless supported file.
		switch ext {
		case ".eps", ".ps", ".stl", ".obj", ".gltf", ".glb":
			return Format{}, false
		}
	}
	for _, group := range groups {
		for _, candidate := range group.MimeTypes {
			if mediaType == candidate {
				// Prefer the system's matching extension where a MIME group contains
				// different containers, e.g. OTF versus WOFF2 or Word versus Excel.
				for _, extension := range group.Extensions {
					if resolved, _, _ := mime.ParseMediaType(mime.TypeByExtension(extension)); resolved == mediaType {
						return Format{Kind: group.Kind, Extension: extension}, true
					}
				}
				return Format{Kind: group.Kind, Extension: group.Extensions[0]}, true
			}
		}
	}
	return Format{}, false
}
