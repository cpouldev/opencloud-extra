package extra

import (
	"encoding/json"
	"errors"
	"math"
	"mime"
	"path/filepath"
	"strings"
	"unicode"
)

const (
	// MetadataProcessor uses the existing authorized preview transport for JSON.
	MetadataProcessor = "extra-metadata-v1"
	// MetadataCachePrefix separates metadata from every image cache entry.
	MetadataCachePrefix = MetadataProcessor + "/"
	// MetadataMaxOutputSize bounds both extractor output and serialized responses.
	MetadataMaxOutputSize = 16 << 10
)

// LookupMetadata identifies sources with useful extraction facts. Ordinary
// images have an explicit mapping because they use upstream thumbnail decoders.
func LookupMetadata(mimeType, filename string) (Format, bool) {
	if format, ok := Lookup(mimeType, filename); ok {
		switch format.Kind {
		case "text", "office", "archive", "epub":
			return Format{}, false
		default:
			return format, true
		}
	}
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp":
		return Format{Kind: "image", Extension: ext}, true
	case ".eps", ".ps", ".stl", ".obj", ".gltf", ".glb":
		return Format{}, false
	}
	mediaType, _, _ := mime.ParseMediaType(mimeType)
	suffix, ok := map[string]string{
		"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
		"image/bmp": ".bmp", "image/x-ms-bmp": ".bmp", "image/tiff": ".tif", "image/webp": ".webp",
	}[mediaType]
	return Format{Kind: "image", Extension: suffix}, ok
}

// ValidateMetadata accepts only the flat versioned public schema. It removes
// controls from display strings and never forwards unrecognized extractor data.
func ValidateMetadata(data []byte) ([]byte, error) {
	invalid := errors.New("invalid asset metadata")
	if len(data) > MetadataMaxOutputSize {
		return nil, invalid
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil || values == nil {
		return nil, invalid
	}
	var version int
	if err := json.Unmarshal(values["schemaVersion"], &version); err != nil || version != 1 {
		return nil, invalid
	}
	result := map[string]any{"schemaVersion": 1}
	for field, raw := range values {
		switch field {
		case "schemaVersion":
		case "format", "colorSpace", "colorProfile", "videoCodec", "audioCodec", "fontFamily", "fontStyle", "fontFullName", "fontVersion":
			var value string
			if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" {
				return nil, invalid
			}
			runes := []rune(strings.Map(func(r rune) rune {
				if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
					return -1
				}
				return r
			}, value))
			value = strings.TrimSpace(string(runes[:min(len(runes), 512)]))
			if value != "" {
				result[field] = value
			}
		case "fontVariable":
			var value bool
			if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" {
				return nil, invalid
			}
			result[field] = value
		case "width", "height", "bitDepth", "pages", "sampleRate", "channels", "glyphs", "fontFaces", "pageWidth", "pageHeight", "duration", "frameRate":
			var value float64
			if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 9_007_199_254_740_991 {
				return nil, invalid
			}
			if value == 0 && field != "duration" && field != "glyphs" {
				return nil, invalid
			}
			switch field {
			case "pageWidth", "pageHeight", "duration", "frameRate":
			default:
				if math.Trunc(value) != value {
					return nil, invalid
				}
			}
			result[field] = value
		default:
			return nil, invalid
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > MetadataMaxOutputSize {
		return nil, invalid
	}
	return encoded, nil
}
