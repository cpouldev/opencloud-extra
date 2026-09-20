package extra

import "testing"

func TestLookup(t *testing.T) {
	for _, tc := range []struct {
		name, mime, filename, kind, extension string
	}{
		{"video", "video/mp4", "clip.mp4", "video", ".mp4"},
		{"uppercase RAW", "application/octet-stream", "photo.CR3", "raw", ".cr3"},
		{"AI reported as PostScript", "application/postscript", "drawing.ai", "illustrator", ".ai"},
		{"PostScript excluded", "application/postscript", "drawing.eps", "", ""},
		{"ambiguous PostScript", "application/postscript", "", "", ""},
		{"unknown binary", "application/octet-stream", "binary.exe", "", ""},
		{"generic ZIP excluded", "application/zip", "backup.zip", "", ""},
		{"creative ZIP", "application/zip", "drawing.kra", "archive", ".kra"},
		{"font binary", "application/octet-stream", "typeface.woff2", "font", ".woff2"},
		{"MIME parameters", "application/pdf; version=1.7", "", "pdf", ".pdf"},
		{"TypeScript", "text/plain", "index.ts", "text", ".ts"},
		{"transport stream", "video/mp2t", "clip.ts", "video", ".ts"},
		{"3D excluded", "model/gltf+json", "scene.gltf", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Lookup(tc.mime, tc.filename)
			if ok != (tc.kind != "") || got.Kind != tc.kind || got.Extension != tc.extension {
				t.Fatalf("Lookup(%q, %q) = %#v, %v", tc.mime, tc.filename, got, ok)
			}
		})
	}
}
