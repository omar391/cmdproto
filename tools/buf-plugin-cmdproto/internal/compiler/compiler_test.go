package compiler

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	cmdprotov1 "cmdproto.tools/buf-plugin-cmdproto/internal/gen/cmdproto/v1"
)

func TestCompileDescriptorSetBytesBuildsManifestForGreeterStyleSchema(t *testing.T) {
	workspace := writeWorkspace(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc Greet(GreetRequest) returns (GreetResponse) {
    option (cmdproto.v1.command) = {
      path: "greet"
      alias: "hello"
      summary: "Render a greeting."
      example: {
        command: "greet Ada -s"
        description: "Render a loud greeting."
        request_json: "{\"name\":\"Ada\",\"shout\":true}"
      }
    };
  }
}

message GreetRequest {
  string name = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
      help: "Name to greet."
    }
  ];
  bool shout = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "shout"
        short: "s"
      }
      help: "Uppercase the greeting."
    }
  ];
}

message GreetResponse {
  string message = 1;
}
`)

	schemaPath := filepath.Join(workspace, "schema.binpb")
	command := exec.Command("buf", "build", filepath.Join(workspace, "proto"), "--as-file-descriptor-set", "-o", schemaPath)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("buf build failed:\n%s", output)
	}

	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema.binpb: %v", err)
	}

	manifest, issues, err := CompileDescriptorSetBytes(schemaBytes, "greeter")
	if err != nil {
		t.Fatalf("compile manifest: %v", err)
	}
	if len(issues) > 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}

	if got, want := manifest.GetManifestVersion(), uint32(manifestVersion); got != want {
		t.Fatalf("manifest version = %d, want %d", got, want)
	}
	if got, want := manifest.GetHelpJsonVersion(), uint32(helpJSONVersion); got != want {
		t.Fatalf("help json version = %d, want %d", got, want)
	}
	if manifest.GetDescriptorSetSha256() == "" {
		t.Fatal("descriptor hash was empty")
	}
	if manifest.GetExecute().GetUsage() != executeUsage {
		t.Fatalf("execute usage = %q, want %q", manifest.GetExecute().GetUsage(), executeUsage)
	}
	if len(manifest.GetCommands()) != 1 {
		t.Fatalf("command count = %d, want 1", len(manifest.GetCommands()))
	}

	commandManifest := manifest.GetCommands()[0]
	if got, want := commandManifest.GetCanonicalPath(), "greet"; got != want {
		t.Fatalf("canonical path = %q, want %q", got, want)
	}
	if got, want := commandManifest.GetPreferredMachinePath(), "greet"; got != want {
		t.Fatalf("preferred machine path = %q, want %q", got, want)
	}
	if got, want := strings.Join(commandManifest.GetBindings(), ","), "greet,hello"; got != want {
		t.Fatalf("bindings = %q, want %q", got, want)
	}
	if len(commandManifest.GetExamples()) != 1 {
		t.Fatalf("example count = %d, want 1", len(commandManifest.GetExamples()))
	}
	if got, want := commandManifest.GetExamples()[0].GetPayloadJson(), "{\"name\":\"Ada\",\"shout\":true}"; got != want {
		t.Fatalf("payload json = %q, want %q", got, want)
	}
	if got, want := commandManifest.GetExamples()[0].GetHumanCommand(), "greeter greet Ada -s"; got != want {
		t.Fatalf("human command = %q, want %q", got, want)
	}
	if got, want := commandManifest.GetExamples()[0].GetMachineCommand(), "greeter cmdproto execjson greet '{\"name\":\"Ada\",\"shout\":true}'"; got != want {
		t.Fatalf("machine command = %q, want %q", got, want)
	}

	if got, want := commandManifest.GetParsePlan().GetPositionalJsonNames()[0], "name"; got != want {
		t.Fatalf("first positional = %q, want %q", got, want)
	}
	if len(commandManifest.GetParsePlan().GetFlags()) != 2 {
		t.Fatalf("flag count = %d, want 2", len(commandManifest.GetParsePlan().GetFlags()))
	}

	rootHelp := map[string]any{}
	if err := json.Unmarshal([]byte(manifest.GetRootHelp().GetJson()), &rootHelp); err != nil {
		t.Fatalf("parse root help json: %v", err)
	}
	commands, _ := rootHelp["commands"].([]any)
	if len(commands) != 1 {
		t.Fatalf("root help command count = %d, want 1", len(commands))
	}

	commandHelp := map[string]any{}
	if err := json.Unmarshal([]byte(commandManifest.GetHelp().GetJson()), &commandHelp); err != nil {
		t.Fatalf("parse command help json: %v", err)
	}
	if got, want := commandHelp["machine_usage"], "cmdproto execjson greet <json|@file|@->"; got != want {
		t.Fatalf("machine_usage = %v, want %q", got, want)
	}
	if _, ok := commandHelp["payload_json_schema"].(map[string]any); !ok {
		t.Fatalf("payload_json_schema missing from command help json: %#v", commandHelp)
	}
}

func TestCompileDescriptorSetBytesRejectsCmdprotoExampleCommands(t *testing.T) {
	workspace := writeWorkspace(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc Greet(GreetRequest) returns (GreetResponse) {
    option (cmdproto.v1.command) = {
      path: "greet"
      summary: "Render a greeting."
      example: {
        command: "cmdproto execjson greet '{\"name\":\"Ada\",\"shout\":true}'"
        description: "Render a loud greeting."
        request_json: "{\"name\":\"Ada\",\"shout\":true}"
      }
    };
  }
}

message GreetRequest {
  string name = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
      help: "Name to greet."
    }
  ];
  bool shout = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "shout"
        short: "s"
      }
      help: "Uppercase the greeting."
    }
  ];
}

message GreetResponse {
  string message = 1;
}
`)

	schemaPath := filepath.Join(workspace, "schema.binpb")
	command := exec.Command("buf", "build", filepath.Join(workspace, "proto"), "--as-file-descriptor-set", "-o", schemaPath)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("buf build failed:\n%s", output)
	}

	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema.binpb: %v", err)
	}

	_, issues, err := CompileDescriptorSetBytes(schemaBytes, "greeter")
	if err != nil {
		t.Fatalf("compile manifest: %v", err)
	}
	if len(issues) == 0 {
		t.Fatal("expected at least one issue")
	}
	for _, issue := range issues {
		if strings.Contains(issue.Message, "must be human command syntax, not cmdproto control syntax") {
			return
		}
	}
	t.Fatalf("missing control-syntax issue in %v", issues)
}

