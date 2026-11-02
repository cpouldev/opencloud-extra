package svc

import (
	"testing"

	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	libregraph "github.com/opencloud-eu/libre-graph-api-go"

	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail"
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
			}, "https://cloud.example.test", thumbnail.NewSourceTypes(nil))
			if (set != nil) != tc.preview {
				t.Fatalf("preview available = %v, want %v", set != nil, tc.preview)
			}
			item := libregraph.DriveItem{}
			item.SetName(tc.name)
			item.SetFile(libregraph.OpenGraphFile{MimeType: &tc.mime})
			setShareThumbnails(&item, "storage$space!file", "https://cloud.example.test", thumbnail.NewSourceTypes(nil))
			if (len(item.GetThumbnails()) > 0) != tc.preview {
				t.Fatalf("shared file preview available = %v, want %v", len(item.GetThumbnails()) > 0, tc.preview)
			}
		})
	}
}

func TestConfiguredPreviewMetadata(t *testing.T) {
	mimeType := "application/x-custom-preview"
	for _, tc := range []struct {
		name       string
		configured []string
		preview    bool
	}{
		{name: "unconfigured"},
		{name: "configured", configured: []string{mimeType}, preview: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sourceTypes := thumbnail.NewSourceTypes(tc.configured)
			set := previewThumbnailSet(&provider.ResourceInfo{
				Name: "custom.asset", MimeType: mimeType,
				Id: &provider.ResourceId{StorageId: "storage", SpaceId: "space", OpaqueId: "file"},
			}, "https://cloud.example.test", sourceTypes)
			if (set != nil) != tc.preview {
				t.Fatalf("preview available = %v, want %v", set != nil, tc.preview)
			}
			item := libregraph.DriveItem{}
			item.SetName("custom.asset")
			item.SetFile(libregraph.OpenGraphFile{MimeType: &mimeType})
			setShareThumbnails(&item, "storage$space!file", "https://cloud.example.test", sourceTypes)
			if (len(item.GetThumbnails()) > 0) != tc.preview {
				t.Fatalf("shared file preview available = %v, want %v", len(item.GetThumbnails()) > 0, tc.preview)
			}
		})
	}
}
