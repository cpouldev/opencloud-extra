//go:build !windows

package extra

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func extraTestRenderer(t *testing.T, body string) string {
	t.Helper()
	script := filepath.Join(t.TempDir(), "renderer")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nset -eu\n"+body+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return script
}

func extraTestPNG(t *testing.T, width int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, width, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtraInputLimit(t *testing.T) {
	input := extraTestPNG(t, 4)
	script := extraTestRenderer(t, `cp "$4" "$6"`)
	for _, tc := range []struct {
		name string
		cap  int
		fail bool
	}{
		{"one byte over limit", len(input) - 1, true},
		{"exact limit", len(input), false},
		{"one byte under limit", len(input) + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{
				Command: script, MaxInputBytes: uint64(tc.cap),
			})
			img, err := converter.Convert(bytes.NewReader(input))
			if tc.fail {
				if !errors.Is(err, ErrImageTooLarge) {
					t.Fatalf("expected source limit error, got %v", err)
				}
			} else if err != nil || img == nil {
				t.Fatalf("expected thumbnail bytes, got %v", err)
			}
		})
	}
}

func TestExtraRejectsInvalidOutput(t *testing.T) {
	script := extraTestRenderer(t, `printf invalid > "$6"`)
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{Command: script})
	if _, err := converter.Convert(strings.NewReader("source")); err == nil {
		t.Fatal("expected invalid renderer output to fail")
	}
}

func TestExtraOutputDimensionLimit(t *testing.T) {
	script := extraTestRenderer(t, `cp "$4" "$6"`)
	for _, size := range []int{1024, 2048} {
		for _, width := range []int{size - 1, size, size + 1} {
			t.Run(fmt.Sprintf("size_%d_output_%d", size, width), func(t *testing.T) {
				converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{
					Command: script, TargetSize: size,
				})
				img, err := converter.Convert(bytes.NewReader(extraTestPNG(t, width)))
				if width > size {
					if !errors.Is(err, ErrImageTooLarge) {
						t.Fatalf("expected output limit error, got %v", err)
					}
				} else if err != nil || len(img) == 0 {
					t.Fatalf("expected preview bytes, got %v", err)
				}
			})
		}
	}
}

func TestExtraRequestedRenderSize(t *testing.T) {
	for _, tc := range []struct {
		requested int
		expected  int
	}{
		{-1, 1024}, {0, 1024}, {128, 1024},
		{1023, 1024}, {1024, 1024}, {1025, 1025},
		{2047, 2047}, {2048, 2048}, {2049, 2048},
	} {
		t.Run(fmt.Sprintf("requested_%d", tc.requested), func(t *testing.T) {
			script := extraTestRenderer(t, fmt.Sprintf("test \"$8\" -eq %d\ncp \"$4\" \"$6\"", tc.expected))
			converter := NewRenderer(Format{Kind: "image", Extension: ".psd"}, RendererOptions{
				Command: script, TargetSize: tc.requested,
			})
			img, err := converter.Convert(bytes.NewReader(extraTestPNG(t, 4)))
			if err != nil || len(img) == 0 {
				t.Fatalf("renderer did not receive size %d: %v", tc.expected, err)
			}
		})
	}
}

func TestExtraRendererFailure(t *testing.T) {
	script := extraTestRenderer(t, "echo cannot-render >&2\nexit 7")
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{Command: script})
	if _, err := converter.Convert(strings.NewReader("source")); err == nil || !strings.Contains(err.Error(), "cannot-render") {
		t.Fatalf("expected renderer diagnostic, got %v", err)
	}
}

func TestExtraCancellationCleansTemporaryFiles(t *testing.T) {
	script := extraTestRenderer(t, "sleep 30")
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{
		Command: script, Timeout: 50 * time.Millisecond,
	})
	start := time.Now()
	if _, err := converter.Convert(strings.NewReader("source")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("renderer descendants prevented cancellation")
	}
	files, err := os.ReadDir(tmp)
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary input was not cleaned: %v, %v", files, err)
	}
}

func TestExtraCancellationInterruptsSource(t *testing.T) {
	source, writer := io.Pipe()
	defer writer.Close()
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{Timeout: 50 * time.Millisecond})
	if _, err := converter.Convert(source); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected source read deadline, got %v", err)
	}
}

func TestExtraRequestContextInterruptsSource(t *testing.T) {
	source, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{
		Context: ctx, Timeout: 30 * time.Second,
	})
	if _, err := converter.Convert(source); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected source request deadline, got %v", err)
	}
}

func TestExtraEnvironmentExcludesCredentials(t *testing.T) {
	t.Setenv("OC_JWT_SECRET", "private-server-token")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "private-storage-token")
	for _, variable := range extraEnvironment("/private/job") {
		if strings.Contains(variable, "private-server-token") || strings.Contains(variable, "private-storage-token") {
			t.Fatal("server credentials exposed to renderer")
		}
	}
}

func TestExtraRejectsSymlinkOutput(t *testing.T) {
	script := extraTestRenderer(t, `ln -s "$4" "$6"`)
	converter := NewRenderer(Format{Kind: "video", Extension: ".mp4"}, RendererOptions{Command: script})
	if _, err := converter.Convert(bytes.NewReader(extraTestPNG(t, 4))); err == nil {
		t.Fatal("renderer output symlink was accepted")
	}
}
