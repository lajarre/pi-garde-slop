# pi-garde-slop

Approve public GitHub CLI writes before Pi runs them.

## tl;dr

Pi agents often use `gh` to create issues, comment on PRs, merge, or edit releases. `pi-garde-slop` lets private-repo writes pass, but pauses public-repo writes for a human approval prompt with redacted payloads and SHA-256 digests.

```bash
pi install npm:pi-garde-slop
```

Git install works before the npm package is published:

```bash
pi install git:github.com/lajarre/pi-garde-slop
```

## 30-second quickstart

1. Install the package.
2. Start Pi in a GitHub checkout with `gh` already authenticated.
3. Ask the agent to prepare a public GitHub write, for example an issue comment.
4. Review the approval prompt before the shell command runs.

The prompt shows the target repo, write class, command shape, validation hints, and payload digests. Inline bodies and API fields are redacted.

## what it protects

`pi-garde-slop` intercepts built-in Pi `bash` tool calls, extracts literal `gh` invocations, resolves their GitHub repo target, checks repo visibility with `gh repo view`, hashes reviewable payload files, and blocks or prompts before the shell command executes.

In scope:

- literal, AST-extracted `gh` commands;
- repo-scoped GitHub writes whose target repo can be resolved;
- public repo approval prompts in sessions with UI;
- fail-closed blocking for ambiguous, unsupported, unresolved, or no-UI public writes;
- session-local approval reuse for exact single-write signatures or exact ordered batch signatures.

Out of scope:

- generic SaaS write protection;
- wildcard approvals such as `gh *`;
- persistent audit logs;
- browser review UI;
- commands hidden behind aliases, shell functions, dynamic shell forms, opaque stdin, or editor/web prompts;
- non-repo-scoped writes such as repo creation or gist writes.

## supported reviewable write classes

Read-only `gh` commands pass through after classification. These repo-scoped write classes are reviewable when their arguments are literal, their target repo resolves, and their payload identity is deterministic:

| class | commands |
|---|---|
| issues | `gh issue create`, `edit`, `comment`, `close`, `reopen`, `delete`, `lock`, `unlock`, `transfer` |
| pull requests | `gh pr create`, `edit`, `comment`, `review`, `close`, `reopen`, `ready`, `merge`, `lock`, `unlock`, `update-branch`, `revert` |
| releases | `gh release create` |
| repositories | `gh repo edit`, `delete`, `rename`, `archive`, `unarchive` |
| labels | `gh label create`, `edit`, `delete` |
| actions | `gh workflow run` |
| secrets and variables | repo-scoped `gh secret set` and `gh variable set` |
| REST API | repo-scoped `gh api` writes using `POST`, `PATCH`, `PUT`, or `DELETE`, including field flags that imply `POST` |

## unsupported or ambiguous forms

These forms always block instead of asking for approval:

- dynamic command words, dynamic subcommands, command substitutions, process substitutions, parameter/arithmetic expansions, globs, brace expansion, and non-literal assignments that can affect `gh`;
- shell functions, aliases, `eval`, `source`, shell `-c` scripts, and shell executables reading opaque stdin;
- `gh` commands that read opaque stdin, including `gh api --input -`, heredocs, stdin redirection, or pipeline stdin;
- `--editor` and `--web` prompts;
- unknown `gh` groups or possible write subcommands;
- `gh repo create`, because the target repo does not exist yet;
- `gh gist create|edit|delete`, because gist writes are not repo-scoped;
- repo-less API writes and GraphQL mutations, including file-backed GraphQL payloads that may hide a mutation;
- org/user-scoped forms outside the repo-scoped approval path, such as non-repo-scoped secrets or variables;
- unreadable payload files or payload files that cannot be hashed deterministically.

Rewrite blocked commands as literal, repo-scoped commands with reviewable local payload files:

```bash
gh issue comment 123 -R owner/repo --body-file .tmp/body.md
gh api repos/owner/repo/issues --input .tmp/payload.json
```

## repo visibility policy

Repo targets resolve in this order:

1. `-R` / `--repo`;
2. command-specific positional repo targets such as `gh repo edit owner/repo`;
3. repo-scoped REST paths such as `gh api repos/owner/repo/issues ...`;
4. literal `GH_REPO=owner/repo` assignment;
5. the current directory GitHub `origin` remote.

Conflicting explicit targets block. Unresolved targets block. Metadata lookup always uses the resolved target explicitly; cwd defaults do not override explicit targets.

Policy after metadata lookup:

- private repo writes are allowed without approval;
- public repo writes require approval;
- PR writes against a fork require approval when the fork parent is public, even if the fork itself is private;
- `ADMIN`, maintainer, or write permission does not bypass the gate;
- non-repo-scoped or unsupported writes block.

## approval reuse

Approvals are kept in memory for the current extension session only.

A single-write approval is reused only when the exact signature repeats. The signature includes the normalized command, write class, resolved repo metadata, target identity, payload identity, and payload digest.

A batch approval is all-or-none for the exact ordered batch. Reordered, subset, or superset batches are different signatures and require a new prompt.

File-backed payload identity is content-based. The signature includes the referenced path and a digest of the file contents at approval time. Same path with changed contents, changed path, changed flags, changed target, changed repo, or changed metadata yields a different signature.

## no-UI behavior

When `ctx.hasUI` is false, public writes block because no approval prompt can be shown. The block guidance asks the agent to prepare reviewable local artifacts under `.tmp/`, such as:

- `.tmp/body.md` for issue, PR, comment, or review text;
- `.tmp/notes.md` for release notes;
- `.tmp/payload.json` for `gh api --input file.json`;
- the exact `gh` command to run manually;
- a local diff/stat or patch for PR creation review.

Read-only commands and private repo writes do not need public-write approval.

## prerequisites

- Pi with package support.
- GitHub CLI (`gh`) installed and authenticated.
- Repository commands should use `-R owner/repo`, `GH_REPO=owner/repo`, a repo-scoped REST path, or a GitHub `origin` remote.
- Interactive Pi UI for public write approvals.

## package reference

`package.json` declares the Pi extension manifest:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/github-write-approval/index.ts"]
  }
}
```

Runtime dependency:

- `just-bash` for conservative shell AST extraction.

Pi core is a peer dependency and is not bundled.

## development

```bash
npm install
npm run check
npm test
npm run test:fixtures
npm pack --dry-run
```

Local Pi smoke test:

```bash
pi -e . -p "Use no tools. Say pi-garde-slop loaded."
```

## license

ISC
