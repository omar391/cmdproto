package compiler

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	cmdprotov1 "cmdproto.tools/buf-plugin-cmdproto/internal/gen/cmdproto/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

const (
	commandOptionName = protoreflect.FullName("cmdproto.v1.command")
	paramOptionName   = protoreflect.FullName("cmdproto.v1.param")

	manifestVersion = 1
	helpJSONVersion = 1

	executeName    = "cmdproto execute"
	executeUsage   = "cmdproto execute <path> --json '<payload>'"
	executeSummary = "Execute a machine payload for a command path."
)

var (
	commandTokenRe       = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	longFlagRe           = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	shortFlagRe          = regexp.MustCompile(`^[A-Za-z0-9]$`)
	reservedCommandRoots = map[string]struct{}{"cmdproto": {}}
	reservedLongFlags    = map[string]struct{}{"help": {}, "json": {}}
	reservedShortFlags   = map[string]struct{}{"h": {}}
)

type Issue struct {
	Descriptor protoreflect.Descriptor
	Message    string
}

type extensionRegistry struct {
	commandOption protoreflect.ExtensionDescriptor
	paramOption   protoreflect.ExtensionDescriptor
}

type commandBinding struct {
	key             string
	tokens          []string
	method          *methodSpec
	source          string
	positionalCount int
}

type commandOptions struct {
	path       string
	summary    string
	aliases    []string
	examples   []cliExample
	hidden     bool
	deprecated bool
}

type cliExample struct {
	command     string
	description string
	requestJSON string
}

type paramOptions struct {
	positional    *positionalOptions
	flag          *flagOptions
	help          string
	hidden        bool
	positionLabel string
}

type positionalOptions struct {
	index uint32
}

type flagOptions struct {
	long  string
	short string
}

type fieldSpec struct {
	name       string
	jsonName   string
	number     uint32
	descriptor protoreflect.FieldDescriptor
	param      paramOptions
}

type methodSpec struct {
	name       string
	service    string
	rpc        string
	input      protoreflect.MessageDescriptor
	output     protoreflect.MessageDescriptor
	descriptor protoreflect.MethodDescriptor
	command    commandOptions
	fields     []*fieldSpec
}

type schemaContext struct {
	registry *protoregistry.Files
	types    *dynamicpb.Types
	ext      *extensionRegistry
}

func ValidateFiles(files []protoreflect.FileDescriptor) []Issue {
	ctx, err := newSchemaContext(files)
	if err != nil {
		return []Issue{{
			Descriptor: firstFileDescriptor(files),
			Message:    err.Error(),
		}}
	}
	if ctx.ext == nil {
		return nil
	}
	methods, issues := analyzeMethods(ctx, files)
	_ = methods
	return issues
}

func CompileDescriptorSetBytes(schemaBytes []byte) (*cmdprotov1.RuntimeManifest, []Issue, error) {
	set := &descriptorpb.FileDescriptorSet{}
	if err := proto.Unmarshal(schemaBytes, set); err != nil {
		return nil, nil, fmt.Errorf("decode schema.binpb: %w", err)
	}
	registry, err := protodesc.NewFiles(set)
	if err != nil {
		return nil, nil, fmt.Errorf("load descriptors: %w", err)
	}
	files := collectFiles(registry)
	ctx, err := newSchemaContext(files)
	if err != nil {
		return nil, nil, err
	}
	if ctx.ext == nil {
		return buildManifest(nil, nil, descriptorHash(schemaBytes))
	}
	methods, issues := analyzeMethods(ctx, files)
	if len(issues) > 0 {
		return nil, issues, nil
	}
	return buildManifest(methods, ctx, descriptorHash(schemaBytes))
}

func firstFileDescriptor(files []protoreflect.FileDescriptor) protoreflect.Descriptor {
	if len(files) == 0 {
		return nil
	}
	return files[0]
}

func descriptorHash(schemaBytes []byte) string {
	sum := sha256.Sum256(schemaBytes)
	return fmt.Sprintf("%x", sum)
}

func collectFiles(registry *protoregistry.Files) []protoreflect.FileDescriptor {
	files := make([]protoreflect.FileDescriptor, 0)
	registry.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		files = append(files, fd)
		return true
	})
	slices.SortFunc(files, func(left, right protoreflect.FileDescriptor) int {
		return strings.Compare(left.Path(), right.Path())
	})
	return files
}

func newSchemaContext(files []protoreflect.FileDescriptor) (*schemaContext, error) {
	registry, err := buildRegistry(files)
	if err != nil {
		return nil, err
	}
	return &schemaContext{
		registry: registry,
		types:    dynamicpb.NewTypes(registry),
		ext:      newExtensionRegistry(files),
	}, nil
}

func buildRegistry(files []protoreflect.FileDescriptor) (*protoregistry.Files, error) {
	set := &descriptorpb.FileDescriptorSet{
		File: make([]*descriptorpb.FileDescriptorProto, 0, len(files)),
	}
	for _, file := range files {
		set.File = append(set.File, protodesc.ToFileDescriptorProto(file))
	}
	return protodesc.NewFiles(set)
}

func newExtensionRegistry(files []protoreflect.FileDescriptor) *extensionRegistry {
	var commandOption protoreflect.ExtensionDescriptor
	var paramOption protoreflect.ExtensionDescriptor

	for _, file := range files {
		if commandOption == nil {
			commandOption = findExtensionDescriptorInFile(file, commandOptionName)
		}
		if paramOption == nil {
			paramOption = findExtensionDescriptorInFile(file, paramOptionName)
		}
		if commandOption != nil && paramOption != nil {
			return &extensionRegistry{
				commandOption: commandOption,
				paramOption:   paramOption,
			}
		}
	}

	return nil
}

func findExtensionDescriptorInFile(
	file protoreflect.FileDescriptor,
	fullName protoreflect.FullName,
) protoreflect.ExtensionDescriptor {
	extensions := file.Extensions()
	for index := 0; index < extensions.Len(); index += 1 {
		extension := extensions.Get(index)
		if extension.FullName() == fullName {
			return extension
		}
	}

	messages := file.Messages()
	for index := 0; index < messages.Len(); index += 1 {
		if extension := findExtensionDescriptorInMessage(messages.Get(index), fullName); extension != nil {
			return extension
		}
	}

	return nil
}

