package validator

import (
	"buf.build/go/bufplugin/descriptor"
	"cmdproto.tools/buf-plugin-cmdproto/internal/compiler"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type Issue = compiler.Issue

func Validate(files []descriptor.FileDescriptor) []Issue {
	protoFiles := make([]protoreflect.FileDescriptor, 0, len(files))
	for _, file := range files {
		protoFiles = append(protoFiles, file.ProtoreflectFileDescriptor())
	}
	return compiler.ValidateFiles(protoFiles)
}
