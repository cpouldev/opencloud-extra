package svc

import (
	"testing"

	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	libregraph "github.com/opencloud-eu/libre-graph-api-go"
)

func TestExtraPreviewMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, mime string
		preview    bool
	}{
		{"typeface.woff2", "application/octet-stream", true},
		{"drawing.ai", "application/postscript", true},
		{"movie.mp4", "video/mp4", true},
		{"print.eps", "application/postscript", false},
		{"backup.zip", "application/zip", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			set := previewThumbnailSet(&provider.ResourceInfo{
				Name: tc.name, MimeType: tc.mime,
				Id: &provider.ResourceId{StorageId: "storage", SpaceId: "space", OpaqueId: "file"},
			}, "https://cloud.example.test")
			if (set != nil) != tc.preview {
				t.Fatalf("preview available = %v, want %v", set != nil, tc.preview)
			}
			item := libregraph.DriveItem{}
			item.SetName(tc.name)
			item.SetFile(libregraph.OpenGraphFile{MimeType: &tc.mime})
			setShareThumbnails(&item, "storage$space!file", "https://cloud.example.test")
			if (len(item.GetThumbnails()) > 0) != tc.preview {
				t.Fatalf("shared file preview available = %v, want %v", len(item.GetThumbnails()) > 0, tc.preview)
			}
		})
	}
}
