//go:build !windows

package svc

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	gateway "github.com/cs3org/go-cs3apis/cs3/gateway/v1beta1"
	rpc "github.com/cs3org/go-cs3apis/cs3/rpc/v1beta1"
	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	"github.com/golang-jwt/jwt/v5"
	"github.com/opencloud-eu/opencloud/pkg/log"
	thumbnailsmsg "github.com/opencloud-eu/opencloud/protogen/gen/opencloud/messages/thumbnails/v0"
	thumbnailssvc "github.com/opencloud-eu/opencloud/protogen/gen/opencloud/services/thumbnails/v0"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/config"
	terrors "github.com/opencloud-eu/opencloud/services/thumbnails/pkg/errors"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	tjwt "github.com/opencloud-eu/opencloud/services/thumbnails/pkg/service/jwt"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail/imgsource"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail/storage"
	revactx "github.com/opencloud-eu/reva/v2/pkg/ctx"
	"github.com/opencloud-eu/reva/v2/pkg/rgrpc/todo/pool"
	merrors "go-micro.dev/v4/errors"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

type metadataGateway struct {
	gateway.GatewayAPIClient
	stat func(context.Context, *provider.StatRequest) (*provider.StatResponse, error)
	auth func(context.Context, *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error)
}

func (g metadataGateway) Stat(ctx context.Context, req *provider.StatRequest, _ ...grpc.CallOption) (*provider.StatResponse, error) {
	return g.stat(ctx, req)
}
func (g metadataGateway) Authenticate(ctx context.Context, req *gateway.AuthenticateRequest, _ ...grpc.CallOption) (*gateway.AuthenticateResponse, error) {
	return g.auth(ctx, req)
}

type metadataSelector struct{ client gateway.GatewayAPIClient }

func (s metadataSelector) Next(_ ...pool.Option) (gateway.GatewayAPIClient, error) {
	return s.client, nil
}

type metadataSource func(context.Context, string) (io.ReadCloser, error)

func (s metadataSource) Get(ctx context.Context, path string) (io.ReadCloser, error) {
	return s(ctx, path)
}

type observedMetadataStorage struct {
	storage.Storage
	events *[]string
}

func (s observedMetadataStorage) Stat(key string) bool {
	*s.events = append(*s.events, "cache")
	return s.Storage.Stat(key)
}

