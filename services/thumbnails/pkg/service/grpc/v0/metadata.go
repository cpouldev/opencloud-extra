package svc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"

	provider "github.com/cs3org/go-cs3apis/cs3/storage/provider/v1beta1"
	thumbnailssvc "github.com/opencloud-eu/opencloud/protogen/gen/opencloud/services/thumbnails/v0"
	terrors "github.com/opencloud-eu/opencloud/services/thumbnails/pkg/errors"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/preprocessor"
	"github.com/pkg/errors"
	merrors "go-micro.dev/v4/errors"
)

// metadataCacheKey includes identity, revision and name instead of relying on a
// possibly empty checksum. Hashing keeps all source values out of cache paths.
func metadataCacheKey(info *provider.ResourceInfo, source string) string {
	identity, _ := json.Marshal([]any{
		info.GetId().GetStorageId(), info.GetId().GetSpaceId(), info.GetId().GetOpaqueId(),
		info.GetPath(), source, info.GetEtag(), info.GetChecksum().GetType(), info.GetChecksum().GetSum(),
		info.GetMtime().GetSeconds(), info.GetMtime().GetNanos(), info.GetSize(), info.GetName(), info.GetMimeType(),
	})
	digest := sha256.Sum256(identity)
	return extra.MetadataCachePrefix + hex.EncodeToString(digest[:]) + "/metadata.json"
}

func (g Thumbnail) handleMetadata(ctx context.Context, req *thumbnailssvc.GetThumbnailRequest, info *provider.ResourceInfo, source string, download func(context.Context) (io.ReadCloser, error)) (string, error) {
	// This must run on every request, including a previously cached result.
	if !info.GetPermissionSet().GetInitiateFileDownload() {
		return "", merrors.Forbidden(g.serviceID, "no download permission")
	}
	if req.GetWidth() != 1 || req.GetHeight() != 1 {
		return "", merrors.BadRequest(g.serviceID, "asset information requires dimensions 1x1")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	key := metadataCacheKey(info, source)
	if g.metadataStorage.Stat(key) {
		return key, nil
	}

	converter, supported := preprocessor.ForMetadataFile(info.GetMimeType(), info.GetName(), map[string]any{
		"context": ctx, "extraRenderer": g.preprocessorOpts.ExtraRenderer,
		"extraTimeout": g.preprocessorOpts.ExtraTimeout, "maxInputBytes": g.preprocessorOpts.MaxInputBytes,
	})
	data := []byte(`{"schemaVersion":1}`)
	if supported {
		r, err := download(ctx)
		if err != nil {
			return "", g.metadataSourceError(err)
		}
		defer r.Close()
		result, err := converter.Convert(r)
		if err != nil {
			return "", g.metadataSourceError(err)
		}
		data = result.([]byte)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := g.metadataStorage.Put(key, data); err != nil {
		g.logger.Error().Err(err).Msg("could not store asset information")
		return "", merrors.InternalServerError(g.serviceID, "could not store asset information")
	}
	return key, nil
}

func (g Thumbnail) metadataSourceError(err error) error {
	if errors.Is(err, terrors.ErrImageTooLarge) {
		return &merrors.Error{Id: g.serviceID, Code: http.StatusRequestEntityTooLarge, Status: http.StatusText(http.StatusRequestEntityTooLarge), Detail: "asset information source exceeds configured size limit"}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return merrors.Timeout(g.serviceID, "asset information request ended")
	}
	return merrors.NotFound(g.serviceID, "asset information is unavailable")
}

// Converter and storage errors can contain temporary paths or decoder output.
// Only a stable user-facing message crosses the public metadata boundary.
func (g Thumbnail) metadataError(err error) error {
	code := merrors.FromError(err).GetCode()
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		code = http.StatusRequestTimeout
	}
	if code < 400 || code > 599 {
		code = http.StatusInternalServerError
	}
	return &merrors.Error{Id: g.serviceID, Code: code, Status: http.StatusText(int(code)), Detail: "Could not load asset information"}
}
