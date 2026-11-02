//go:build !windows

package svc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	gateway "github.com/cs3org/go-cs3apis/cs3/gateway/v1beta1"
	rpc "github.com/cs3org/go-cs3apis/cs3/rpc/v1beta1"
	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	"github.com/go-chi/chi/v5"
	"github.com/opencloud-eu/opencloud/pkg/log"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/config"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/dav/requests"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail/cache"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail/workflow"
	"github.com/opencloud-eu/reva/v2/pkg/rgrpc/todo/pool"
	"google.golang.org/grpc"
)

type metadataResponseSource struct{}

func (metadataResponseSource) Stat(context.Context, *provider.Reference, string) (*provider.StatResponse, error) {
	return &provider.StatResponse{Info: &provider.ResourceInfo{
		Name: "source.png", MimeType: "image/png", Etag: "revision",
		PermissionSet: &provider.ResourcePermissions{InitiateFileDownload: true},
	}}, nil
}

func (metadataResponseSource) DownloadStream(context.Context, *provider.Reference, string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("source")), nil
}

func TestMetadataResponsePreservesHeaders(t *testing.T) {
	renderer := filepath.Join(t.TempDir(), "renderer")
	if err := os.WriteFile(renderer, []byte("#!/bin/sh\nprintf '{\"schemaVersion\":1,\"width\":2400}' > \"$6\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	wf, err := workflow.NewWorkflow(
		workflow.WithGeneratorURL("http://unused.invalid"),
		workflow.WithStater(metadataResponseSource{}), workflow.WithFileDownloader(metadataResponseSource{}),
		workflow.WithExtraRenderer(renderer, time.Second, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	svc := Webdav{log: log.NopLogger(), workflow: wf}
	writer := httptest.NewRecorder()
	svc.writeThumbnail(writer, httptest.NewRequest(http.MethodGet, "/dav/file?preview=1&processor=extra-metadata-v1&x=1&y=1", nil),
		&requests.ThumbnailRequest{Ref: &provider.Reference{Path: "/source.png"}, Processor: extra.MetadataProcessor, Width: 1, Height: 1}, "auth", log.NopLogger())
	data := writer.Body.String()
	if writer.Code != http.StatusOK || writer.Header().Get("Content-Type") != "application/json" || writer.Header().Get("X-Content-Type-Options") != "nosniff" || writer.Header().Get("Content-Length") != strconv.Itoa(len(data)) || !strings.Contains(data, `"width":2400`) {
		t.Fatalf("metadata response lost headers or source dimensions: %d %#v %s", writer.Code, writer.Header(), data)
	}
}

func TestMetadataErrorsPreserveStatusWithoutDetails(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"permission", workflow.ErrPermissionDenied, http.StatusForbidden},
		{"source size", extra.ErrImageTooLarge, http.StatusRequestEntityTooLarge},
		{"stat size", workflow.ErrImageTooLarge, http.StatusRequestEntityTooLarge},
		{"dimensions", workflow.ErrInvalidMetadataRequest, http.StatusBadRequest},
		{"deadline", context.DeadlineExceeded, http.StatusRequestTimeout},
		{"missing", workflow.ErrNotFound, http.StatusNotFound},
		{"storage", errors.New("failure"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writer := httptest.NewRecorder()
			err := fmt.Errorf("private /internal/filename: %w", tc.err)
			Webdav{}.handleWorkflowError(writer, httptest.NewRequest(http.MethodGet, "/dav/file", nil), err,
				&requests.ThumbnailRequest{Processor: extra.MetadataProcessor}, log.NopLogger(), "metadata")
			if writer.Code != tc.status || strings.Contains(writer.Body.String(), "private") || strings.Contains(writer.Body.String(), "internal/") {
				t.Fatalf("incorrect or unsafe metadata error: %d %s", writer.Code, writer.Body)
			}
		})
	}
}

type publicMetadataGateway struct {
	gateway.GatewayAPIClient
	authenticate func(context.Context, *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error)
}

func (g publicMetadataGateway) Authenticate(ctx context.Context, req *gateway.AuthenticateRequest, _ ...grpc.CallOption) (*gateway.AuthenticateResponse, error) {
	return g.authenticate(ctx, req)
}

type publicMetadataSelector struct{ client gateway.GatewayAPIClient }

func (s publicMetadataSelector) Next(...pool.Option) (gateway.GatewayAPIClient, error) {
	return s.client, nil
}

type publicMetadataSource struct {
	metadataResponseSource
	t      *testing.T
	events *[]string
}

func (s publicMetadataSource) checkAuthorization(ref *provider.Reference, auth string) {
	s.t.Helper()
	if auth != "public-auth" || ref.GetPath() != "/public/token/source.png" {
		s.t.Fatalf("public metadata source escaped its share authorization: %q %v", auth, ref)
	}
}

func (s publicMetadataSource) Stat(ctx context.Context, ref *provider.Reference, auth string) (*provider.StatResponse, error) {
	*s.events = append(*s.events, "stat")
	s.checkAuthorization(ref, auth)
	return s.metadataResponseSource.Stat(ctx, ref, auth)
}

func (s publicMetadataSource) DownloadStream(ctx context.Context, ref *provider.Reference, auth string) (io.ReadCloser, error) {
	*s.events = append(*s.events, "download")
	s.checkAuthorization(ref, auth)
	return s.metadataResponseSource.DownloadStream(ctx, ref, auth)
}

type publicMetadataCache struct {
	cache.ThumbnailCache
	events *[]string
}

func (c publicMetadataCache) Get(key string) ([]byte, error) {
	*c.events = append(*c.events, "cache")
	return c.ThumbnailCache.Get(key)
}

func TestPublicMetadataAuthenticatesBeforeCachedResponse(t *testing.T) {
	events := []string{}
	status := rpc.Code_CODE_OK
	client := &publicMetadataGateway{authenticate: func(_ context.Context, req *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error) {
		events = append(events, "auth")
		if req.GetType() != "publicshares" || req.GetClientId() != "token" || req.GetClientSecret() != "signature|signed|1234" {
			t.Fatalf("signed public authorization changed: %v", req)
		}
		return &gateway.AuthenticateResponse{Status: &rpc.Status{Code: status}, Token: "public-auth"}, nil
	}}
	renderer := filepath.Join(t.TempDir(), "renderer")
	if err := os.WriteFile(renderer, []byte("#!/bin/sh\nprintf '{\"schemaVersion\":1,\"width\":2400}' > \"$6\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	source := publicMetadataSource{t: t, events: &events}
	wf, err := workflow.NewWorkflow(
		workflow.WithGeneratorURL("http://unused.invalid"),
		workflow.WithStater(source), workflow.WithFileDownloader(source),
		workflow.WithCache(publicMetadataCache{ThumbnailCache: cache.NewInMemoryCache(), events: &events}),
		workflow.WithExtraRenderer(renderer, time.Second, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	svc := Webdav{
		config: &config.Config{}, log: log.NopLogger(), workflow: wf,
		gatewaySelector: publicMetadataSelector{client: client},
	}
	router := chi.NewRouter()
	router.With(svc.DavPublicContext()).Get("/dav/public-files/{token}/*", svc.PublicThumbnail)
	request := func() *httptest.ResponseRecorder {
		writer := httptest.NewRecorder()
		router.ServeHTTP(writer, httptest.NewRequest(http.MethodGet,
			"/dav/public-files/token/source.png?preview=1&processor=extra-metadata-v1&x=1&y=1&signature=signed&expiration=1234", nil))
		return writer
	}
	first := request()
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"width":2400`) {
		t.Fatalf("could not warm public metadata cache: %d %s", first.Code, first.Body)
	}
	if !reflect.DeepEqual(events, []string{"auth", "stat", "cache", "download"}) {
		t.Fatalf("public metadata generation bypassed authorization: %v", events)
	}
	events = nil
	second := request()
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() || !reflect.DeepEqual(events, []string{"auth", "stat", "cache"}) {
		t.Fatalf("public cache hit bypassed authorization or downloaded again: %d %s %v", second.Code, second.Body, events)
	}
	for _, tc := range []struct {
		name   string
		code   rpc.Code
		status int
	}{
		{"denied", rpc.Code_CODE_PERMISSION_DENIED, http.StatusNotFound},
		{"unauthenticated", rpc.Code_CODE_UNAUTHENTICATED, http.StatusNotFound},
		{"expired", rpc.Code_CODE_FAILED_PRECONDITION, http.StatusGone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status = tc.code
			events = nil
			response := request()
			if response.Code != tc.status || strings.Contains(response.Body.String(), `"width":2400`) {
				t.Fatalf("invalid public link exposed cached metadata: %d %s", response.Code, response.Body)
			}
			if !reflect.DeepEqual(events, []string{"auth"}) {
				t.Fatalf("invalid public link accessed its source or metadata cache: %v", events)
			}
		})
	}
	t.Run("authentication deadline", func(t *testing.T) {
		events = nil
		svc.config.Thumbnails.ExtraTimeout = 30 * time.Millisecond
		client.authenticate = func(ctx context.Context, _ *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error) {
			events = append(events, "auth")
			if _, ok := ctx.Deadline(); !ok {
				return nil, errors.New("public metadata authentication has no deadline")
			}
			<-ctx.Done()
			return nil, ctx.Err()
		}
		response := request()
		if response.Code != http.StatusRequestTimeout || strings.Contains(response.Body.String(), `"width":2400`) {
			t.Fatalf("public metadata authentication ignored its deadline: %d %s", response.Code, response.Body)
		}
		if !reflect.DeepEqual(events, []string{"auth"}) {
			t.Fatalf("expired metadata request accessed its source or cache: %v", events)
		}
	})
}
