package extra

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestMetadataSourceMapping(t *testing.T) {
	for _, tc := range []struct{ name, mime, kind, suffix string }{
		{"PHOTO.JPG", "application/octet-stream", "image", ".jpg"},
		{"art.psd", "application/octet-stream", "photoshop", ".psd"},
		{"art.ai", "application/postscript", "illustrator", ".ai"},
		{"clip.mp4", "video/mp4", "video", ".mp4"},
		{"file", "image/tiff", "image", ".tif"},
		{"font.woff2", "application/octet-stream", "font", ".woff2"},
		{"raw.cr2", "image/tiff", "raw", ".cr2"},
		{"notes.ts", "text/plain", "", ""},
		{"notes.docx", "application/octet-stream", "", ""},
		{"book.epub", "application/epub+zip", "", ""},
		{"art.kra", "application/x-krita", "", ""},
		{"art.eps", "image/png", "", ""},
		{"model.stl", "application/octet-stream", "", ""},
		{"unknown.xyz", "application/octet-stream", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := LookupMetadata(tc.mime, tc.name)
			if ok != (tc.kind != "") || ok && (got.Kind != tc.kind || got.Extension != tc.suffix) {
				t.Fatalf("unexpected metadata provider: %#v, %v", got, ok)
			}
		})
	}
}

func TestMetadataSchemaRejectsUntrustedOutput(t *testing.T) {
	for _, data := range []string{
		`null`, `[]`, `{}`, `{"schemaVersion":2}`, `{"schemaVersion":1} {}`,
		`{"schemaVersion":1,"inputPath":"/private/source"}`,
		`{"schemaVersion":1,"colorProfile":{"private":"value"}}`,
		`{"schemaVersion":1,"width":0}`, `{"schemaVersion":1,"height":-1}`,
		`{"schemaVersion":1,"width":1.5}`, `{"schemaVersion":1,"pages":"1"}`,
		`{"schemaVersion":1,"duration":null}`, `{"schemaVersion":1,"fontVariable":null}`,
		`{"schemaVersion":1,"fontFamily":null}`, `{"schemaVersion":1,"frameRate":1e1000}`,
		`{"schemaVersion":1,"height":9007199254740992}`,
	} {
		t.Run(data, func(t *testing.T) {
			if _, err := ValidateMetadata([]byte(data)); err == nil {
				t.Fatal("unsafe metadata was accepted")
			}
		})
	}
}

func TestMetadataSchemaSanitizesStrings(t *testing.T) {
	input, err := json.Marshal(map[string]any{
		"schemaVersion": 1, "fontFamily": " Ελλη\x00νικά\u202e ", "fontStyle": strings.Repeat("x", 513),
		"width": 2400, "height": 1600, "duration": 0, "glyphs": 0, "fontVariable": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := ValidateMetadata(input)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	if values["fontFamily"] != "Ελληνικά" || len(values["fontStyle"].(string)) != 512 || values["width"] != float64(2400) || values["fontVariable"] != false {
		t.Fatalf("invalid sanitized metadata: %s", data)
	}
}

func TestMetadataOutputSizeLimit(t *testing.T) {
	base := `{"schemaVersion":1}`
	for _, size := range []int{MetadataMaxOutputSize - 1, MetadataMaxOutputSize, MetadataMaxOutputSize + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			data := []byte(base + strings.Repeat(" ", size-len(base)))
			_, err := ValidateMetadata(data)
			if (err != nil) != (size > MetadataMaxOutputSize) {
				t.Fatalf("wrong result for %d-byte metadata: %v", size, err)
			}
		})
	}
}
