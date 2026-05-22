package validator

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"buf.build/go/bufplugin/descriptor"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

const (
	commandOptionName = protoreflect.FullName("cmdproto.v1.command")
	paramOptionName   = protoreflect.FullName("cmdproto.v1.param")
)

var (
	commandTokenRe       = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	longFlagRe           = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	shortFlagRe          = regexp.MustCompile(`^[A-Za-z0-9]$`)
	reservedCommandRoots = map[string]struct{}{"cmdproto": {}}
	reservedLongFlags    = map[string]struct{}{"help": {}, "json": {}, "verbose": {}}
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
	method          protoreflect.MethodDescriptor
	source          string
	positionalCount int
}

type commandOptions struct {
	path     string
	aliases  []string
	examples []cliExample
}

type cliExample struct {
	command     string
	requestJSON string
}

type paramOptions struct {
	positionalIndex uint32
	hasPositional   bool
	longFlag        string
	shortFlag       string
	hasFlag         bool
}

func Validate(files []descriptor.FileDescriptor) []Issue {
	registry, ok := newExtensionRegistry(files)
	if !ok {
		return nil
	}

	issues := make([]Issue, 0)
	bindings := make([]commandBinding, 0)
	seenCommands := make(map[string]commandBinding)

	for _, file := range files {
		services := file.ProtoreflectFileDescriptor().Services()
		for serviceIndex := 0; serviceIndex < services.Len(); serviceIndex += 1 {
			service := services.Get(serviceIndex)
			methods := service.Methods()
			for methodIndex := 0; methodIndex < methods.Len(); methodIndex += 1 {
				method := methods.Get(methodIndex)
				commandMessage, ok, err := getExtensionMessage(
					method.Options(),
					registry.commandOption,
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

				command := readCommandOptions(commandMessage)
				positionalCount, fieldIssues := validateMethodFields(method, registry)
				issues = append(issues, fieldIssues...)
				issues = append(issues, validateCommandExamples(method, command)...)

				for _, binding := range collectCommandBindings(method, command, positionalCount, &issues) {
					existing, ok := seenCommands[binding.key]
					if ok {
						issues = append(issues, Issue{
							Descriptor: method,
							Message: "Duplicate command path \"" + binding.key + "\" for " +
								string(binding.method.FullName()) + "; already used by " +
								string(existing.method.FullName()),
						})
						continue
					}
					seenCommands[binding.key] = binding
					bindings = append(bindings, binding)
				}
			}
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

	return issues
}

func newExtensionRegistry(files []descriptor.FileDescriptor) (*extensionRegistry, bool) {
	var commandOption protoreflect.ExtensionDescriptor
	var paramOption protoreflect.ExtensionDescriptor

	for _, file := range files {
		if commandOption == nil {
			commandOption = findExtensionDescriptorInFile(file.ProtoreflectFileDescriptor(), commandOptionName)
		}
		if paramOption == nil {
			paramOption = findExtensionDescriptorInFile(file.ProtoreflectFileDescriptor(), paramOptionName)
		}
		if commandOption != nil && paramOption != nil {
			return &extensionRegistry{
				commandOption: commandOption,
				paramOption:   paramOption,
			}, true
		}
	}

	return nil, false
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

func readCommandOptions(message protoreflect.Message) commandOptions {
	exampleMessages := getMessageListField(message, "example")
	examples := make([]cliExample, 0, len(exampleMessages))
	for _, exampleMessage := range exampleMessages {
		examples = append(examples, cliExample{
			command:     getStringField(exampleMessage, "command"),
			requestJSON: getStringField(exampleMessage, "request_json"),
		})
	}

	return commandOptions{
		path:     getStringField(message, "path"),
		aliases:  getStringListField(message, "alias"),
		examples: examples,
	}
}

func readParamOptions(message protoreflect.Message) paramOptions {
	positionalMessage, hasPositionalMessage := getMessageField(message, "positional")
	flagMessage, hasFlagMessage := getMessageField(message, "flag")

	options := paramOptions{}
	if hasPositionalMessage {
		if index := getUint32Field(positionalMessage, "index"); index > 0 {
			options.positionalIndex = index
			options.hasPositional = true
		}
	}
	if hasFlagMessage {
		longFlag := strings.TrimSpace(getStringField(flagMessage, "long"))
		shortFlag := strings.TrimSpace(getStringField(flagMessage, "short"))
		if longFlag != "" || shortFlag != "" {
			options.longFlag = longFlag
			options.shortFlag = shortFlag
			options.hasFlag = true
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

func collectCommandBindings(
	method protoreflect.MethodDescriptor,
	command commandOptions,
	positionalCount int,
	issues *[]Issue,
) []commandBinding {
	bindings := make([]commandBinding, 0, 1+len(command.aliases))

	values := make([]struct {
		label string
		raw   string
	}, 0, 1+len(command.aliases))
	values = append(values, struct {
		label string
		raw   string
	}{
		label: "path",
		raw:   command.path,
	})
	for _, alias := range command.aliases {
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
	method protoreflect.MethodDescriptor,
	path string,
	label string,
	issues *[]Issue,
) (string, bool) {
	normalized := normalizeCommandPath(path)
	tokens := splitCommandPath(normalized)

	if len(tokens) == 0 {
		*issues = append(*issues, Issue{
			Descriptor: method,
			Message:    string(method.FullName()) + " is missing cmdproto " + label,
		})
		return "", false
	}
	if _, ok := reservedCommandRoots[tokens[0]]; ok {
		*issues = append(*issues, Issue{
			Descriptor: method,
			Message:    string(method.FullName()) + " uses reserved command root \"" + tokens[0] + "\" in " + label + " \"" + normalized + "\"",
		})
		return "", false
	}
	for _, token := range tokens {
		if !commandTokenRe.MatchString(token) {
			*issues = append(*issues, Issue{
				Descriptor: method,
				Message:    string(method.FullName()) + " has invalid command token \"" + token + "\" in " + label + " \"" + normalized + "\"",
			})
			return "", false
		}
	}

	return normalized, true
}

func validateMethodFields(
	method protoreflect.MethodDescriptor,
	registry *extensionRegistry,
) (int, []Issue) {
	issues := make([]Issue, 0)
	seenFlags := make(map[string]string)
	seenPositionals := make(map[uint32]string)

	fields := method.Input().Fields()
	for fieldIndex := 0; fieldIndex < fields.Len(); fieldIndex += 1 {
		field := fields.Get(fieldIndex)
		paramMessage, ok, err := getExtensionMessage(
			field.Options(),
			registry.paramOption,
		)
		if err != nil {
			issues = append(issues, Issue{
				Descriptor: field,
				Message:    "failed to decode cmdproto param option: " + err.Error(),
			})
			continue
		}
		if !ok {
			continue
		}

		options := readParamOptions(paramMessage)
		if options.hasPositional && options.hasFlag {
			issues = append(issues, Issue{
				Descriptor: field,
				Message:    string(method.FullName()) + "." + string(field.Name()) + " cannot be both positional and flag-bound in cmdproto",
			})
		}

		if options.hasPositional {
			if !supportsPositional(field) {
				issues = append(issues, Issue{
					Descriptor: field,
					Message:    string(method.FullName()) + "." + string(field.Name()) + " must be scalar or enum to be positional in cmdproto",
				})
			} else if existingField, ok := seenPositionals[options.positionalIndex]; ok {
				issues = append(issues, Issue{
					Descriptor: field,
					Message:    string(method.FullName()) + " reuses positional index " + uint32String(options.positionalIndex) + " for " + string(field.Name()) + " and " + existingField,
				})
			} else {
				seenPositionals[options.positionalIndex] = string(field.Name())
			}
		}

		if options.hasFlag {
			if !supportsFlag(field) {
				issues = append(issues, Issue{
					Descriptor: field,
					Message:    string(method.FullName()) + "." + string(field.Name()) + " must be scalar, enum, or repeated scalar/enum to be a flag in cmdproto",
				})
			} else {
				registerFlag(seenFlags, method, field, "long", options.longFlag, &issues)
				registerFlag(seenFlags, method, field, "short", options.shortFlag, &issues)
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
				Descriptor: method,
				Message:    string(method.FullName()) + " must use contiguous positional indexes starting at 1; missing " + uint32String(expected),
			})
			break
		}
	}

	return len(indices), issues
}

func validateCommandExamples(
	method protoreflect.MethodDescriptor,
	command commandOptions,
) []Issue {
	issues := make([]Issue, 0)
	if len(command.examples) == 0 {
		return append(issues, Issue{
			Descriptor: method,
			Message:    string(method.FullName()) + " must declare at least one cmdproto example",
		})
	}

	for _, example := range command.examples {
		commandText := strings.TrimSpace(example.command)
		if commandText == "" {
			issues = append(issues, Issue{
				Descriptor: method,
				Message:    string(method.FullName()) + " has a cmdproto example with an empty command",
			})
			continue
		}

		if !exampleMatchesCommandBinding(commandText, command) {
			issues = append(issues, Issue{
				Descriptor: method,
				Message:    string(method.FullName()) + " example \"" + commandText + "\" must start with the command path or an alias",
			})
		}

		requestJSON := strings.TrimSpace(example.requestJSON)
		if requestJSON == "" {
			issues = append(issues, Issue{
				Descriptor: method,
				Message:    string(method.FullName()) + " example \"" + commandText + "\" is missing request_json",
			})
			continue
		}

		if err := validateExampleRequestJSON(method, requestJSON); err != nil {
			issues = append(issues, Issue{
				Descriptor: method,
				Message:    string(method.FullName()) + " example \"" + commandText + "\" has invalid request_json: " + err.Error(),
			})
		}
	}

	return issues
}

func registerFlag(
	seenFlags map[string]string,
	method protoreflect.MethodDescriptor,
	field protoreflect.FieldDescriptor,
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
				Descriptor: field,
				Message:    string(method.FullName()) + "." + string(field.Name()) + " has invalid long flag \"" + value + "\"",
			})
			return
		}
		if _, ok := reservedLongFlags[value]; ok {
			*issues = append(*issues, Issue{
				Descriptor: field,
				Message:    string(method.FullName()) + "." + string(field.Name()) + " uses reserved long flag \"--" + value + "\"",
			})
			return
		}
	case "short":
		if !shortFlagRe.MatchString(value) {
			*issues = append(*issues, Issue{
				Descriptor: field,
				Message:    string(method.FullName()) + "." + string(field.Name()) + " has invalid short flag \"" + value + "\"",
			})
			return
		}
		if _, ok := reservedShortFlags[value]; ok {
			*issues = append(*issues, Issue{
				Descriptor: field,
				Message:    string(method.FullName()) + "." + string(field.Name()) + " uses reserved short flag \"-" + value + "\"",
			})
			return
		}
	default:
		return
	}

	key := kind + ":" + value
	if existingField, ok := seenFlags[key]; ok {
		*issues = append(*issues, Issue{
			Descriptor: field,
			Message:    string(method.FullName()) + " reuses " + kind + " flag \"" + value + "\" for " + string(field.Name()) + " and " + existingField,
		})
		return
	}
	seenFlags[key] = string(field.Name())
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

func validateExampleRequestJSON(
	method protoreflect.MethodDescriptor,
	requestJSON string,
) error {
	var request map[string]any
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return err
	}

	for key := range request {
		switch key {
		case "method", "params", "requestId":
		default:
			return fmt.Errorf("unknown request field: %s", key)
		}
	}

	methodValue, ok := request["method"].(string)
	if !ok || strings.TrimSpace(methodValue) == "" {
		return fmt.Errorf("request field method must be a non-empty string")
	}
	if methodValue != string(method.FullName()) {
		return fmt.Errorf("request field method must be %q", string(method.FullName()))
	}

	if requestID, ok := request["requestId"]; ok {
		if _, ok := requestID.(string); !ok {
			return fmt.Errorf("request field requestId must be a string")
		}
	}

	if params, ok := request["params"]; ok {
		if params == nil {
			return nil
		}
		if _, ok := params.(map[string]any); !ok {
			return fmt.Errorf("request field params must be an object")
		}
	}

	return nil
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
		Descriptor: shorter.method,
		Message: string(shorter.method.FullName()) + " " + shorter.source + " is a prefix of " +
			string(longer.method.FullName()) + " " + longer.source +
			"; commands with positional arguments cannot shadow longer command paths",
	}, true
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