func findExtensionDescriptorInMessage(
	message protoreflect.MessageDescriptor,
	fullName protoreflect.FullName,
) protoreflect.ExtensionDescriptor {
	extensions := message.Extensions()
	for index := 0; index < extensions.Len(); index += 1 {
		extension := extensions.Get(index)
		if extension.FullName() == fullName {
			return extension
		}
	}

	nested := message.Messages()
	for index := 0; index < nested.Len(); index += 1 {
		if extension := findExtensionDescriptorInMessage(nested.Get(index), fullName); extension != nil {
			return extension
		}
	}

	return nil
}

func getExtensionMessage(
	options proto.Message,
	extensionDescriptor protoreflect.ExtensionDescriptor,
) (protoreflect.Message, bool, error) {
	if options == nil || extensionDescriptor == nil {
		return nil, false, nil
	}

	unknown := options.ProtoReflect().GetUnknown()
	for len(unknown) > 0 {
		number, wireType, tagLength := protowire.ConsumeTag(unknown)
		if tagLength < 0 {
			return nil, false, protowire.ParseError(tagLength)
		}
		unknown = unknown[tagLength:]

		if number != protowire.Number(extensionDescriptor.Number()) {
			valueLength := protowire.ConsumeFieldValue(number, wireType, unknown)
			if valueLength < 0 {
				return nil, false, protowire.ParseError(valueLength)
			}
			unknown = unknown[valueLength:]
			continue
		}

		if wireType != protowire.BytesType {
			return nil, false, fmt.Errorf(
				"cmdproto option %s used unexpected wire type %v",
				extensionDescriptor.FullName(),
				wireType,
			)
		}

		valueBytes, valueLength := protowire.ConsumeBytes(unknown)
		if valueLength < 0 {
			return nil, false, protowire.ParseError(valueLength)
		}

		message := dynamicpb.NewMessage(extensionDescriptor.Message())
		if err := proto.Unmarshal(valueBytes, message); err != nil {
			return nil, false, err
		}
		return message.ProtoReflect(), true, nil
	}

	return nil, false, nil
}

func analyzeMethods(ctx *schemaContext, files []protoreflect.FileDescriptor) ([]*methodSpec, []Issue) {
	methods := make([]*methodSpec, 0)
	issues := make([]Issue, 0)

	for _, file := range files {
		services := file.Services()
		for serviceIndex := 0; serviceIndex < services.Len(); serviceIndex += 1 {
			service := services.Get(serviceIndex)
			svcMethods := service.Methods()
			for methodIndex := 0; methodIndex < svcMethods.Len(); methodIndex += 1 {
				method := svcMethods.Get(methodIndex)
				commandMessage, ok, err := getExtensionMessage(
					method.Options(),
					ctx.ext.commandOption,
				)
				if err != nil {
					issues = append(issues, Issue{
						Descriptor: method,
						Message:    "failed to decode cmdproto command option: " + err.Error(),
					})
					continue
				}
				if !ok {
					continue
				}

				spec := &methodSpec{
					name:       string(method.FullName()),
					service:    string(service.FullName()),
					rpc:        string(method.Name()),
					input:      method.Input(),
					output:     method.Output(),
					descriptor: method,
					command:    readCommandOptions(commandMessage),
					fields:     discoverFields(method, ctx.ext),
				}
				methods = append(methods, spec)
			}
		}
	}

	slices.SortFunc(methods, func(left, right *methodSpec) int {
		return strings.Compare(left.name, right.name)
	})

	bindings := make([]commandBinding, 0)
	seenCommands := make(map[string]commandBinding)
	for _, method := range methods {
		positionalCount, fieldIssues := validateMethodFields(method)
		issues = append(issues, fieldIssues...)
		issues = append(issues, validateMethodExamples(method, ctx)...)

		for _, binding := range collectCommandBindings(method, positionalCount, &issues) {
			if existing, ok := seenCommands[binding.key]; ok {
				issues = append(issues, Issue{
					Descriptor: method.descriptor,
					Message: "Duplicate command path \"" + binding.key + "\" for " +
						binding.method.name + "; already used by " + existing.method.name,
				})
				continue
			}
			seenCommands[binding.key] = binding
			bindings = append(bindings, binding)
		}
	}

	for currentIndex := range bindings {
		current := bindings[currentIndex]
		for candidateIndex := currentIndex + 1; candidateIndex < len(bindings); candidateIndex += 1 {
			candidate := bindings[candidateIndex]
			if issue, ok := validatePrefixShadowing(current, candidate); ok {
				issues = append(issues, issue)
			}
			if issue, ok := validatePrefixShadowing(candidate, current); ok {
				issues = append(issues, issue)
			}
		}
	}

	return methods, issues
}

func readCommandOptions(message protoreflect.Message) commandOptions {
	exampleMessages := getMessageListField(message, "example")
	examples := make([]cliExample, 0, len(exampleMessages))
	for _, exampleMessage := range exampleMessages {
		examples = append(examples, cliExample{
			command:     getStringField(exampleMessage, "command"),
			description: getStringField(exampleMessage, "description"),
			requestJSON: getStringField(exampleMessage, "request_json"),
		})
	}

	return commandOptions{
		path:       getStringField(message, "path"),
		summary:    getStringField(message, "summary"),
		aliases:    getStringListField(message, "alias"),
		examples:   examples,
		hidden:     getBoolField(message, "hidden"),
		deprecated: getBoolField(message, "deprecated"),
	}
}

func discoverFields(
	method protoreflect.MethodDescriptor,
	registry *extensionRegistry,
) []*fieldSpec {
	fields := method.Input().Fields()
	specs := make([]*fieldSpec, 0, fields.Len())
	for index := 0; index < fields.Len(); index += 1 {
		field := fields.Get(index)
		options := paramOptions{}
		paramMessage, ok, err := getExtensionMessage(field.Options(), registry.paramOption)
		if err == nil && ok {
			options = readParamOptions(paramMessage, field)
		}
		specs = append(specs, &fieldSpec{
			name:       string(field.Name()),
			jsonName:   field.JSONName(),
			number:     uint32(field.Number()),
			descriptor: field,
			param:      options,
		})
	}
	return specs
}

func readParamOptions(
	message protoreflect.Message,
	field protoreflect.FieldDescriptor,
) paramOptions {
	positionalMessage, hasPositionalMessage := getMessageField(message, "positional")
	flagMessage, hasFlagMessage := getMessageField(message, "flag")

	options := paramOptions{
		help:   getStringField(message, "help"),
		hidden: getBoolField(message, "hidden"),
	}
	if hasPositionalMessage {
		if index := getUint32Field(positionalMessage, "index"); index > 0 {
			options.positional = &positionalOptions{index: index}
			options.positionLabel = renderPlaceholder(string(field.Name()))
		}
	}
	if hasFlagMessage {
		longFlag := strings.TrimSpace(getStringField(flagMessage, "long"))
		shortFlag := strings.TrimSpace(getStringField(flagMessage, "short"))
		if longFlag != "" || shortFlag != "" {
			options.flag = &flagOptions{
				long:  longFlag,
				short: shortFlag,
			}
		}
	}
	return options
}