func metadataFixture(t *testing.T, kind string) (Thumbnail, *thumbnailssvc.GetThumbnailRequest, *provider.ResourceInfo, *[]string) {
	t.Helper()
	events := []string{}
	info := &provider.ResourceInfo{
		Id:   &provider.ResourceId{StorageId: "storage", SpaceId: "space", OpaqueId: "file"},
		Type: provider.ResourceType_RESOURCE_TYPE_FILE, Name: "picture.png", MimeType: "image/png", Path: "/picture.png", Etag: "revision-1", Size: 16,
		PermissionSet: &provider.ResourcePermissions{InitiateFileDownload: true},
	}
	renderer := filepath.Join(t.TempDir(), "extractor")
	if err := os.WriteFile(renderer, []byte("#!/bin/sh\nset -eu\ntest \"$7\" = --metadata\nprintf '{\"schemaVersion\":1,\"width\":2400,\"height\":1600}' > \"$6\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	store := observedMetadataStorage{Storage: storage.NewFileSystemStorage(config.FileSystemStorage{RootDirectory: t.TempDir()}, log.NewLogger()), events: &events}
	client := metadataGateway{
		stat: func(ctx context.Context, req *provider.StatRequest) (*provider.StatResponse, error) {
			events = append(events, "stat")
			md, _ := metadata.FromOutgoingContext(ctx)
			if got := md.Get(revactx.TokenHeader); !reflect.DeepEqual(got, []string{"source-auth"}) {
				t.Errorf("source stat lost authorization: %v", got)
			}
			if kind == "public" && req.GetRef().GetPath() != "/public/link/picture.png" {
				t.Errorf("public stat escaped share: %v", req.GetRef())
			}
			return &provider.StatResponse{Status: &rpc.Status{Code: rpc.Code_CODE_OK}, Info: info}, nil
		},
		auth: func(_ context.Context, req *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error) {
			events = append(events, "auth")
			if req.GetClientId() != "link" || req.GetClientSecret() != "signature|signed|1234" {
				t.Errorf("public signature changed: %v", req)
			}
			return &gateway.AuthenticateResponse{Status: &rpc.Status{Code: rpc.Code_CODE_OK}, Token: "source-auth"}, nil
		},
	}
	source := metadataSource(func(ctx context.Context, path string) (io.ReadCloser, error) {
		events = append(events, "download")
		if kind == "public" {
			u, err := url.Parse(path)
			if err != nil || u.Query().Get("signature") != "signed" || u.Query().Get("expiration") != "1234" || u.Query().Has("preview") || u.Query().Has("processor") {
				t.Errorf("invalid signed download URL: %s", path)
			}
		} else if got, _ := imgsource.ContextGetAuthorization(ctx); got != "source-auth" {
			t.Errorf("download lost authorization: %s", got)
		}
		return io.NopCloser(strings.NewReader("source contents")), nil
	})
	svc := Thumbnail{
		serviceID: "test", selector: metadataSelector{client: client}, metadataStorage: store,
		cs3Source: source, webdavSource: source, transferSecret: "test-transfer-secret", dataEndpoint: "http://internal/data", logger: log.NewLogger(),
		manager:          thumbnail.NewSimpleManager(nil, store, log.NewLogger(), 0, 0),
		preprocessorOpts: PreprocessorOpts{ExtraRenderer: renderer, ExtraTimeout: 10 * time.Second, MaxInputBytes: 100},
	}
	req := &thumbnailssvc.GetThumbnailRequest{Processor: extra.MetadataProcessor, Width: 1, Height: 1, Filepath: "picture.png"}
	if kind == "cs3" {
		req.Source = &thumbnailssvc.GetThumbnailRequest_Cs3Source{Cs3Source: &thumbnailsmsg.CS3Source{Path: "/picture.png", Authorization: "source-auth"}}
	} else {
		req.Source = &thumbnailssvc.GetThumbnailRequest_WebdavSource{WebdavSource: &thumbnailsmsg.WebdavSource{
			Url:          "http://source/picture.png?preview=1&processor=extra-metadata-v1&signature=signed&expiration=1234",
			IsPublicLink: kind == "public", PublicLinkToken: "link", RevaAuthorization: "source-auth", WebdavAuthorization: "source-auth",
		}}
	}
	return svc, req, info, &events
}

func metadataTransferKey(t *testing.T, svc Thumbnail, req *thumbnailssvc.GetThumbnailRequest) string {
	t.Helper()
	rsp := &thumbnailssvc.GetThumbnailResponse{}
	if err := svc.GetThumbnail(context.Background(), req, rsp); err != nil {
		t.Fatal(err)
	}
	claims := &tjwt.ThumbnailClaims{}
	if _, err := jwt.ParseWithClaims(rsp.TransferToken, claims, func(*jwt.Token) (any, error) { return []byte(svc.transferSecret), nil }); err != nil {
		t.Fatal(err)
	}
	if rsp.DataEndpoint != svc.dataEndpoint {
		t.Fatal("metadata did not use existing data endpoint")
	}
	return claims.Key
}

func TestMetadataPermissionBeforeCache(t *testing.T) {
	for _, kind := range []string{"cs3", "webdav", "public"} {
		t.Run(kind, func(t *testing.T) {
			svc, req, info, events := metadataFixture(t, kind)
			key := metadataTransferKey(t, svc, req)
			data, err := svc.manager.GetThumbnail(key)
			if err != nil || !strings.Contains(string(data), `"width":2400`) {
				t.Fatalf("metadata missing from common storage: %s %v", data, err)
			}
			*events = nil
			if got := metadataTransferKey(t, svc, req); got != key {
				t.Fatal("unchanged metadata cache missed")
			}
			want := []string{"stat", "cache"}
			if kind == "public" {
				want = append([]string{"auth"}, want...)
			}
			if !reflect.DeepEqual(*events, want) {
				t.Fatalf("cache bypassed authorization: %v", *events)
			}
			info.PermissionSet.InitiateFileDownload = false
			*events = nil
			err = svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
			if merrors.FromError(err).Code != http.StatusForbidden {
				t.Fatalf("cached private data not denied: %v", err)
			}
			if !reflect.DeepEqual(*events, want[:len(want)-1]) {
				t.Fatalf("denied request accessed cache: %v", *events)
			}
		})
	}
}

func TestMetadataRevisionInvalidatesCache(t *testing.T) {
	svc, req, info, events := metadataFixture(t, "cs3")
	first := metadataTransferKey(t, svc, req)
	if info.GetChecksum().GetSum() != "" {
		t.Fatal("test requires empty checksum")
	}
	info.Etag = "revision-2"
	*events = nil
	second := metadataTransferKey(t, svc, req)
	if first == second || !reflect.DeepEqual(*events, []string{"stat", "cache", "download"}) {
		t.Fatalf("revision reused stale metadata: %v", *events)
	}
	info.Name = "renamed.png"
	if third := metadataTransferKey(t, svc, req); third == second {
		t.Fatal("filename change reused old metadata")
	}
	if !strings.HasPrefix(first, extra.MetadataCachePrefix) || !strings.HasSuffix(first, "/metadata.json") || strings.Contains(first, "picture") {
		t.Fatalf("unisolated cache key: %s", first)
	}
}

func TestMetadataCacheIdentity(t *testing.T) {
	info := &provider.ResourceInfo{
		Id:   &provider.ResourceId{StorageId: "store", SpaceId: "space", OpaqueId: "file"},
		Etag: "revision", Name: "picture.png", MimeType: "image/png",
		Checksum: &provider.ResourceChecksum{Sum: "../unsafe/checksum"},
	}
	key := metadataCacheKey(info, "/picture.png")
	if !regexp.MustCompile(`^extra-metadata-v1/[a-f0-9]{64}/metadata\.json$`).MatchString(key) {
		t.Fatalf("unsafe or unversioned cache key: %s", key)
	}
	for name, change := range map[string]func(*provider.ResourceInfo){
		"resource": func(i *provider.ResourceInfo) { i.Id.OpaqueId = "other" },
		"space":    func(i *provider.ResourceInfo) { i.Id.SpaceId = "other" },
		"revision": func(i *provider.ResourceInfo) { i.Etag = "other" },
		"checksum": func(i *provider.ResourceInfo) { i.Checksum.Sum = "other" },
		"name":     func(i *provider.ResourceInfo) { i.Name = "other.png" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := proto.Clone(info).(*provider.ResourceInfo)
			change(changed)
			if metadataCacheKey(changed, "/picture.png") == key {
				t.Fatal("different source reused metadata cache")
			}
		})
	}
}

func TestMetadataDimensionsRejectedBeforeCache(t *testing.T) {
	svc, req, _, events := metadataFixture(t, "cs3")
	_ = metadataTransferKey(t, svc, req)
	for _, dimensions := range [][2]int32{{0, 1}, {2, 1}, {1, 0}, {1, 2}} {
		req.Width, req.Height = dimensions[0], dimensions[1]
		*events = nil
		err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
		if err == nil || merrors.FromError(err).Code != http.StatusBadRequest || !reflect.DeepEqual(*events, []string{"stat"}) {
			t.Fatalf("invalid dimensions reached cache: %v %v", err, *events)
		}
	}
}

func TestMetadataStatDenialBeforeCache(t *testing.T) {
	svc, req, _, events := metadataFixture(t, "cs3")
	_ = metadataTransferKey(t, svc, req)
	for _, code := range []rpc.Code{rpc.Code_CODE_NOT_FOUND, rpc.Code_CODE_PERMISSION_DENIED} {
		*events = nil
		svc.selector = metadataSelector{client: metadataGateway{stat: func(context.Context, *provider.StatRequest) (*provider.StatResponse, error) {
			return &provider.StatResponse{Status: &rpc.Status{Code: code}}, nil
		}}}
		err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
		if err == nil || len(*events) != 0 {
			t.Fatalf("denied resource reached cache: %v %v", err, *events)
		}
	}
}

func TestMetadataUnsupportedSourceSkipsDownload(t *testing.T) {
	svc, req, info, events := metadataFixture(t, "cs3")
	info.Name, info.MimeType = "notes.docx", "application/octet-stream"
	key := metadataTransferKey(t, svc, req)
	data, err := svc.manager.GetThumbnail(key)
	if err != nil || string(data) != `{"schemaVersion":1}` || !reflect.DeepEqual(*events, []string{"stat", "cache"}) {
		t.Fatalf("unsupported file downloaded: %s %v %v", data, *events, err)
	}
}

func TestMetadataFailuresDoNotLeakDetails(t *testing.T) {
	for _, failure := range []string{"stat", "download", "renderer"} {
		t.Run(failure, func(t *testing.T) {
			svc, req, _, _ := metadataFixture(t, "cs3")
			switch failure {
			case "stat":
				svc.selector = metadataSelector{client: metadataGateway{stat: func(context.Context, *provider.StatRequest) (*provider.StatResponse, error) {
					return nil, errors.New("private /internal/filename")
				}}}
			case "download":
				svc.cs3Source = metadataSource(func(context.Context, string) (io.ReadCloser, error) {
					return nil, errors.New("private /internal/filename")
				})
			case "renderer":
				svc.preprocessorOpts.ExtraRenderer = "/private/internal/missing-renderer"
			}
			err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
			if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "internal/") {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
}

func TestMetadataStatCancellation(t *testing.T) {
	svc, req, _, events := metadataFixture(t, "cs3")
	svc.selector = metadataSelector{client: metadataGateway{stat: func(ctx context.Context, _ *provider.StatRequest) (*provider.StatResponse, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := svc.GetThumbnail(ctx, req, &thumbnailssvc.GetThumbnailResponse{}); err == nil || len(*events) != 0 {
		t.Fatalf("cancelled stat accessed data: %v %v", err, *events)
	}
}

func TestMetadataTimeoutIncludesSource(t *testing.T) {
	for _, phase := range []string{"stat", "download"} {
		t.Run(phase, func(t *testing.T) {
			svc, req, _, _ := metadataFixture(t, "cs3")
			svc.preprocessorOpts.ExtraTimeout = 50 * time.Millisecond
			block := func(ctx context.Context) error {
				if _, ok := ctx.Deadline(); !ok {
					return errors.New("source has no deadline")
				}
				<-ctx.Done()
				return ctx.Err()
			}
			if phase == "stat" {
				svc.selector = metadataSelector{client: metadataGateway{stat: func(ctx context.Context, _ *provider.StatRequest) (*provider.StatResponse, error) {
					return nil, block(ctx)
				}}}
			} else {
				svc.cs3Source = metadataSource(func(ctx context.Context, _ string) (io.ReadCloser, error) { return nil, block(ctx) })
			}
			err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
			if err == nil || merrors.FromError(err).Code != http.StatusRequestTimeout {
				t.Fatalf("metadata deadline did not cover %s: %v", phase, err)
			}
		})
	}
}

func TestMetadataOversizedSourceIsNotPermissionDenial(t *testing.T) {
	svc, req, _, _ := metadataFixture(t, "cs3")
	svc.cs3Source = metadataSource(func(context.Context, string) (io.ReadCloser, error) { return nil, terrors.ErrImageTooLarge })
	err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
	if err == nil || merrors.FromError(err).Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized source has incorrect status: %v", err)
	}
}

func TestMetadataRejectsInvalidPublicAuthentication(t *testing.T) {
	svc, req, _, events := metadataFixture(t, "public")
	svc.selector = metadataSelector{client: metadataGateway{auth: func(context.Context, *gateway.AuthenticateRequest) (*gateway.AuthenticateResponse, error) {
		return &gateway.AuthenticateResponse{Status: &rpc.Status{Code: rpc.Code_CODE_PERMISSION_DENIED}}, nil
	}}}
	err := svc.GetThumbnail(context.Background(), req, &thumbnailssvc.GetThumbnailResponse{})
	if merrors.FromError(err).Code != http.StatusForbidden || len(*events) != 0 {
		t.Fatalf("unauthenticated public link accessed data: %v %v", err, *events)
	}
}
