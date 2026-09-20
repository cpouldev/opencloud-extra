package preprocessor

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	thumbnailerErrors "github.com/opencloud-eu/opencloud/services/thumbnails/pkg/errors"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
)

const (
	extraSize          = 1024
	extraMaxOutputSize = 128 << 20
)

// ForFile adds the downstream providers without changing the upstream decoders.
func ForFile(mimeType, filename string, opts map[string]any) FileConverter {
	format, supported := extra.Lookup(mimeType, filename)
	if !supported {
		return ForType(mimeType, opts)
	}
	converter := ExtraConverter{
		format: format, command: "opencloud-extra-thumbnail", timeout: 90 * time.Second,
		maxBytes: 50_000_000, ctx: context.Background(), limit: decodeLimitFromOpts(opts),
	}
	if command, ok := opts["extraRenderer"].(string); ok && command != "" {
		converter.command = command
	}
	if timeout, ok := opts["extraTimeout"].(time.Duration); ok && timeout > 0 {
		converter.timeout = timeout
	}
	if maxBytes, ok := opts["maxInputBytes"].(uint64); ok && maxBytes > 0 && maxBytes < math.MaxInt64 {
		converter.maxBytes = int64(maxBytes)
	}
	if ctx, ok := opts["context"].(context.Context); ok && ctx != nil {
		converter.ctx = ctx
	}
	return converter
}

// ExtraConverter streams a bounded input to disk and delegates rendering to an
// isolated process. Only the small resulting PNG enters OpenCloud's image decoder.
type ExtraConverter struct {
	format   extra.Format
	command  string
	timeout  time.Duration
	maxBytes int64
	ctx      context.Context
	limit    decodeLimit
}

func (c ExtraConverter) Convert(r io.Reader) (any, error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// HTTP response bodies must also be interrupted if the source stops sending.
	if closer, ok := r.(io.Closer); ok {
		stop := context.AfterFunc(ctx, func() { _ = closer.Close() })
		defer stop()
	}
	dir, err := os.MkdirTemp("", "opencloud-extra-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "input"+c.format.Extension)
	f, err := os.OpenFile(input, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	n, copyErr := io.Copy(f, io.LimitReader(contextReader{ctx: ctx, reader: r}, c.maxBytes+1))
	closeErr := f.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if copyErr != nil {
		return nil, copyErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if n > c.maxBytes {
		return nil, thumbnailerErrors.ErrImageTooLarge
	}
	output := filepath.Join(dir, "thumbnail.png")
	cmd := exec.CommandContext(ctx, c.command,
		"--kind", c.format.Kind, "--input", input, "--output", output, "--size", strconv.Itoa(extraSize))
	cmd.Dir = dir
	cmd.Env = extraEnvironment(dir)
	cmd.WaitDelay = 2 * time.Second
	var stderr cappedBuffer
	cmd.Stderr = &stderr
	configureExtraProcess(cmd)
	defer stopExtraProcess(cmd)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("extra thumbnail renderer: %w: %s", err, stderr.String())
	}
	stat, err := os.Lstat(output)
	if err != nil {
		return nil, fmt.Errorf("extra thumbnail output: %w", err)
	}
	if !stat.Mode().IsRegular() || stat.Size() > extraMaxOutputSize {
		return nil, fmt.Errorf("extra thumbnail output is not a bounded regular file")
	}
	preview, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	defer preview.Close()
	config, err := png.DecodeConfig(preview)
	if err != nil {
		return nil, fmt.Errorf("extra thumbnail output is not PNG: %w", err)
	}
	if config.Width > extraSize || config.Height > extraSize || c.limit.exceeded(config.Width, config.Height) {
		return nil, thumbnailerErrors.ErrImageTooLarge
	}
	if _, err := preview.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return (ImageDecoder{limit: c.limit}).Convert(preview)
}

// Do not expose OpenCloud credentials to document and media converters.
func extraEnvironment(dir string) []string {
	env := []string{"HOME=" + dir, "TMPDIR=" + dir, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PYTHONDONTWRITEBYTECODE=1"}
	for _, name := range []string{"PATH", "LD_LIBRARY_PATH", "MAGICK_CONFIGURE_PATH", "FONTCONFIG_PATH", "FONTCONFIG_FILE", "VIPS_CONCURRENCY", "MAGICK_THREAD_LIMIT", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "SAL_USE_VCLPLUGIN"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 4096 - b.Len()
	if remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(remaining, n)])
	}
	return n, nil
}
