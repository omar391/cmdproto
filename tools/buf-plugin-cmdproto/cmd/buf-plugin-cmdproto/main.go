package main

import (
	"context"

	"buf.build/go/bufplugin/check"
	"cmdproto.tools/buf-plugin-cmdproto/internal/validator"
)

const (
	categoryID = "CMDPROTO"
	ruleID     = "CMDPROTO_SCHEMA"
)

func main() {
	check.Main(
		&check.Spec{
			Rules: []*check.RuleSpec{
				{
					ID:          ruleID,
					CategoryIDs: []string{categoryID},
					Default:     true,
					Purpose:     "Validate cmdproto command and parameter annotations.",
					Type:        check.RuleTypeLint,
					Handler: check.RuleHandlerFunc(func(
						_ context.Context,
						responseWriter check.ResponseWriter,
						request check.Request,
					) error {
						for _, issue := range validator.Validate(request.FileDescriptors()) {
							responseWriter.AddAnnotation(
								check.WithDescriptor(issue.Descriptor),
								check.WithMessage(issue.Message),
							)
						}
						return nil
					}),
				},
			},
			Categories: []*check.CategorySpec{
				{
					ID:      categoryID,
					Purpose: "Validate cmdproto schema invariants at lint time.",
				},
			},
		},
	)
}