func getStringField(message protoreflect.Message, fieldName protoreflect.Name) string {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil {
		return ""
	}
	return message.Get(field).String()
}

func getStringListField(message protoreflect.Message, fieldName protoreflect.Name) []string {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil {
		return nil
	}

	list := message.Get(field).List()
	values := make([]string, 0, list.Len())
	for index := 0; index < list.Len(); index += 1 {
		values = append(values, list.Get(index).String())
	}
	return values
}

func getBoolField(message protoreflect.Message, fieldName protoreflect.Name) bool {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil {
		return false
	}
	return message.Get(field).Bool()
}

func getMessageListField(
	message protoreflect.Message,
	fieldName protoreflect.Name,
) []protoreflect.Message {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil {
		return nil
	}

	list := message.Get(field).List()
	values := make([]protoreflect.Message, 0, list.Len())
	for index := 0; index < list.Len(); index += 1 {
		values = append(values, list.Get(index).Message())
	}
	return values
}

func getMessageField(
	message protoreflect.Message,
	fieldName protoreflect.Name,
) (protoreflect.Message, bool) {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil || !message.Has(field) {
		return nil, false
	}
	return message.Get(field).Message(), true
}

func getUint32Field(message protoreflect.Message, fieldName protoreflect.Name) uint32 {
	field := message.Descriptor().Fields().ByName(fieldName)
	if field == nil {
		return 0
	}
	return uint32(message.Get(field).Uint())
}

func validateMethodFields(method *methodSpec) (int, []Issue) {
	issues := make([]Issue, 0)
	seenFlags := make(map[string]string)
	seenPositionals := make(map[uint32]string)

	for _, field := range method.fields {
		positional := field.param.positional
		flag := field.param.flag

		if positional != nil && flag != nil {
			issues = append(issues, Issue{
				Descriptor: field.descriptor,
				Message:    method.name + "." + field.name + " cannot be both positional and flag-bound in cmdproto",
			})
		}

		if positional != nil {
			if !supportsPositional(field.descriptor) {
				issues = append(issues, Issue{
					Descriptor: field.descriptor,
					Message:    method.name + "." + field.name + " must be scalar or enum to be positional in cmdproto",
				})
			} else if existingField, ok := seenPositionals[positional.index]; ok {
				issues = append(issues, Issue{
					Descriptor: field.descriptor,
					Message:    method.name + " reuses positional index " + uint32String(positional.index) + " for " + field.name + " and " + existingField,
				})
			} else {
				seenPositionals[positional.index] = field.name
			}
		}

		if flag != nil {
			if !supportsFlag(field.descriptor) {
				issues = append(issues, Issue{
					Descriptor: field.descriptor,
					Message:    method.name + "." + field.name + " must be scalar, enum, or repeated scalar/enum to be a flag in cmdproto",
				})
			} else {
				registerFlag(seenFlags, method, field, "long", flag.long, &issues)
				registerFlag(seenFlags, method, field, "short", flag.short, &issues)
			}
		}
	}

	indices := make([]uint32, 0, len(seenPositionals))
	for index := range seenPositionals {
		indices = append(indices, index)
	}
	slices.Sort(indices)
	for expected := uint32(1); expected <= uint32(len(indices)); expected += 1 {
		if indices[expected-1] != expected {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " must use contiguous positional indexes starting at 1; missing " + uint32String(expected),
			})
			break
		}
	}

	return len(indices), issues
}

func validateMethodExamples(method *methodSpec, ctx *schemaContext) []Issue {
	issues := make([]Issue, 0)
	if len(method.command.examples) == 0 {
		return append(issues, Issue{
			Descriptor: method.descriptor,
			Message:    method.name + " must declare at least one cmdproto example",
		})
	}

	for _, example := range method.command.examples {
		commandText := strings.TrimSpace(example.command)
		if commandText == "" {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " has a cmdproto example with an empty command",
			})
			continue
		}

		if !exampleMatchesCommandBinding(commandText, method.command) {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " example \"" + commandText + "\" must start with the command path or an alias",
			})
		}

		requestJSON := strings.TrimSpace(example.requestJSON)
		if requestJSON == "" {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " example \"" + commandText + "\" is missing request_json",
			})
			continue
		}

		commandCanonical, err := validateExampleCommand(method, commandText, ctx)
		if err != nil {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " example \"" + commandText + "\" has invalid command example: " + err.Error(),
			})
			continue
		}
		requestCanonical, err := validateExampleRequestJSON(method, requestJSON, ctx)
		if err != nil {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " example \"" + commandText + "\" has invalid request_json: " + err.Error(),
			})
			continue
		}

		if commandCanonical != requestCanonical {
			issues = append(issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " example \"" + commandText + "\" does not match request_json params",
			})
		}
	}

	return issues
}

func validateExampleCommand(
	method *methodSpec,
	command string,
	ctx *schemaContext,
) (string, error) {
	tokens := splitCommandPath(command)
	match := findCommandMatchForMethod(method, tokens)
	if match == nil {
		return "", fmt.Errorf("must start with the command path or an alias")
	}
	params, err := parseArguments(method, tokens[len(match.tokens):])
	if err != nil {
		return "", err
	}
	return canonicalizeJSONMessage(method.input, params, ctx)
}

func validateExampleRequestJSON(
	method *methodSpec,
	requestJSON string,
	ctx *schemaContext,
) (string, error) {
	var payload any
	if err := json.Unmarshal([]byte(requestJSON), &payload); err != nil {
		return "", err
	}
	if payload == nil {
		return "", fmt.Errorf("request_json must be a JSON object")
	}
	if _, ok := payload.(map[string]any); !ok {
		return "", fmt.Errorf("request_json must be a JSON object")
	}
	return canonicalizeJSONMessage(method.input, payload, ctx)
}

