//go:build !windows

package workflow

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	gateway "github.com/cs3org/go-cs3apis/cs3/gateway/v1beta1"
	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	"github.com/opencloud-eu/opencloud/pkg/log"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/dav/requests"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail/cache"
	revactx "github.com/opencloud-eu/reva/v2/pkg/ctx"
	"github.com/opencloud-eu/reva/v2/pkg/rgrpc/todo/pool"
	"google.golang.org/grpc"
	grpcmetadata "google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

type extraStater func(context.Context, *provider.Reference, string) (*provider.StatResponse, error)

func (f extraStater) Stat(ctx context.Context, ref *provider.Reference, auth string) (*provider.StatResponse, error) {
	return f(ctx, ref, auth)
}

type extraDownloader func(context.Context, *provider.Reference, string) (io.ReadCloser, error)

func (f extraDownloader) DownloadStream(ctx context.Context, ref *provider.Reference, auth string) (io.ReadCloser, error) {
	return f(ctx, ref, auth)
}

type extraCache struct {
	cache.ThumbnailCache
	events *[]string
}

func (c extraCache) Get(key string) ([]byte, error) {
	*c.events = append(*c.events, "cache")
	return c.ThumbnailCache.Get(key)
}

func extraFixture(t *testing.T) (*ThumbnailWorkflow, *requests.ThumbnailRequest, *provider.ResourceInfo, *[]string) {
	t.Helper()
	events := []string{}
	info := &provider.ResourceInfo{
		Id:   &provider.ResourceId{StorageId: "storage", SpaceId: "space", OpaqueId: "file"},
		Type: provider.ResourceType_RESOURCE_TYPE_FILE, Name: "picture.png", MimeType: "image/png", Etag: "revision-1", Size: 16,
		PermissionSet: &provider.ResourcePermissions{InitiateFileDownload: true},
	}
	renderer := filepath.Join(t.TempDir(), "renderer")
	if err := os.WriteFile(renderer, []byte("#!/bin/sh\nset -eu\ntest \"$7\" = --metadata\nprintf '{\"schemaVersion\":1,\"width\":2400,\"height\":1600}' > \"$6\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	w, err := NewWorkflow(
		WithGeneratorURL("http://unused.invalid"), WithSourceTypes(thumbnail.NewSourceTypes(nil)),
		WithCache(extraCache{cache.NewFileCache(t.TempDir()), &events}), WithMaxInputSize(100),
		WithExtraRenderer(renderer, time.Second, 1),
		WithStater(extraStater(func(ctx context.Context, ref *provider.Reference, auth string) (*provider.StatResponse, error) {
			events = append(events, "stat")
			if auth != "source-auth" || ref.GetPath() != "/picture.png" {
				t.Errorf("source authorization or reference changed: %q %v", auth, ref)
			}
			return &provider.StatResponse{Info: info}, nil
		})),
		WithFileDownloader(extraDownloader(func(ctx context.Context, _ *provider.Reference, auth string) (io.ReadCloser, error) {
			events = append(events, "download")
			if auth != "source-auth" || ctx.Err() != nil {
				t.Errorf("download lost request context or authorization")
			}
			return io.NopCloser(strings.NewReader("source contents")), nil
		})),
	)
	if err != nil {
		t.Fatal(err)
	}
	tr := &requests.ThumbnailRequest{Ref: &provider.Reference{Path: "/picture.png"}, Filename: "picture.png", Processor: extra.MetadataProcessor, Width: 1, Height: 1}
	return w, tr, info, &events
}

func TestMetadataPermissionBeforeCache(t *testing.T) {
	w, tr, info, events := extraFixture(t)
	first, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger())
	if err != nil || first.ContentType != "application/json" || !bytes.Contains(first.Data, []byte(`"width":2400`)) {
		t.Fatalf("source metadata missing: %s %v", first.Data, err)
	}
	*events = nil
	cached, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger())
	if err != nil || !bytes.Equal(first.Data, cached.Data) || !reflect.DeepEqual(*events, []string{"stat", "cache"}) {
		t.Fatalf("cache skipped source authorization: %v %v", *events, err)
	}
	info.PermissionSet.InitiateFileDownload = false
	*events = nil
	if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); !errors.Is(err, ErrPermissionDenied) || !reflect.DeepEqual(*events, []string{"stat"}) {
		t.Fatalf("permission denial accessed cached data: %v %v", *events, err)
	}
}

