package workflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/dav/requests"
)

var ErrInvalidMetadataRequest = errors.New("asset information requires dimensions 1x1")

// WithExtraRenderer configures the downstream subprocess and bounds concurrent
// downloads and conversions before they reach the thumbnail generator.
func WithExtraRenderer(command string, timeout time.Duration, maxConcurrent int) Option {
	return func(w *ThumbnailWorkflow) {
		w.extraRenderer = command
		w.extraTimeout = timeout
		if maxConcurrent <= 0 {
			maxConcurrent = 2
		}
		w.extraSlots = make(chan struct{}, maxConcurrent)
	}
}

func (w *ThumbnailWorkflow) renderExtra(ctx context.Context, ref *provider.Reference, auth string, format extra.Format, targetSize int, metadata bool) ([]byte, error) {
	if w.extraSlots != nil {
		select {
		case w.extraSlots <- struct{}{}:
			defer func() { <-w.extraSlots }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	body, err := w.fileDownloader.DownloadStream(ctx, ref, auth)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	renderer := extra.NewRenderer(format, extra.RendererOptions{
		Context: ctx, Command: w.extraRenderer, Timeout: w.extraTimeout,
		MaxInputBytes: w.maxInputSize, TargetSize: targetSize,
	})
	if metadata {
		return renderer.Metadata(body)
	}
	return renderer.Convert(body)
}

// metadataCacheKey includes identity, revision and filename even when storage
// supplies no checksum. Source values never become path components.
func metadataCacheKey(info *provider.ResourceInfo, source string) string {
	identity, _ := json.Marshal([]any{
		info.GetId().GetStorageId(), info.GetId().GetSpaceId(), info.GetId().GetOpaqueId(),
		info.GetPath(), source, info.GetEtag(), info.GetChecksum().GetType(), info.GetChecksum().GetSum(),
		info.GetMtime().GetSeconds(), info.GetMtime().GetNanos(), info.GetSize(), info.GetName(), info.GetMimeType(),
	})
	digest := sha256.Sum256(identity)
	return extra.MetadataCachePrefix + hex.EncodeToString(digest[:]) + "/metadata.json"
}

// metadata is called only after the workflow has authorized the source. That
// check precedes every cache read, including repeated public-link requests.
func (w *ThumbnailWorkflow) metadata(ctx context.Context, ref *provider.Reference, auth string, tr *requests.ThumbnailRequest, info *provider.ResourceInfo) (Thumbnail, error) {
	if tr.Width != 1 || tr.Height != 1 {
		return Thumbnail{}, ErrInvalidMetadataRequest
	}
	if err := ctx.Err(); err != nil {
		return Thumbnail{}, err
	}
	key := metadataCacheKey(info, ref.GetPath())
	if w.cache != nil {
		if data, err := w.cache.Get(key); err == nil {
			if data, err = extra.ValidateMetadata(data); err == nil {
				return Thumbnail{Data: data, ContentType: "application/json"}, nil
			}
		}
	}
	data := []byte(`{"schemaVersion":1}`)
	if format, supported := extra.LookupMetadata(info.GetMimeType(), info.GetName()); supported {
		var err error
		data, err = w.renderExtra(ctx, ref, auth, format, 0, true)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, extra.ErrImageTooLarge) {
				return Thumbnail{}, err
			}
			return Thumbnail{}, fmt.Errorf("%w: %v", ErrNotFound, err)
		}
	}
	if err := ctx.Err(); err != nil {
		return Thumbnail{}, err
	}
	if w.cache != nil {
		if err := w.cache.Put(key, data); err != nil {
			return Thumbnail{}, err
		}
	}
	return Thumbnail{Data: data, ContentType: "application/json"}, nil
}