func TestCompileDescriptorSetBytesBoundsRecursiveJSONSchema(t *testing.T) {
	manifest := compileTestManifest(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";
import "google/protobuf/struct.proto";

service AppService {
  rpc Signal(SignalRequest) returns (SignalResponse) {
    option (cmdproto.v1.command) = {
      path: "signal"
      summary: "Signal a recursive payload."
      example: {
        command: "signal --json {\"state\":\"ready\"}"
        request_json: "{\"payload\":{\"state\":\"ready\"}}"
      }
    };
  }
}

message SignalRequest {
  google.protobuf.Value payload = 1 [
    (cmdproto.v1.param) = { json: { enabled: true } }
  ];
}

message SignalResponse {}
`)

	commandHelp := map[string]any{}
	if err := json.Unmarshal([]byte(manifest.GetCommands()[0].GetHelp().GetJson()), &commandHelp); err != nil {
		t.Fatalf("parse command help json: %v", err)
	}
	schema := commandHelp["payload_json_schema"].(map[string]any)
	payload := schema["properties"].(map[string]any)["payload"].(map[string]any)
	structValue := payload["properties"].(map[string]any)["structValue"].(map[string]any)
	fields := structValue["properties"].(map[string]any)["fields"].(map[string]any)
	valueRef := fields["additionalProperties"].(map[string]any)["$ref"]
	if got, want := valueRef, "cmdproto://message/google.protobuf.Value"; got != want {
		t.Fatalf("recursive value ref = %v, want %q", got, want)
	}
}

func TestCompileDescriptorSetBytesFieldJSONSchemaOverrideStopsDescent(t *testing.T) {
	manifest := compileTestManifest(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";
import "google/protobuf/struct.proto";

service AppService {
  rpc Signal(SignalRequest) returns (SignalResponse) {
    option (cmdproto.v1.command) = {
      path: "signal"
      summary: "Signal an opaque payload."
      example: {
        command: "signal --json {\"state\":\"ready\"}"
        request_json: "{\"payload\":{\"state\":\"ready\"}}"
      }
    };
  }
}

message SignalRequest {
  google.protobuf.Value payload = 1 [
    (cmdproto.v1.param) = { json: { enabled: true } },
    (cmdproto.v1.field_json_schema) = {
      json: "{\"type\":\"object\",\"additionalProperties\":true}"
    }
  ];
}

message SignalResponse {}
`)

	commandHelp := map[string]any{}
	if err := json.Unmarshal([]byte(manifest.GetCommands()[0].GetHelp().GetJson()), &commandHelp); err != nil {
		t.Fatalf("parse command help json: %v", err)
	}
	schema := commandHelp["payload_json_schema"].(map[string]any)
	payload := schema["properties"].(map[string]any)["payload"]
	want := map[string]any{
		"type":                 "object",
		"additionalProperties": true,
	}
	if got := payload; !jsonEqual(got, want) {
		t.Fatalf("payload schema = %#v, want %#v", got, want)
	}
}