func TestMetadataCacheIdentity(t *testing.T) {
	w, tr, info, events := extraFixture(t)
	if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); err != nil {
		t.Fatal(err)
	}
	original := proto.Clone(info).(*provider.ResourceInfo)
	for name, change := range map[string]func(*provider.ResourceInfo){
		"resource": func(i *provider.ResourceInfo) { i.Id.OpaqueId = "other" },
		"space":    func(i *provider.ResourceInfo) { i.Id.SpaceId = "other" },
		"revision": func(i *provider.ResourceInfo) { i.Etag = "other" },
		"name":     func(i *provider.ResourceInfo) { i.Name = "renamed.png" },
		"mime":     func(i *provider.ResourceInfo) { i.MimeType = "image/jpeg" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := proto.Clone(original).(*provider.ResourceInfo)
			change(changed)
			proto.Reset(info)
			proto.Merge(info, changed)
			*events = nil
			if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); err != nil || !reflect.DeepEqual(*events, []string{"stat", "cache", "download"}) {
				t.Fatalf("different source reused stale metadata: %v %v", *events, err)
			}
		})
	}
}

func TestMetadataInvalidDimensionsSkipCache(t *testing.T) {
	w, tr, _, events := extraFixture(t)
	for _, size := range [][2]int32{{0, 1}, {2, 1}, {1, 0}, {1, 2}} {
		tr.Width, tr.Height = size[0], size[1]
		*events = nil
		if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); !errors.Is(err, ErrInvalidMetadataRequest) || !reflect.DeepEqual(*events, []string{"stat"}) {
			t.Fatalf("invalid dimensions reached cache: %v %v", *events, err)
		}
	}
}

func TestMetadataUnsupportedSourceSkipsDownload(t *testing.T) {
	w, tr, info, events := extraFixture(t)
	info.Name, info.MimeType = "notes.docx", "application/octet-stream"
	got, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger())
	if err != nil || string(got.Data) != `{"schemaVersion":1}` || !reflect.DeepEqual(*events, []string{"stat", "cache"}) {
		t.Fatalf("unsupported metadata source downloaded: %s %v %v", got.Data, *events, err)
	}
}

func TestMetadataDeadlineCoversSource(t *testing.T) {
	for _, phase := range []string{"stat", "download"} {
		t.Run(phase, func(t *testing.T) {
			w, tr, _, _ := extraFixture(t)
			WithExtraRenderer(w.extraRenderer, 30*time.Millisecond, 1)(w)
			block := func(ctx context.Context) error {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("source request has no deadline")
				}
				<-ctx.Done()
				return ctx.Err()
			}
			if phase == "stat" {
				w.stater = extraStater(func(ctx context.Context, _ *provider.Reference, _ string) (*provider.StatResponse, error) {
					return nil, block(ctx)
				})
			} else {
				w.fileDownloader = extraDownloader(func(ctx context.Context, _ *provider.Reference, _ string) (io.ReadCloser, error) {
					return nil, block(ctx)
				})
			}
			if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline did not cover %s: %v", phase, err)
			}
		})
	}
}

