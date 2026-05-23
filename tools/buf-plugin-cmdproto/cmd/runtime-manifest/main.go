package main

import (
	"flag"
	"fmt"
	"os"

	"cmdproto.tools/buf-plugin-cmdproto/internal/compiler"
	"google.golang.org/protobuf/proto"
)

func main() {
	var schemaPath string
	var outPath string

	flag.StringVar(&schemaPath, "schema", "", "Path to schema.binpb")
	flag.StringVar(&outPath, "out", "", "Path to write runtime.binpb")
	flag.Parse()

	if schemaPath == "" || outPath == "" {
		fmt.Fprintln(os.Stderr, "usage: runtime-manifest --schema <schema.binpb> --out <runtime.binpb>")
		os.Exit(2)
	}

	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read schema: %v\n", err)
		os.Exit(1)
	}

	manifest, issues, err := compiler.CompileDescriptorSetBytes(schemaBytes)
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
}
