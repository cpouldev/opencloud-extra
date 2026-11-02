package extra

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

const (
	extraSize          = 1024
	extraPreviewSize   = 2048
	extraMaxOutputSize = 128 << 20
)

// ErrImageTooLarge reports a source or rendered image beyond its size limit.
var ErrImageTooLarge = errors.New("extra thumbnail source or image is too large")

// RendererOptions bounds the isolated conversion and carries its source context.
type RendererOptions struct {
	Context       context.Context
	Command       string
	Timeout       time.Duration
	MaxInputBytes uint64
	TargetSize    int
}

// Renderer streams a bounded source to disk and delegates conversion to a
// subprocess. Image bytes are handed to the generator without decoding pixels.
type Renderer struct {
	format   Format
	command  string
	timeout  time.Duration
	maxBytes int64
	size     int
	ctx      context.Context
}

// NewRenderer preserves the grid budget and increases it for larger previews,
// with independent caps on the renderer's image dimensions and output bytes.
func NewRenderer(format Format, opts RendererOptions) Renderer {
	renderer := Renderer{
		format: format, command: "opencloud-extra-thumbnail", timeout: 90 * time.Second,
		maxBytes: 50_000_000, ctx: context.Background(),
		size: min(max(opts.TargetSize, extraSize), extraPreviewSize),
	}
	if opts.Command != "" {
		renderer.command = opts.Command
	}
	if opts.Timeout > 0 {
		renderer.timeout = opts.Timeout
	}
	if opts.MaxInputBytes > 0 && opts.MaxInputBytes < math.MaxInt64 {
		renderer.maxBytes = int64(opts.MaxInputBytes)
	}
	if opts.Context != nil {
		renderer.ctx = opts.Context
	}
	return renderer
}

// Convert returns a bounded PNG for the thumbnail generator.
func (c Renderer) Convert(r io.Reader) ([]byte, error) {
	return c.render(r, false)
}

// Metadata returns only the bounded, versioned public asset information schema.
func (c Renderer) Metadata(r io.Reader) ([]byte, error) {
	return c.render(r, true)
}

func (c Renderer) render(r io.Reader, metadata bool) ([]byte, error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// A stalled source body must also stop when the request or renderer expires.
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
		return nil, ErrImageTooLarge
	}
	output := filepath.Join(dir, "thumbnail.png")
	maxOutput := int64(extraMaxOutputSize)
	if metadata {
		output = filepath.Join(dir, "metadata.json")
		maxOutput = MetadataMaxOutputSize
	}
	args := []string{"--kind", c.format.Kind, "--input", input, "--output", output}
	if metadata {
		args = append(args, "--metadata")
	} else {
		args = append(args, "--size", strconv.Itoa(c.size))
	}
	cmd := exec.CommandContext(ctx, c.command, args...)
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
	if !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("extra thumbnail output is not a regular file")
	}
	if stat.Size() > maxOutput {
		return nil, ErrImageTooLarge
	}
	preview, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	defer preview.Close()
	data, err := io.ReadAll(io.LimitReader(preview, maxOutput+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxOutput {
		return nil, ErrImageTooLarge
	}
	if metadata {
		return ValidateMetadata(data)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("extra thumbnail output is not PNG: %w", err)
	}
	if config.Width > c.size || config.Height > c.size {
		return nil, ErrImageTooLarge
	}
	return data, nil
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
