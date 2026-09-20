package thumbnail_test

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"testing"

	"github.com/opencloud-eu/opencloud/pkg/log"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/config"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/config/defaults"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/preprocessor"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail"
	"github.com/opencloud-eu/opencloud/services/thumbnails/pkg/thumbnail/storage"
)

func TestExtraPreviewFitUsesFullResolution(t *testing.T) {
	for _, size := range []image.Point{{X: 2048, Y: 1280}, {X: 1280, Y: 2048}, {X: 2048, Y: 2048}, {X: 320, Y: 200}} {
		t.Run(fmt.Sprintf("%dx%d", size.X, size.Y), func(t *testing.T) {
			cfg := defaults.DefaultConfig().Thumbnail
			resolutions, err := thumbnail.ParseResolutions(cfg.Resolutions)
			if err != nil {
				t.Fatal(err)
			}
			store := storage.NewFileSystemStorage(config.FileSystemStorage{RootDirectory: t.TempDir()}, log.NewLogger())
			manager := thumbnail.NewSimpleManager(resolutions, store, log.NewLogger(), cfg.MaxInputWidth, cfg.MaxInputHeight)
			original := image.NewRGBA(image.Rectangle{Max: size})
			draw.Draw(original, original.Bounds(), image.NewUniform(color.RGBA{R: 255, A: 255}), image.Point{}, draw.Src)
			draw.Draw(original, image.Rect(0, 0, 16, size.Y), image.NewUniform(color.RGBA{B: 255, A: 255}), image.Point{}, draw.Src)
			var source bytes.Buffer
			if err := png.Encode(&source, original); err != nil {
				t.Fatal(err)
			}
			grid, err := thumbnail.PrepareRequest(128, 128, "png", "sample-checksum", "thumbnail")
			if err != nil {
				t.Fatal(err)
			}
			preview, err := thumbnail.PrepareRequest(2048, 2048, "png", "sample-checksum", "fit")
			if err != nil {
				t.Fatal(err)
			}
			generate := func(request thumbnail.Request) string {
				t.Helper()
				img, err := preprocessor.ForType("image/png", nil).Convert(bytes.NewReader(source.Bytes()))
				if err != nil {
					t.Fatal(err)
				}
				if closer, ok := img.(interface{ Close() }); ok {
					defer closer.Close()
				}
				key, err := manager.Generate(request, img)
				if err != nil {
					t.Fatal(err)
				}
				return key
			}
			gridKey := generate(grid)
			gridBytes, err := manager.GetThumbnail(gridKey)
			if err != nil {
				t.Fatal(err)
			}
			gridImage, err := png.DecodeConfig(bytes.NewReader(gridBytes))
			if err != nil || gridImage.Width != 128 || gridImage.Height != 128 {
				t.Fatalf("expected 128x128 grid thumbnail, got %v, %v", gridImage, err)
			}
			if _, cached := manager.CheckThumbnail(preview); cached {
				t.Fatal("grid thumbnail satisfied the full preview cache lookup")
			}
			previewKey := generate(preview)
			if previewKey == gridKey {
				t.Fatal("preview reused the grid thumbnail cache key")
			}
			key, cached := manager.CheckThumbnail(preview)
			if !cached || key != previewKey {
				t.Fatal("preview was not cached under its request")
			}
			data, err := manager.GetThumbnail(previewKey)
			if err != nil {
				t.Fatal(err)
			}
			result, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if result.Bounds().Size() != size {
				t.Fatalf("preview size is %v, expected %v", result.Bounds().Size(), size)
			}
			r, _, b, _ := result.At(0, size.Y/2).RGBA()
			if b <= r {
				t.Fatal("fit preview cropped the blue left border")
			}
			r, _, b, _ = result.At(size.X-1, size.Y/2).RGBA()
			if r <= b {
				t.Fatal("fit preview cropped the red right border")
			}
		})
	}
}
