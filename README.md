# ide-zls

Provide Zig language features with ZLS.

Connects Zig editors to the open-source Zig Language Server through the shared ide-client service.

## Features

- **Diagnostics**: reports syntax and AST findings, plus compiler checks selected by the project.
- **Intelligence**: completes declarations, imports and builtins, with hover documentation and signatures.
- **Navigation**: finds definitions, references, document and workspace symbols, including the SDK standard library.
- **Refactoring**: renames source symbols and applies AST-check fixes.
- **Presentation**: supplies inferred types, parameter names and semantic tokens.
- **Formatting**: formats Zig source and ZON data with Zig formatting rules.
- **Managed installation**: fetches official native ZLS releases and verifies the published SHA256 digest.

## Installation

To install ide-zls search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-zls`.

Install `ide-client` and `language-zig` as well. Install the [Zig SDK](https://ziglang.org/download/), then use **Manage Servers** to install ZLS. The server and SDK must have the same major and minor version; the adapter checks both before launching and chooses a matching managed release. Select their native executables in the package settings when they are not on PATH.

## Usage

Open the project folder containing `build.zig`. ZLS uses the build runner to discover imported modules and the selected SDK for builtins, standard-library navigation and compiler tools. Stable Zig and ZLS 0.16.0 are supported together; Zig nightly builds require their matching ZLS development version and are outside managed stable installations.

AST diagnostics run while editing. Full compiler diagnostics can run on save when the project supplies a `check` build step; the adapter preserves ZLS's automatic detection by default. See the [upstream build-on-save guide](https://zigtools.org/zls/guides/build-on-save/). ZLS's comptime and semantic analysis remain incomplete, so compiler checks supply findings that source analysis alone cannot provide.

ZON files share the Zig grammar and server, with diagnostics, formatting and semantic tokens. Source completions, hover, signatures, symbols, references, rename, actions and hints are unavailable for ZON. ZLS does not advertise call hierarchy, type hierarchy, code lenses or range formatting.

## Services

- `ide-client`: consumed to register and manage native ZLS sessions.
- `background-tips.provider`: provided to explain project-aware imports and compiler checks.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
