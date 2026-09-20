package imgsource

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	gateway "github.com/cs3org/go-cs3apis/cs3/gateway/v1beta1"
	rpc "github.com/cs3org/go-cs3apis/cs3/rpc/v1beta1"
	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	revactx "github.com/opencloud-eu/reva/v2/pkg/ctx"
	"github.com/opencloud-eu/reva/v2/pkg/rgrpc/todo/pool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type cancellationGateway struct {
	gateway.GatewayAPIClient
	stat     func(context.Context) (*provider.StatResponse, error)
	initiate func(context.Context) (*gateway.InitiateFileDownloadResponse, error)
}

func (g cancellationGateway) Stat(ctx context.Context, _ *provider.StatRequest, _ ...grpc.CallOption) (*provider.StatResponse, error) {
	return g.stat(ctx)
}
func (g cancellationGateway) InitiateFileDownload(ctx context.Context, _ *provider.InitiateFileDownloadRequest, _ ...grpc.CallOption) (*gateway.InitiateFileDownloadResponse, error) {
	return g.initiate(ctx)
}

type cancellationSelector struct{ client gateway.GatewayAPIClient }

func (s cancellationSelector) Next(_ ...pool.Option) (gateway.GatewayAPIClient, error) {
	return s.client, nil
}

func cancellationStat(context.Context) (*provider.StatResponse, error) {
	return &provider.StatResponse{Status: &rpc.Status{Code: rpc.Code_CODE_OK}, Info: &provider.ResourceInfo{Size: 10}}, nil
}

func TestSourceCancellationWhileWaitingForHeaders(t *testing.T) {
	for _, kind := range []string{"webdav", "cs3"} {
		t.Run(kind, func(t *testing.T) {
			started, stopped := make(chan struct{}), make(chan struct{})
			abort := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-r.Context().Done():
					close(stopped)
				case <-abort:
				}
			}))
			defer server.Close()
			defer close(abort)
			var source Source = WebDav{maxImageFileSize: 100}
			if kind == "cs3" {
				client := cancellationGateway{stat: cancellationStat, initiate: func(context.Context) (*gateway.InitiateFileDownloadResponse, error) {
					return &gateway.InitiateFileDownloadResponse{Status: &rpc.Status{Code: rpc.Code_CODE_OK}, Protocols: []*gateway.FileDownloadProtocol{{Protocol: "spaces", DownloadEndpoint: server.URL, Token: "transfer"}}}, nil
				}}
				source = CS3{maxImageFileSize: 100, gatewaySelector: cancellationSelector{client: client}}
			}
			ctx, cancel := context.WithCancel(ContextSetAuthorization(context.Background(), "authorization"))
			defer cancel()
			result := make(chan error, 1)
			go func() {
				body, err := source.Get(ctx, server.URL)
				if body != nil {
					_ = body.Close()
				}
				result <- err
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("source request never reached server")
			}
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("source ignored cancellation: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("source remained stuck waiting for response headers")
			}
			select {
			case <-stopped:
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled source request remained open")
			}
		})
	}
}

func TestCS3SourceCancellationDuringRPC(t *testing.T) {
	for _, phase := range []string{"stat", "initiate"} {
		t.Run(phase, func(t *testing.T) {
			started := make(chan struct{})
			abort := make(chan struct{})
			defer close(abort)
			block := func(ctx context.Context) error {
				md, _ := metadata.FromOutgoingContext(ctx)
				if value := md.Get(revactx.TokenHeader); len(value) != 1 || value[0] != "authorization" {
					t.Errorf("RPC lost authorization: %v", value)
				}
				close(started)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-abort:
					return context.Canceled
				}
			}
			client := cancellationGateway{
				stat: func(ctx context.Context) (*provider.StatResponse, error) {
					if phase == "stat" {
						return nil, block(ctx)
					}
					return cancellationStat(ctx)
				},
				initiate: func(ctx context.Context) (*gateway.InitiateFileDownloadResponse, error) { return nil, block(ctx) },
			}
			source := CS3{maxImageFileSize: 100, gatewaySelector: cancellationSelector{client: client}}
			ctx, cancel := context.WithCancel(ContextSetAuthorization(context.Background(), "authorization"))
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := source.Get(ctx, "/file.png"); result <- err }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("source RPC did not start")
			}
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("RPC cancellation lost: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("source RPC ignored cancellation")
			}
		})
	}
}