func TestExtraConcurrencyBoundsDownloads(t *testing.T) {
	w, tr, _, _ := extraFixture(t)
	w.cache = cache.NewInMemoryCache()
	entered, release := make(chan struct{}), make(chan struct{})
	var downloads atomic.Int32
	w.fileDownloader = extraDownloader(func(ctx context.Context, _ *provider.Reference, _ string) (io.ReadCloser, error) {
		if downloads.Add(1) == 1 {
			close(entered)
		}
		select {
		case <-release:
			return io.NopCloser(strings.NewReader("source")), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	first := make(chan error, 1)
	go func() {
		_, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger())
		first <- err
	}()
	select {
	case <-entered:
	case err := <-first:
		t.Fatalf("first source did not start: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := w.Execute(ctx, tr, "source-auth", log.NopLogger())
	close(release)
	if !errors.Is(err, context.DeadlineExceeded) || downloads.Load() != 1 {
		t.Fatalf("queued request downloaded another source: downloads=%d error=%v", downloads.Load(), err)
	}
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	// Force another conversion to verify the completed request released its slot.
	w.cache = cache.NewInMemoryCache()
	if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); err != nil || downloads.Load() != 2 {
		t.Fatalf("completed request retained its slot: %v", err)
	}
}

func TestMetadataUnavailableSourceIsNotServerFailure(t *testing.T) {
	w, tr, _, _ := extraFixture(t)
	w.fileDownloader = extraDownloader(func(context.Context, *provider.Reference, string) (io.ReadCloser, error) {
		return nil, errors.New("source unavailable")
	})
	if _, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unavailable metadata source did not preserve 404: %v", err)
	}
}

func TestExtraPreviewReachesGeneratorAtFullSize(t *testing.T) {
	w, tr, info, _ := extraFixture(t)
	info.Name, info.MimeType = "artwork.psd", "application/octet-stream"
	info.Checksum = &provider.ResourceChecksum{Sum: "same-content"}
	renderer := filepath.Join(t.TempDir(), "renderer")
	if err := os.WriteFile(renderer, []byte("#!/bin/sh\nset -eu\ntest \"$8\" -eq 2048\ncp \"$4\" \"$6\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	WithExtraRenderer(renderer, time.Second, 1)(w)
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewRGBA(image.Rect(0, 0, 2048, 1280))); err != nil {
		t.Fatal(err)
	}
	w.maxInputSize = uint64(source.Len())
	w.fileDownloader = extraDownloader(func(context.Context, *provider.Reference, string) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(source.Bytes())), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "2048x2048") || !strings.Contains(r.URL.Path, "fit-in") {
			t.Errorf("full preview dimensions or fit operation lost: %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, _, err := r.FormFile("image")
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		rw.Header().Set("Content-Type", "image/jpeg")
		_, _ = io.Copy(rw, f)
	}))
	defer server.Close()
	w.generatorURL = server.URL
	tr.Processor, tr.Width, tr.Height = "fit", 2048, 2048
	got, err := w.Execute(context.Background(), tr, "source-auth", log.NopLogger())
	if err != nil {
		t.Fatal(err)
	}
	dimensions, err := png.DecodeConfig(bytes.NewReader(got.Data))
	if err != nil || dimensions.Width != 2048 || dimensions.Height != 1280 {
		t.Fatalf("full source preview was reduced or cropped: %v %v", dimensions, err)
	}
}

type extraDownloadGateway struct {
	gateway.GatewayAPIClient
	endpoint string
	t        *testing.T
}

func (g extraDownloadGateway) InitiateFileDownload(ctx context.Context, _ *provider.InitiateFileDownloadRequest, _ ...grpc.CallOption) (*gateway.InitiateFileDownloadResponse, error) {
	md, _ := grpcmetadata.FromOutgoingContext(ctx)
	if !reflect.DeepEqual(md.Get(revactx.TokenHeader), []string{"source-auth"}) {
		g.t.Error("source initiation lost authorization")
	}
	return &gateway.InitiateFileDownloadResponse{Protocols: []*gateway.FileDownloadProtocol{{Protocol: "simple", DownloadEndpoint: g.endpoint}}}, nil
}

type extraDownloadSelector struct{ client gateway.GatewayAPIClient }

func (s extraDownloadSelector) Next(...pool.Option) (gateway.GatewayAPIClient, error) {
	return s.client, nil
}

func TestSourceDownloadPreservesRequestCancellation(t *testing.T) {
	stopped, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get(revactx.TokenHeader) != "source-auth" {
			t.Error("source data request lost authorization")
		}
		rw.WriteHeader(http.StatusOK)
		rw.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			close(stopped)
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	source := NewGatewayFileDownloader(extraDownloadSelector{extraDownloadGateway{endpoint: server.URL, t: t}}, server.Client())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body, err := source.DownloadStream(ctx, &provider.Reference{Path: "/source.png"}, "source-auth")
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	read := make(chan error, 1)
	go func() { _, err := io.ReadAll(body); read <- err }()
	cancel()
	select {
	case err := <-read:
		if err == nil {
			t.Fatal("cancelled source read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("source read ignored request cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("source HTTP request did not receive cancellation")
	}
}