func TestCompileDescriptorSetBytesRejectsExcessiveJSONSchemaDepth(t *testing.T) {
	var messages strings.Builder
	for index := 0; index <= maxJSONSchemaMessageDepth; index += 1 {
		if index == maxJSONSchemaMessageDepth {
			fmt.Fprintf(&messages, "message Node%d { string value = 1; }\n", index)
			continue
		}
		if index == 0 {
			fmt.Fprintf(
				&messages,
				"message Node0 { Node1 next = 1 [(cmdproto.v1.param) = { json: { enabled: true } }]; }\n",
			)
			continue
		}
		fmt.Fprintf(&messages, "message Node%d { Node%d next = 1; }\n", index, index+1)
	}
	protoSource := fmt.Sprintf(`
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc Deep(Node0) returns (DeepResponse) {
    option (cmdproto.v1.command) = {
      path: "deep"
      summary: "Exercise bounded schema expansion."
      example: { command: "deep --json {}" request_json: "{\"next\":{}}" }
    };
  }
}

%s
message DeepResponse {}
`, messages.String())

	workspace := writeWorkspace(t, protoSource)
	schemaPath := filepath.Join(workspace, "schema.binpb")
	command := exec.Command("buf", "build", filepath.Join(workspace, "proto"), "--as-file-descriptor-set", "-o", schemaPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("buf build failed: %v\n%s", err, output)
	}
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema.binpb: %v", err)
	}
	_, _, err = CompileDescriptorSetBytes(schemaBytes, "deep")
	if err == nil || !strings.Contains(err.Error(), "exceeds maximum message depth") {
		t.Fatalf("compile error = %v, want bounded-depth error", err)
	}
}

func compileTestManifest(t *testing.T, protoSource string) *cmdprotov1.RuntimeManifest {
	t.Helper()
	workspace := writeWorkspace(t, protoSource)
	schemaPath := filepath.Join(workspace, "schema.binpb")
	command := exec.Command("buf", "build", filepath.Join(workspace, "proto"), "--as-file-descriptor-set", "-o", schemaPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("buf build failed: %v\n%s", err, output)
	}
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema.binpb: %v", err)
	}
	manifest, issues, err := CompileDescriptorSetBytes(schemaBytes, "test")
	if err != nil {
		t.Fatalf("compile manifest: %v", err)
	}
	if len(issues) > 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}
	return manifest
}

func jsonEqual(left, right any) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func writeWorkspace(t *testing.T, appProto string) string {
	t.Helper()

	workspace := t.TempDir()
	optionsProtoPath := repoPath(t, "proto", "cmdproto", "v1", "options.proto")
	optionsProto, err := os.ReadFile(optionsProtoPath)
	if err != nil {
		t.Fatalf("read options proto: %v", err)
	}

	writeFile(t, filepath.Join(workspace, "buf.yaml"), `version: v2
modules:
  - path: proto
`)
	writeFile(t, filepath.Join(workspace, "proto", "cmdproto", "v1", "options.proto"), string(optionsProto))
	writeFile(t, filepath.Join(workspace, "proto", "app", "v1", "app.proto"), appProto)
	return workspace
}

func repoPath(t *testing.T, parts ...string) string {
	t.Helper()
	root := findRepoRoot(t)
	all := append([]string{root}, parts...)
	return filepath.Join(all...)
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", "..", "..", ".."))
	return root
}

func writeFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
