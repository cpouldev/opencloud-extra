package svc

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/opencloud-eu/opencloud/pkg/log"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/config"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail/storage"
)

func TestMetadataDataResponseHeaders(t *testing.T) {
	data := []byte(`{"schemaVersion":1,"width":2400}`)
	key := extra.MetadataCachePrefix + "hash/metadata.json"
	store := storage.NewFileSystemStorage(config.FileSystemStorage{RootDirectory: t.TempDir()}, log.NewLogger())
	if err := store.Put(key, data); err != nil {
		t.Fatal(err)
	}
	svc := Thumbnails{logger: log.NewLogger(), manager: thumbnail.NewSimpleManager(nil, store, log.NewLogger(), 0, 0)}
	req := httptest.NewRequest(http.MethodGet, "/data", nil)
	req = req.WithContext(context.WithValue(req.Context(), keyContextKey, key))
	writer := httptest.NewRecorder()
	svc.GetThumbnail(writer, req)
	rsp := writer.Result()
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK || rsp.Header.Get("Content-Type") != "application/json" || rsp.Header.Get("X-Content-Type-Options") != "nosniff" || rsp.Header.Get("Content-Length") != strconv.Itoa(len(data)) {
		t.Fatalf("headers were not committed before body: %#v", rsp.Header)
	}
	body, err := io.ReadAll(rsp.Body)
	if err != nil || string(body) != string(data) {
		t.Fatalf("metadata body changed: %s %v", body, err)
	}
}
