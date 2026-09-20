//go:build !windows

package preprocessor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	thumbnailerErrors "github.com/opencloud-eu/opencloud/services/thumbnails/pkg/errors"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/extra"
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
			converter, ok := ForMetadataFile("image/png", "image.png", map[string]any{"extraRenderer": script})
			if !ok {
				t.Fatal("native PNG lacks metadata provider")
			}
			result, err := converter.Convert(strings.NewReader(tc.data))
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected converter result: %v", err)
			}
			if tc.valid && !strings.Contains(string(result.([]byte)), `"width":2400`) {
				t.Fatalf("source dimensions not preserved: %s", result)
			}
		})
	}
	base := `{"schemaVersion":1}`
	for _, size := range []int{extra.MetadataMaxOutputSize - 1, extra.MetadataMaxOutputSize, extra.MetadataMaxOutputSize + 1} {
		t.Run(fmt.Sprintf("output %d", size), func(t *testing.T) {
			converter, _ := ForMetadataFile("image/png", "image.png", map[string]any{"extraRenderer": script})
			_, err := converter.Convert(strings.NewReader(base + strings.Repeat(" ", size-len(base))))
			if (err != nil) != (size > extra.MetadataMaxOutputSize) {
				t.Fatalf("wrong output bound: %v", err)
			}
		})
	}
}

func TestMetadataConverterSourceLimit(t *testing.T) {
	script := extraTestRenderer(t, `printf '{"schemaVersion":1}' > "$6"`)
	for _, size := range []int{9, 10, 11} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			converter, _ := ForMetadataFile("image/jpeg", "image.jpg", map[string]any{"extraRenderer": script, "maxInputBytes": uint64(10)})
			_, err := converter.Convert(strings.NewReader(strings.Repeat("x", size)))
			if size > 10 && !errors.Is(err, thumbnailerErrors.ErrImageTooLarge) || size <= 10 && err != nil {
				t.Fatalf("wrong input bound: %v", err)
			}
		})
	}
}

func TestMetadataConverterRejectsSymlink(t *testing.T) {
	script := extraTestRenderer(t, `ln -s "$4" "$6"`)
	converter, _ := ForMetadataFile("image/jpeg", "image.jpg", map[string]any{"extraRenderer": script})
	if _, err := converter.Convert(strings.NewReader(`{"schemaVersion":1}`)); err == nil {
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
			converter, _ := ForMetadataFile("image/png", "image.png", map[string]any{"extraRenderer": script, "extraTimeout": 50 * time.Millisecond})
			start := time.Now()
			if _, err := converter.Convert(source); !errors.Is(err, context.DeadlineExceeded) {
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