func canonicalizeJSONMessage(
	message protoreflect.MessageDescriptor,
	value any,
	ctx *schemaContext,
) (string, error) {
	jsonBytes, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	msg := dynamicpb.NewMessage(message)
	unmarshalOptions := protojson.UnmarshalOptions{
		DiscardUnknown: false,
		Resolver:       ctx.types,
	}
	if err := unmarshalOptions.Unmarshal(jsonBytes, msg); err != nil {
		return "", err
	}
	marshalOptions := protojson.MarshalOptions{
		Resolver:      ctx.types,
		Multiline:     false,
		UseProtoNames: false,
	}
	normalized, err := marshalOptions.Marshal(msg)
	if err != nil {
		return "", err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, normalized); err != nil {
		return "", err
	}
	return compact.String(), nil
}

func collectCommandBindings(
	method *methodSpec,
	positionalCount int,
	issues *[]Issue,
) []commandBinding {
	bindings := make([]commandBinding, 0, 1+len(method.command.aliases))
	values := make([]struct {
		label string
		raw   string
	}, 0, 1+len(method.command.aliases))
	values = append(values, struct {
		label string
		raw   string
	}{
		label: "path",
		raw:   method.command.path,
	})
	for _, alias := range method.command.aliases {
		values = append(values, struct {
			label string
			raw   string
		}{
			label: "alias",
			raw:   alias,
		})
	}

	for _, value := range values {
		key, ok := validateCommandPath(method, value.raw, value.label, issues)
		if !ok {
			continue
		}
		bindings = append(bindings, commandBinding{
			key:             key,
			tokens:          splitCommandPath(key),
			method:          method,
			source:          value.label + " \"" + key + "\"",
			positionalCount: positionalCount,
		})
	}

	return bindings
}

func validateCommandPath(
	method *methodSpec,
	path string,
	label string,
	issues *[]Issue,
) (string, bool) {
	normalized := normalizeCommandPath(path)
	tokens := splitCommandPath(normalized)

	if len(tokens) == 0 {
		*issues = append(*issues, Issue{
			Descriptor: method.descriptor,
			Message:    method.name + " is missing cmdproto " + label,
		})
		return "", false
	}
	if _, ok := reservedCommandRoots[tokens[0]]; ok {
		*issues = append(*issues, Issue{
			Descriptor: method.descriptor,
			Message:    method.name + " uses reserved command root \"" + tokens[0] + "\" in " + label + " \"" + normalized + "\"",
		})
		return "", false
	}
	for _, token := range tokens {
		if !commandTokenRe.MatchString(token) {
			*issues = append(*issues, Issue{
				Descriptor: method.descriptor,
				Message:    method.name + " has invalid command token \"" + token + "\" in " + label + " \"" + normalized + "\"",
			})
			return "", false
		}
	}

	return normalized, true
}

func registerFlag(
	seenFlags map[string]string,
	method *methodSpec,
	field *fieldSpec,
	kind string,
	rawValue string,
	issues *[]Issue,
) {
	value := strings.TrimSpace(rawValue)
	if value == "" {
		return
	}

	switch kind {
	case "long":
		if !longFlagRe.MatchString(value) {
			*issues = append(*issues, Issue{
				Descriptor: field.descriptor,
				Message:    method.name + "." + field.name + " has invalid long flag \"" + value + "\"",
			})
			return
		}
		if _, ok := reservedLongFlags[value]; ok {
			*issues = append(*issues, Issue{
				Descriptor: field.descriptor,
				Message:    method.name + "." + field.name + " uses reserved long flag \"--" + value + "\"",
			})
			return
		}
	case "short":
		if !shortFlagRe.MatchString(value) {
			*issues = append(*issues, Issue{
				Descriptor: field.descriptor,
				Message:    method.name + "." + field.name + " has invalid short flag \"" + value + "\"",
			})
			return
		}
		if _, ok := reservedShortFlags[value]; ok {
			*issues = append(*issues, Issue{
				Descriptor: field.descriptor,
				Message:    method.name + "." + field.name + " uses reserved short flag \"-" + value + "\"",
			})
			return
		}
	default:
		return
	}

	key := kind + ":" + value
	if existingField, ok := seenFlags[key]; ok {
		*issues = append(*issues, Issue{
			Descriptor: field.descriptor,
			Message:    method.name + " reuses " + kind + " flag \"" + value + "\" for " + field.name + " and " + existingField,
		})
		return
	}
	seenFlags[key] = field.name
}

func validatePrefixShadowing(
	shorter commandBinding,
	longer commandBinding,
) (Issue, bool) {
	if shorter.positionalCount == 0 {
		return Issue{}, false
	}
	if len(shorter.tokens) >= len(longer.tokens) {
		return Issue{}, false
	}
	if !isPrefix(shorter.tokens, longer.tokens) {
		return Issue{}, false
	}

	return Issue{
		Descriptor: shorter.method.descriptor,
		Message: shorter.method.name + " " + shorter.source + " is a prefix of " +
			longer.method.name + " " + longer.source +
			"; commands with positional arguments cannot shadow longer command paths",
	}, true
}

func exampleMatchesCommandBinding(commandText string, command commandOptions) bool {
	tokens := splitCommandPath(commandText)
	if len(tokens) == 0 {
		return false
	}

	for _, rawPath := range append([]string{command.path}, command.aliases...) {
		bindingTokens := splitCommandPath(rawPath)
		if startsWithTokens(tokens, bindingTokens) {
			return true
		}
	}

	return false
}

func supportsPositional(field protoreflect.FieldDescriptor) bool {
	return !field.IsList() && isScalarOrEnum(field)
}

func supportsFlag(field protoreflect.FieldDescriptor) bool {
	if field.IsMap() {
		return false
	}
	if field.IsList() {
		return isScalarOrEnum(field)
	}
	return isScalarOrEnum(field)
}

func isScalarOrEnum(field protoreflect.FieldDescriptor) bool {
	if field.IsMap() {
		return false
	}
	switch field.Kind() {
	case protoreflect.EnumKind:
		return true
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return false
	default:
		return true
	}
}

func normalizeCommandPath(path string) string {
	return strings.Join(splitCommandPath(path), " ")
}

func splitCommandPath(path string) []string {
	return strings.Fields(strings.TrimSpace(path))
}

func startsWithTokens(tokens []string, prefix []string) bool {
	if len(tokens) < len(prefix) {
		return false
	}
	for index, token := range prefix {
		if tokens[index] != token {
			return false
		}
	}
	return true
}

func isPrefix(prefix []string, tokens []string) bool {
	for index, token := range prefix {
		if tokens[index] != token {
			return false
		}
	}
	return true
}

func uint32String(value uint32) string {
	return strconv.FormatUint(uint64(value), 10)
}

