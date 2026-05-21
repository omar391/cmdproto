package validator

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBufLintAcceptsValidCmdprotoSchema(t *testing.T) {
	workspace := writeWorkspace(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc SessionCreate(SessionCreateRequest) returns (SessionCreateResponse) {
    option (cmdproto.v1.command) = {
      path: "session create"
      alias: "session new"
      summary: "Create a session."
    };
  }
}

message SessionCreateRequest {
  string workflow_ref = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
    }
  ];

  string profile_name = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "profile"
        short: "p"
      }
    }
  ];
}

message SessionCreateResponse {
  string session_id = 1;
}
`)

	command := exec.Command("buf", "lint", workspace, "--error-format=json")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("buf lint failed unexpectedly:\n%s", output)
	}
}

func TestBufLintRejectsDuplicateShortFlags(t *testing.T) {
	workspace := writeWorkspace(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc SessionCreate(SessionCreateRequest) returns (SessionCreateResponse) {
    option (cmdproto.v1.command) = {
      path: "session create"
    };
  }
}

message SessionCreateRequest {
  string profile_name = 1 [
    (cmdproto.v1.param) = {
      flag: {
        long: "profile"
        short: "p"
      }
    }
  ];

  string project_name = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "project"
        short: "p"
      }
    }
  ];
}

message SessionCreateResponse {
  string session_id = 1;
}
`)

	output := runBufLintExpectFailure(t, workspace)
	if !strings.Contains(output, "reuses short flag") {
		t.Fatalf("expected duplicate short flag error, got:\n%s", output)
	}
}

func TestBufLintRejectsPrefixShadowing(t *testing.T) {
	workspace := writeWorkspace(t, `
edition = "2024";

package app.v1;

import "cmdproto/v1/options.proto";

service AppService {
  rpc SessionLookup(SessionLookupRequest) returns (SessionLookupResponse) {
    option (cmdproto.v1.command) = {
      path: "session"
    };
  }

  rpc SessionCreate(SessionCreateRequest) returns (SessionCreateResponse) {
    option (cmdproto.v1.command) = {
      path: "session create"
    };
  }
}

message SessionLookupRequest {
  string session_name = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
    }
  ];
}

message SessionCreateRequest {
  string profile_name = 1;
}

message SessionLookupResponse {
  string session_id = 1;
}

message SessionCreateResponse {
  string session_id = 1;
}
`)

	output := runBufLintExpectFailure(t, workspace)
	if !strings.Contains(output, `is a prefix of`) {
		t.Fatalf("expected prefix-shadowing error, got:\n%s", output)
	}
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
lint:
  use:
    - STANDARD
    - CMDPROTO
plugins:
  - plugin: `+repoPath(t, "scripts", "buf-plugin-cmdproto")+`
`)
	writeFile(t, filepath.Join(workspace, "proto", "cmdproto", "v1", "options.proto"), string(optionsProto))
	writeFile(t, filepath.Join(workspace, "proto", "app", "v1", "app.proto"), appProto)

	return workspace
}

func runBufLintExpectFailure(t *testing.T, workspace string) string {
	t.Helper()

	command := exec.Command("buf", "lint", workspace, "--error-format=json")
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("expected buf lint to fail, but it passed:\n%s", output)
	}
	return string(output)
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

func repoPath(t *testing.T, parts ...string) string {
	t.Helper()

	pathParts := append([]string{"..", "..", "..", ".."}, parts...)
	path := filepath.Join(pathParts...)
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("resolve %s: %v", path, err)
	}
	return absolutePath
}
