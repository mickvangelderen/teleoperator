---
name: application-guidance
description: Use when considering application changes.
---

# Application development guidance

## Provide sane defaults

Applications should provide sane defaults for their invocation parameters.
This keeps command invocations short and thereby makes it easy to spot non-default arguments.

## Documentation

GUI applications are able to describe themselves through their UI.
The most effective documentation is often a high level description and a screenshot or animation.

CLI applications are able to describe themselves through their help command.
The help command output does not need to be repeated in the documentation.

Unless requested otherwise, only the most commonly used commands and arguments need to be described.