func parseArguments(method *methodSpec, argv []string) (map[string]any, error) {
	params := map[string]any{}
	positionals := getPositionalFields(method)
	flags := buildFlagIndex(method.fields)
	positionalIndex := 0
	positionalOnly := false

	for index := 0; index < len(argv); index += 1 {
		token := argv[index]
		if !positionalOnly && token == "--" {
			positionalOnly = true
			continue
		}
		if !positionalOnly && isFlagToken(token) {
			parsed := parseFlagToken(token)
			field := flags[parsed.name]
			if field == nil {
				return nil, fmt.Errorf("unknown flag: %s", parsed.name)
			}
			value, consumedNext, err := parseFlagValue(field, parsed.value, nextToken(argv, index+1))
			if err != nil {
				return nil, err
			}
			setParam(params, field, value)
			if consumedNext {
				index += 1
			}
			continue
		}

		if positionalIndex >= len(positionals) {
			return nil, fmt.Errorf("unexpected positional argument: %s", token)
		}
		field := positionals[positionalIndex]
		value, err := parseCLIValue(field.descriptor, token)
		if err != nil {
			return nil, err
		}
		setParam(params, field, value)
		positionalIndex += 1
	}

	for _, field := range positionals {
		if _, ok := params[field.jsonName]; !ok {
			return nil, fmt.Errorf("missing positional argument: %s", field.name)
		}
	}

	return params, nil
}

func nextToken(argv []string, index int) string {
	if index >= len(argv) {
		return ""
	}
	return argv[index]
}

func getPositionalFields(method *methodSpec) []*fieldSpec {
	fields := make([]*fieldSpec, 0)
	for _, field := range method.fields {
		if field.param.positional != nil && !field.param.hidden {
			fields = append(fields, field)
		}
	}
	slices.SortFunc(fields, func(left, right *fieldSpec) int {
		return int(left.param.positional.index) - int(right.param.positional.index)
	})
	return fields
}

func getFlagFields(method *methodSpec) []*fieldSpec {
	fields := make([]*fieldSpec, 0)
	for _, field := range method.fields {
		if field.param.flag != nil && !field.param.hidden {
			fields = append(fields, field)
		}
	}
	slices.SortFunc(fields, func(left, right *fieldSpec) int {
		return strings.Compare(left.name, right.name)
	})
	return fields
}

func buildFlagIndex(fields []*fieldSpec) map[string]*fieldSpec {
	index := make(map[string]*fieldSpec)
	for _, field := range fields {
		if field.param.hidden || field.param.flag == nil {
			continue
		}
		if field.param.flag.long != "" {
			index["--"+field.param.flag.long] = field
		}
		if field.param.flag.short != "" {
			index["-"+field.param.flag.short] = field
		}
	}
	return index
}

func isFlagToken(token string) bool {
	return (strings.HasPrefix(token, "--") && len(token) > 2) ||
		(strings.HasPrefix(token, "-") && len(token) > 1)
}

type parsedFlagToken struct {
	name  string
	value *string
}

func parseFlagToken(token string) parsedFlagToken {
	if equals := strings.Index(token, "="); equals >= 0 {
		value := token[equals+1:]
		return parsedFlagToken{
			name:  token[:equals],
			value: &value,
		}
	}
	return parsedFlagToken{name: token}
}

func parseFlagValue(
	field *fieldSpec,
	inlineValue *string,
	nextValue string,
) (any, bool, error) {
	if isBooleanField(field.descriptor) {
		if inlineValue == nil {
			return true, false, nil
		}
		value, err := parseBoolean(*inlineValue)
		return value, false, err
	}

	value := nextValue
	consumedNext := true
	if inlineValue != nil {
		value = *inlineValue
		consumedNext = false
	}
	if value == "" {
		return nil, false, fmt.Errorf("flag %s requires a value", renderPreferredFlag(field))
	}
	parsed, err := parseCLIValue(field.descriptor, value)
	return parsed, consumedNext, err
}

func setParam(params map[string]any, field *fieldSpec, value any) {
	if field.descriptor.IsList() {
		current, _ := params[field.jsonName].([]any)
		params[field.jsonName] = append(current, value)
		return
	}
	params[field.jsonName] = value
}

func parseCLIValue(field protoreflect.FieldDescriptor, raw string) (any, error) {
	if field.IsList() {
		if field.Kind() == protoreflect.EnumKind {
			return raw, nil
		}
		return parseScalarValue(field.Kind(), raw, string(field.Name()))
	}
	if field.Kind() == protoreflect.EnumKind {
		return raw, nil
	}
	return parseScalarValue(field.Kind(), raw, string(field.Name()))
}

func parseScalarValue(kind protoreflect.Kind, raw string, fieldName string) (any, error) {
	switch kind {
	case protoreflect.BoolKind:
		return parseBoolean(raw)
	case protoreflect.DoubleKind,
		protoreflect.FloatKind,
		protoreflect.Int32Kind,
		protoreflect.Uint32Kind,
		protoreflect.Sint32Kind,
		protoreflect.Fixed32Kind,
		protoreflect.Sfixed32Kind:
		return parseNumber(raw, fieldName)
	case protoreflect.Int64Kind,
		protoreflect.Uint64Kind,
		protoreflect.Sint64Kind,
		protoreflect.Fixed64Kind,
		protoreflect.Sfixed64Kind,
		protoreflect.StringKind,
		protoreflect.BytesKind:
		return raw, nil
	default:
		return raw, nil
	}
}

func isBooleanField(field protoreflect.FieldDescriptor) bool {
	if field.IsList() {
		return field.Kind() == protoreflect.BoolKind
	}
	return field.Kind() == protoreflect.BoolKind
}

func parseBoolean(raw string) (bool, error) {
	switch raw {
	case "true", "1":
		return true, nil
	case "false", "0":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean value: %s", raw)
	}
}

func parseNumber(raw string, fieldName string) (float64, error) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number for %s: %s", fieldName, raw)
	}
	return value, nil
}

func findCommandMatchForMethod(
	method *methodSpec,
	argv []string,
) *commandBinding {
	for _, binding := range commandBindings(method) {
		if startsWithTokens(argv, binding.tokens) {
			copy := binding
			return &copy
		}
	}
	return nil
}

func commandBindings(method *methodSpec) []commandBinding {
	bindings := make([]commandBinding, 0, 1+len(method.command.aliases))
	for _, raw := range append([]string{method.command.path}, method.command.aliases...) {
		normalized := normalizeCommandPath(raw)
		bindings = append(bindings, commandBinding{
			key:    normalized,
			tokens: splitCommandPath(normalized),
			method: method,
		})
	}
	return bindings
}

