package svc

import (
	"context"
	"errors"
	"net/http"

	"github.com/opencloud-eu/opencloud/pkg/log"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
	"github.com/opencloud-eu/opencloud/services/webdav/pkg/thumbnail/workflow"
)

// Decoder diagnostics and storage errors may contain paths or private source
// facts. Keep them in server logs and expose only a stable metadata error.
func (g Webdav) handleMetadataError(w http.ResponseWriter, r *http.Request, err error, logger log.Logger) {
	logger.Debug().Err(err).Msg("could not load asset information")
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, workflow.ErrInvalidMetadataRequest), errors.Is(err, workflow.ErrNotAFile):
		status = http.StatusBadRequest
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status = http.StatusRequestTimeout
	case errors.Is(err, workflow.ErrImageTooLarge), errors.Is(err, extra.ErrImageTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, workflow.ErrPermissionDenied):
		status = http.StatusForbidden
	case errors.Is(err, workflow.ErrNotFound), errors.Is(err, workflow.ErrUnsupportedFileType):
		status = http.StatusNotFound
	case errors.Is(err, workflow.ErrFileProcessing):
		status = http.StatusTooEarly
		addRetryAfterHeader(w)
	}
	renderError(w, r, newErrResponse(status, "Could not load asset information"))
}
