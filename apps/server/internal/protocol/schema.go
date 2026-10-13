package protocol

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed schema.json
var contractSchema []byte

var payloadSchemas = sync.OnceValues(func() (map[string]*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(contractSchema))
	if err != nil {
		return nil, err
	}
	const location = "https://jotter.invalid/protocol.schema.json"
	if err := compiler.AddResource(location, document); err != nil {
		return nil, err
	}
	schemas := make(map[string]*jsonschema.Schema)
	for name := range document.(map[string]any)["$defs"].(map[string]any) {
		schema, err := compiler.Compile(location + "#/$defs/" + name)
		if err != nil {
			return nil, err
		}
		schemas[name] = schema
	}
	return schemas, nil
})

func ValidatePayload(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return ValidateJSON(name, data)
}

func ValidateJSON(name string, data []byte) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("payload is not UTF-8")
	}
	schemas, err := payloadSchemas()
	if err != nil {
		return err
	}
	schema, ok := schemas[name]
	if !ok {
		return fmt.Errorf("unknown contract %s", name)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		return err
	}
	if err := schema.Validate(value); err != nil {
		return err
	}
	return validatePayloadContent(value)
}

func validatePayloadContent(value any) error {
	switch object := value.(type) {
	case map[string]any:
		for key, value := range object {
			if key == "id" || strings.HasSuffix(key, "Id") || key == "request_id" {
				if text, ok := value.(string); ok {
					if err := ID(text); err != nil {
						return err
					}
				}
			}
			if key == "content" || key == "submittedContent" || key == "serverContent" {
				if text, ok := value.(string); ok {
					if _, err := normalizeAndCheckContent(text); err != nil {
						return err
					}
				}
			}
			if err := validatePayloadContent(value); err != nil {
				return err
			}
		}
	case []any:
		for _, value := range object {
			if err := validatePayloadContent(value); err != nil {
				return err
			}
		}
	}
	return nil
}