func renderPreferredFlag(field *fieldSpec) string {
	if field.param.flag == nil {
		return field.name
	}
	if field.param.flag.long != "" {
		return "--" + field.param.flag.long
	}
	return "-" + field.param.flag.short
}

func buildManifest(methods []*methodSpec, ctx *schemaContext, descriptorHash string) (*cmdprotov1.RuntimeManifest, []Issue, error) {
	sorted := slices.Clone(methods)
	slices.SortFunc(sorted, func(left, right *methodSpec) int {
		if cmp := strings.Compare(normalizeCommandPath(left.command.path), normalizeCommandPath(right.command.path)); cmp != 0 {
			return cmp
		}
		return strings.Compare(left.name, right.name)
	})

	manifest := &cmdprotov1.RuntimeManifest{}
	manifest.SetManifestVersion(manifestVersion)
	manifest.SetHelpJsonVersion(helpJSONVersion)
	manifest.SetDescriptorSetSha256(descriptorHash)
	execute := &cmdprotov1.RuntimeExecute{}
	execute.SetName(executeName)
	execute.SetUsage(executeUsage)
	execute.SetSummary(executeSummary)
	executeHelp := &cmdprotov1.RuntimeHelpSurface{}
	executeHelp.SetText(renderExecuteHelp())
	executeHelp.SetJson(mustJSONString(buildExecuteHelpSummaryJSON()))
	execute.SetHelp(executeHelp)
	manifest.SetExecute(execute)
	controlHelp := &cmdprotov1.RuntimeHelpSurface{}
	controlHelp.SetText(renderControlHelp())
	controlHelp.SetJson(mustJSONString(map[string]any{
		"execute": buildExecuteHelpSummaryJSON(),
	}))
	manifest.SetControlHelp(controlHelp)
	rootHelp := &cmdprotov1.RuntimeHelpSurface{}
	rootHelp.SetText(renderRootHelp(sorted))
	rootHelp.SetJson(mustJSONString(buildRootHelpJSON(sorted)))
	manifest.SetRootHelp(rootHelp)
	commands := make([]*cmdprotov1.RuntimeCommand, 0, len(sorted))
	for _, method := range sorted {
		payloads := make([]compiledExample, 0, len(method.command.examples))
		for _, example := range method.command.examples {
			canonical, err := compileExamplePayload(method, example.requestJSON, ctx)
			if err != nil {
				return nil, nil, err
			}
			payloads = append(payloads, compiledExample{
				humanCommand: example.command,
				description:  example.description,
				payloadJSON:  canonical,
			})
		}
		command := buildRuntimeCommand(method, payloads)
		commands = append(commands, command)
	}
	manifest.SetCommands(commands)
	return manifest, nil, nil
}

type compiledExample struct {
	humanCommand string
	description  string
	payloadJSON  string
}

func compileExamplePayload(
	method *methodSpec,
	requestJSON string,
	ctx *schemaContext,
) (string, error) {
	if ctx == nil {
		var payload any
		if err := json.Unmarshal([]byte(requestJSON), &payload); err != nil {
			return "", err
		}
		normalized, err := json.Marshal(payload)
		if err != nil {
			return "", err
		}
		return string(normalized), nil
	}
	return validateExampleRequestJSON(method, requestJSON, ctx)
}

func buildRuntimeCommand(method *methodSpec, examples []compiledExample) *cmdprotov1.RuntimeCommand {
	command := &cmdprotov1.RuntimeCommand{}
	command.SetMethod(method.name)
	command.SetService(method.service)
	command.SetRpc(method.rpc)
	command.SetInputType(string(method.input.FullName()))
	command.SetOutputType(string(method.output.FullName()))
	command.SetCanonicalPath(normalizeCommandPath(method.command.path))
	command.SetAliases(normalizedAliases(method.command.aliases))
	command.SetPreferredMachinePath(preferredMachinePath(method))
	command.SetBindings(commandBindingStrings(method))
	command.SetSummary(method.command.summary)
	command.SetUsage(renderMethodUsage(method))
	command.SetMachineUsage(renderExecuteTemplate(method))
	command.SetHidden(method.command.hidden)
	command.SetDeprecated(method.command.deprecated || methodDeprecated(method.descriptor))
	command.SetParsePlan(buildParsePlan(method))
	command.SetParams(buildRuntimeParams(method))
	commandExamples := make([]*cmdprotov1.RuntimeExample, 0, len(examples))
	for _, example := range examples {
		runtimeExample := &cmdprotov1.RuntimeExample{}
		runtimeExample.SetDescription(example.description)
		runtimeExample.SetHumanCommand(example.humanCommand)
		runtimeExample.SetMachineCommand(renderExecuteExampleCommand(command.GetPreferredMachinePath(), example.payloadJSON))
		runtimeExample.SetPayloadJson(example.payloadJSON)
		commandExamples = append(commandExamples, runtimeExample)
	}
	command.SetExamples(commandExamples)
	help := &cmdprotov1.RuntimeHelpSurface{}
	help.SetText(renderMethodHelp(method, command))
	help.SetJson(mustJSONString(buildCommandHelpJSON(command)))
	command.SetHelp(help)
	return command
}

func normalizedAliases(aliases []string) []string {
	out := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		out = append(out, normalizeCommandPath(alias))
	}
	return out
}

func methodDeprecated(method protoreflect.MethodDescriptor) bool {
	options, _ := method.Options().(*descriptorpb.MethodOptions)
	return options != nil && options.GetDeprecated()
}

func commandBindingStrings(method *methodSpec) []string {
	out := []string{normalizeCommandPath(method.command.path)}
	out = append(out, normalizedAliases(method.command.aliases)...)
	return out
}

func preferredMachinePath(method *methodSpec) string {
	candidates := commandBindingStrings(method)
	best := candidates[0]
	for _, candidate := range candidates[1:] {
		if len(candidate) < len(best) || (len(candidate) == len(best) && candidate < best) {
			best = candidate
		}
	}
	return best
}

