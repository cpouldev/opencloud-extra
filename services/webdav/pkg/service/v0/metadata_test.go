package svc

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/opencloud-eu/opencloud/pkg/log"
	thumbnailssvc "github.com/opencloud-eu/opencloud/protogen/gen/opencloud/services/thumbnails/v0"
)

func TestMetadataResponsePreservesHeaders(t *testing.T) {
	data := `{"schemaVersion":1,"width":2400}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Transfer-Token") != "authorized-transfer" {
			t.Error("data request lost transfer authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = io.WriteString(w, data)
	}))
	defer server.Close()
	svc := Webdav{log: log.NewLogger()}
	writer := httptest.NewRecorder()
	svc.sendThumbnailResponse(&thumbnailssvc.GetThumbnailResponse{DataEndpoint: server.URL, TransferToken: "authorized-transfer"}, writer, httptest.NewRequest(http.MethodGet, "/dav/file?preview=1&processor=extra-metadata-v1&x=1&y=1", nil))
	rsp := writer.Result()
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK || rsp.Header.Get("Content-Type") != "application/json" || rsp.Header.Get("X-Content-Type-Options") != "nosniff" || rsp.Header.Get("Content-Length") != strconv.Itoa(len(data)) {
		t.Fatalf("headers were not committed before body: %#v", rsp.Header)
	}
	body, err := io.ReadAll(rsp.Body)
	if err != nil || string(body) != data {
		t.Fatalf("metadata body changed: %s %v", body, err)
	}
}
