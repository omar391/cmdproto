package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"cmdproto.tools/buf-plugin-cmdproto/internal/compiler"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func main() {
	var appName string
	var schemaPath string
	var outPath string
	var outJSONPath string

	flag.StringVar(&appName, "app-name", "", "App name to prefix rendered examples")
	flag.StringVar(&schemaPath, "schema", "", "Path to schema.binpb")
	flag.StringVar(&outPath, "out", "", "Path to write runtime.binpb")
	flag.StringVar(&outJSONPath, "out-json", "", "Optional path to write runtime manifest JSON")
	flag.Parse()

	appName = strings.TrimSpace(appName)
	if appName == "" || schemaPath == "" || outPath == "" {
		fmt.Fprintln(os.Stderr, "usage: runtime-manifest --app-name <name> --schema <schema.binpb> --out <runtime.binpb>")
		os.Exit(2)
	}

	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read schema: %v\n", err)
		os.Exit(1)
	}

	manifest, issues, err := compiler.CompileDescriptorSetBytes(schemaBytes, appName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "compile manifest: %v\n", err)
		os.Exit(1)
	}
	if len(issues) > 0 {
		for _, issue := range issues {
			location := ""
			if issue.Descriptor != nil {
				location = string(issue.Descriptor.FullName()) + ": "
			}
			fmt.Fprintf(os.Stderr, "%s%s\n", location, issue.Message)
		}
		os.Exit(1)
	}

	bytes, err := proto.Marshal(manifest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode manifest: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(outPath, bytes, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write manifest: %v\n", err)
		os.Exit(1)
	}
	if strings.TrimSpace(outJSONPath) != "" {
		jsonBytes, err := protojson.MarshalOptions{
			Indent:          "  ",
			UseProtoNames:   false,
			UseEnumNumbers:  false,
			EmitUnpopulated: true,
		}.Marshal(manifest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "encode manifest json: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(outJSONPath, append(jsonBytes, '\n'), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write manifest json: %v\n", err)
			os.Exit(1)
		}
	}
}
