//go:build !windows

package extra

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMetadataConverterBoundedOutput(t *testing.T) {
	script := extraTestRenderer(t, `test "$7" = --metadata
cp "$4" "$6"`)
	for _, tc := range []struct {
		name, data string
		valid      bool
	}{
		{"valid", `{"schemaVersion":1,"width":2400,"height":1600}`, true},
		{"malformed", `not JSON`, false},
		{"object required", `[]`, false},
		{"unknown property", `{"schemaVersion":1,"path":"private"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			converter := NewRenderer(Format{Kind: "image", Extension: ".png"}, RendererOptions{Command: script})
			result, err := converter.Metadata(strings.NewReader(tc.data))
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected converter result: %v", err)
			}
			if tc.valid && !strings.Contains(string(result), `"width":2400`) {
				t.Fatalf("source dimensions not preserved: %s", result)
			}
		})
	}
	base := `{"schemaVersion":1}`
	for _, size := range []int{MetadataMaxOutputSize - 1, MetadataMaxOutputSize, MetadataMaxOutputSize + 1} {
		t.Run(fmt.Sprintf("output %d", size), func(t *testing.T) {
			converter := NewRenderer(Format{Kind: "image", Extension: ".png"}, RendererOptions{Command: script})
			_, err := converter.Metadata(strings.NewReader(base + strings.Repeat(" ", size-len(base))))
			if (err != nil) != (size > MetadataMaxOutputSize) {
				t.Fatalf("wrong output bound: %v", err)
			}
			if size > MetadataMaxOutputSize && !errors.Is(err, ErrImageTooLarge) {
				t.Fatalf("expected output size error, got %v", err)
			}
		})
	}
}

func TestMetadataConverterSourceLimit(t *testing.T) {
	script := extraTestRenderer(t, `printf '{"schemaVersion":1}' > "$6"`)
	for _, size := range []int{9, 10, 11} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			converter := NewRenderer(Format{Kind: "image", Extension: ".jpg"}, RendererOptions{Command: script, MaxInputBytes: uint64(10)})
			_, err := converter.Metadata(strings.NewReader(strings.Repeat("x", size)))
			if size > 10 && !errors.Is(err, ErrImageTooLarge) || size <= 10 && err != nil {
				t.Fatalf("wrong input bound: %v", err)
			}
		})
	}
}

func TestMetadataConverterRejectsSymlink(t *testing.T) {
	script := extraTestRenderer(t, `ln -s "$4" "$6"`)
	converter := NewRenderer(Format{Kind: "image", Extension: ".jpg"}, RendererOptions{Command: script})
	if _, err := converter.Metadata(strings.NewReader(`{"schemaVersion":1}`)); err == nil {
		t.Fatal("accepted symlink metadata output")
	}
}

func TestMetadataConverterCancellation(t *testing.T) {
	for _, phase := range []string{"download", "extract"} {
		t.Run(phase, func(t *testing.T) {
			script := extraTestRenderer(t, "sleep 30")
			tmp := t.TempDir()
			t.Setenv("TMPDIR", tmp)
			var source io.Reader = strings.NewReader("source")
			if phase == "download" {
				reader, writer := io.Pipe()
				defer writer.Close()
				source = reader
			}
			converter := NewRenderer(Format{Kind: "image", Extension: ".png"}, RendererOptions{Command: script, Timeout: 50 * time.Millisecond})
			start := time.Now()
			if _, err := converter.Metadata(source); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected cancellation, got %v", err)
			}
			if time.Since(start) > 5*time.Second {
				t.Fatal("cancellation did not stop descendants")
			}
			// The renderer script lives in a separate testing directory.
			files, err := os.ReadDir(tmp)
			if err != nil || len(files) != 0 {
				t.Fatalf("temporary source leaked: %v %v", files, err)
			}
		})
	}
}