func buildParsePlan(method *methodSpec) *cmdprotov1.RuntimeParsePlan {
	plan := &cmdprotov1.RuntimeParsePlan{}
	positionalJSONNames := make([]string, 0)
	flags := make([]*cmdprotov1.RuntimeFlagBinding, 0)
	for _, field := range getPositionalFields(method) {
		positionalJSONNames = append(positionalJSONNames, field.jsonName)
	}
	for _, field := range getFlagFields(method) {
		if field.param.positional != nil || field.param.flag == nil {
			continue
		}
		mode := cmdprotov1.RuntimeFlagValueMode_RUNTIME_FLAG_VALUE_MODE_REQUIRED
		if isBooleanField(field.descriptor) {
			mode = cmdprotov1.RuntimeFlagValueMode_RUNTIME_FLAG_VALUE_MODE_BOOLEAN_OPTIONAL
		}
		if field.param.flag.long != "" {
			flag := &cmdprotov1.RuntimeFlagBinding{}
			flag.SetToken("--" + field.param.flag.long)
			flag.SetJsonName(field.jsonName)
			flag.SetValueMode(mode)
			flag.SetRepeated(field.descriptor.IsList())
			flags = append(flags, flag)
		}
		if field.param.flag.short != "" {
			flag := &cmdprotov1.RuntimeFlagBinding{}
			flag.SetToken("-" + field.param.flag.short)
			flag.SetJsonName(field.jsonName)
			flag.SetValueMode(mode)
			flag.SetRepeated(field.descriptor.IsList())
			flags = append(flags, flag)
		}
	}
	slices.SortFunc(flags, func(left, right *cmdprotov1.RuntimeFlagBinding) int {
		return strings.Compare(left.GetToken(), right.GetToken())
	})
	plan.SetPositionalJsonNames(positionalJSONNames)
	plan.SetFlags(flags)
	return plan
}

func buildRuntimeParams(method *methodSpec) []*cmdprotov1.RuntimeParam {
	params := make([]*cmdprotov1.RuntimeParam, 0, len(method.fields))
	for _, field := range method.fields {
		param := &cmdprotov1.RuntimeParam{}
		param.SetProtoName(field.name)
		param.SetJsonName(field.jsonName)
		param.SetFieldNumber(field.number)
		param.SetJsonType(buildJSONType(field.descriptor))
		param.SetCliLabel(renderCLIFieldLabel(field))
		param.SetPositionLabel(field.param.positionLabel)
		param.SetDescription(field.param.help)
		param.SetHidden(field.param.hidden)
		if field.param.positional != nil {
			param.SetPositionalIndex(field.param.positional.index)
		}
		if field.param.flag != nil {
			param.SetLongFlag(field.param.flag.long)
			param.SetShortFlag(field.param.flag.short)
		}
		params = append(params, param)
	}
	slices.SortFunc(params, func(left, right *cmdprotov1.RuntimeParam) int {
		if left.GetPositionalIndex() != 0 || right.GetPositionalIndex() != 0 {
			if left.GetPositionalIndex() == 0 {
				return 1
			}
			if right.GetPositionalIndex() == 0 {
				return -1
			}
			if left.GetPositionalIndex() != right.GetPositionalIndex() {
				return int(left.GetPositionalIndex() - right.GetPositionalIndex())
			}
		}
		if cmp := strings.Compare(left.GetCliLabel(), right.GetCliLabel()); cmp != 0 {
			return cmp
		}
		return strings.Compare(left.GetJsonName(), right.GetJsonName())
	})
	return params
}

func buildJSONType(field protoreflect.FieldDescriptor) *cmdprotov1.RuntimeJsonType {
	switch {
	case field.IsMap():
		jsonType := &cmdprotov1.RuntimeJsonType{}
		jsonType.SetKind(cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_OBJECT)
		jsonType.SetDisplayName("object")
		return jsonType
	case field.IsList():
		elementKind, display := buildElementJSONType(field.Kind())
		jsonType := &cmdprotov1.RuntimeJsonType{}
		jsonType.SetKind(cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_ARRAY)
		jsonType.SetElementKind(elementKind)
		jsonType.SetDisplayName("array<" + display + ">")
		return jsonType
	case field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind:
		jsonType := &cmdprotov1.RuntimeJsonType{}
		jsonType.SetKind(cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_OBJECT)
		jsonType.SetDisplayName("object")
		return jsonType
	default:
		kind, display := buildElementJSONType(field.Kind())
		jsonType := &cmdprotov1.RuntimeJsonType{}
		jsonType.SetKind(kind)
		jsonType.SetDisplayName(display)
		return jsonType
	}
}

func buildElementJSONType(kind protoreflect.Kind) (cmdprotov1.RuntimeJsonTypeKind, string) {
	switch kind {
	case protoreflect.BoolKind:
		return cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_BOOLEAN, "boolean"
	case protoreflect.DoubleKind,
		protoreflect.FloatKind,
		protoreflect.Int32Kind,
		protoreflect.Uint32Kind,
		protoreflect.Sint32Kind,
		protoreflect.Fixed32Kind,
		protoreflect.Sfixed32Kind:
		return cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_NUMBER, "number"
	case protoreflect.MessageKind,
		protoreflect.GroupKind:
		return cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_OBJECT, "object"
	default:
		return cmdprotov1.RuntimeJsonTypeKind_RUNTIME_JSON_TYPE_KIND_STRING, "string"
	}
}

func renderMethodUsage(method *methodSpec) string {
	parts := []string{normalizeCommandPath(method.command.path)}
	for _, field := range getPositionalFields(method) {
		parts = append(parts, "<"+renderPlaceholder(field.name)+">")
	}
	for _, field := range getFlagFields(method) {
		if field.param.flag == nil {
			continue
		}
		names := make([]string, 0, 2)
		if field.param.flag.short != "" {
			names = append(names, "-"+field.param.flag.short)
		}
		if field.param.flag.long != "" {
			names = append(names, "--"+field.param.flag.long)
		}
		parts = append(parts, "["+strings.Join(names, ", ")+"]")
	}
	return strings.Join(parts, " ")
}

func renderPlaceholder(fieldName string) string {
	return strings.ToUpper(strings.ReplaceAll(nonAlphaNum.ReplaceAllString(fieldName, "_"), "__", "_"))
}

var nonAlphaNum = regexp.MustCompile(`[^A-Za-z0-9]+`)

func renderExecuteTemplate(method *methodSpec) string {
	return "cmdproto execute " + preferredMachinePath(method) + " --json '<payload>'"
}

func renderExecuteExampleCommand(path string, payloadJSON string) string {
	return "cmdproto execute " + path + " --json " + quoteShellArgument(payloadJSON)
}

func quoteShellArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func renderCLIFieldLabel(field *fieldSpec) string {
	if field.param.positional != nil {
		return "<" + renderPlaceholder(field.name) + ">"
	}
	if field.param.flag == nil {
		return "-"
	}
	names := make([]string, 0, 2)
	if field.param.flag.short != "" {
		names = append(names, "-"+field.param.flag.short)
	}
	if field.param.flag.long != "" {
		names = append(names, "--"+field.param.flag.long)
	}
	return strings.Join(names, ", ")
}

func renderFieldPosition(field *cmdprotov1.RuntimeParam) string {
	if field.GetPositionalIndex() == 0 {
		return "-"
	}
	return uint32String(field.GetPositionalIndex())
}

func renderRootHelp(methods []*methodSpec) string {
	lines := []string{"Application commands:", ""}
	for _, method := range methods {
		if method.command.hidden {
			continue
		}
		line := "  " + renderMethodUsage(method)
		if method.command.summary != "" {
			if len(line) < 30 {
				line = line + strings.Repeat(" ", 30-len(line))
			} else {
				line += " "
			}
			line += method.command.summary
		}
		lines = append(lines, strings.TrimRight(line, " "))
	}
	lines = append(lines,
		"",
		"Command help:",
		"  <command> --help",
		"  <command> --help --json",
		"",
		"Notes:",
		"  --help includes machine execution notes and type names.",
		"  --help --json prints compact payload-schema JSON.",
		"",
		"Machine control:",
		"  "+executeUsage+" "+executeSummary,
	)
	return strings.Join(lines, "\n") + "\n"
}

func renderControlHelp() string {
	return strings.Join([]string{
		"Machine control:",
		"",
		"  " + executeUsage + " " + executeSummary,
	}, "\n") + "\n"
}

func renderExecuteHelp() string {
	return strings.Join([]string{
		executeSummary,
		"",
		"Usage:",
		"  " + executeUsage,
		"",
		"Notes:",
		"  <path> resolves a declared command path or alias.",
		"  <payload> is the JSON params object for that command.",
	}, "\n") + "\n"
}

func renderMethodHelp(method *methodSpec, command *cmdprotov1.RuntimeCommand) string {
	lines := []string{
		fallbackSummary(method.command.summary, method.name),
		"",
		"Usage:",
		"  " + command.GetUsage(),
		"",
		"Machine method:",
		"  " + command.GetMethod(),
		"",
		"Machine execute:",
		"  " + command.GetMachineUsage(),
		"",
		"Payload type:",
		"  " + command.GetInputType(),
		"Result type:",
		"  " + command.GetOutputType(),
	}
	if len(command.GetAliases()) > 0 {
		lines = append(lines, "", "Aliases:", "  "+strings.Join(command.GetAliases(), ", "))
	}
	rows := make([][]string, 0)
	for _, param := range command.GetParams() {
		if param.GetHidden() {
			continue
		}
		rows = append(rows, []string{
			param.GetCliLabel(),
			param.GetJsonName(),
			renderFieldPosition(param),
			param.GetJsonType().GetDisplayName(),
			param.GetDescription(),
		})
	}
	lines = append(lines, "", "Parameters:")
	lines = append(lines, renderHelpTable(
		[]string{"CLI param", "JSON param", "Position", "Type", "Description"},
		rows,
	)...)
	if len(command.GetExamples()) > 0 {
		exampleRows := make([][]string, 0, len(command.GetExamples()))
		for _, example := range command.GetExamples() {
			exampleRows = append(exampleRows, []string{
				example.GetDescription(),
				example.GetHumanCommand(),
				example.GetMachineCommand(),
			})
		}
		lines = append(lines, "", "Examples:")
		lines = append(lines, renderHelpTable(
			[]string{"Description", "Normal cmd", "JSON cmd"},
			exampleRows,
		)...)
	}
	return strings.Join(lines, "\n") + "\n"
}

func fallbackSummary(summary, fallback string) string {
	if summary != "" {
		return summary
	}
	return fallback
}

func renderHelpTable(headers []string, rows [][]string) []string {
	widths := make([]int, len(headers))
	for index, header := range headers {
		widths[index] = len(header)
	}
	for _, row := range rows {
		for index, cell := range row {
			if len(cell) > widths[index] {
				widths[index] = len(cell)
			}
		}
	}
	renderRow := func(row []string) string {
		parts := make([]string, len(headers))
		for index := range headers {
			cell := ""
			if index < len(row) {
				cell = row[index]
			}
			parts[index] = padRight(cell, widths[index])
		}
		return strings.TrimRight("  "+strings.Join(parts, "  "), " ")
	}
	lines := []string{
		renderRow(headers),
		renderRow(repeatDashes(widths)),
	}
	for _, row := range rows {
		lines = append(lines, renderRow(row))
	}
	return lines
}

func repeatDashes(widths []int) []string {
	out := make([]string, len(widths))
	for index, width := range widths {
		out[index] = strings.Repeat("-", width)
	}
	return out
}

func padRight(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return value + strings.Repeat(" ", width-len(value))
}

func buildRootHelpJSON(methods []*methodSpec) map[string]any {
	commands := make([]map[string]any, 0)
	for _, method := range methods {
		if method.command.hidden {
			continue
		}
		entry := map[string]any{
			"path": preferredMachinePath(method),
		}
		if method.command.summary != "" {
			entry["summary"] = method.command.summary
		}
		commands = append(commands, entry)
	}
	return map[string]any{
		"commands": commands,
		"execute":  buildExecuteHelpSummaryJSON(),
	}
}

func buildExecuteHelpSummaryJSON() map[string]any {
	return map[string]any{
		"name":    executeName,
		"usage":   executeUsage,
		"summary": executeSummary,
	}
}

func buildCommandHelpJSON(command *cmdprotov1.RuntimeCommand) map[string]any {
	payloadSchema := make(map[string]any)
	for _, param := range command.GetParams() {
		if param.GetHidden() {
			continue
		}
		entry := map[string]any{
			"type": param.GetJsonType().GetDisplayName(),
		}
		if param.GetDescription() != "" {
			entry["help"] = param.GetDescription()
		}
		payloadSchema[param.GetJsonName()] = entry
	}
	examples := make([]map[string]any, 0, len(command.GetExamples()))
	for _, example := range command.GetExamples() {
		entry := map[string]any{
			"cmd": example.GetMachineCommand(),
		}
		if example.GetDescription() != "" {
			entry["description"] = example.GetDescription()
		}
		examples = append(examples, entry)
	}
	return map[string]any{
		"payload_schema": payloadSchema,
		"examples":       examples,
	}
}

func mustJSONString(value any) string {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(bytes)
}
