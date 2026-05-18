# github-write-approval

Pi extension that intercepts built-in `bash` tool calls, extracts reviewable `gh` invocations, and gates public GitHub writes before the shell command runs.

## scope

This extension handles GitHub CLI commands inside Pi `bash` tool calls.

In scope:

- literal, AST-extracted `gh` commands;
- repo-scoped GitHub writes whose target repo can be resolved and checked with `gh repo view owner/repo --json nameWithOwner,isPrivate,visibility,isFork,parent,viewerPermission`;
- public repo approval prompts in sessions with UI;
- fail-closed blocking for ambiguous, unsupported, unresolved, or no-UI public writes;
- session-local approval reuse for exact single-write signatures or exact ordered batch signatures.

Non-goals for v1:

- generic SaaS write protection;
- wildcard approvals such as `gh *`;
- persistent audit logs;
- browser review UI;
- approving commands hidden behind aliases, shell functions, dynamic shell forms, opaque stdin, or editor/web prompts;
- approving non-repo-scoped writes such as repo creation or gist writes.

## supported reviewable write classes

Read-only `gh` commands pass through after classification. The following repo-scoped write classes are reviewable when their arguments are literal, their target repo resolves, and their payload identity is deterministic:

| Class | Commands |
|---|---|
| Issues | `gh issue create`, `edit`, `comment`, `close`, `reopen`, `delete`, `lock`, `unlock`, `transfer` |
| Pull requests | `gh pr create`, `edit`, `comment`, `review`, `close`, `reopen`, `ready`, `merge`, `lock`, `unlock`, `update-branch`, `revert` |
| Releases | `gh release create` |
| Repositories | `gh repo edit`, `delete`, `rename`, `archive`, `unarchive` |
| Labels | `gh label create`, `edit`, `delete` |
| Actions | `gh workflow run` |
| Secrets and variables | repo-scoped `gh secret set` and `gh variable set` |
| REST API | repo-scoped `gh api` writes using `POST`, `PATCH`, `PUT`, or `DELETE`, including field flags that imply `POST` |

## unsupported or ambiguous forms

These forms always block in v1 instead of asking for approval:

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

Rewrite blocked commands as literal, repo-scoped `gh ... -R owner/repo ...` commands with reviewable local payload files, for example `--body-file .tmp/body.md` or `gh api --input .tmp/payload.json`.

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
- non-repo-scoped or unsupported writes block in v1.

## approval reuse

Approvals are kept in memory for the current extension session only.

A single-write approval is reused only when the exact signature repeats. The signature includes the normalized command, write class, resolved repo metadata, target identity, payload identity, and payload digest.

A batch approval is all-or-none for the exact ordered batch. The ordered batch signature includes every write in order. Reordered, subset, or superset batches are different signatures and require a new prompt.

File-backed payload identity is content-based. The signature includes the referenced path and a digest of the file contents at approval time. Same path with changed contents, changed path, changed flags, changed target, changed repo, or changed metadata yields a different signature. If a referenced file cannot be read and hashed, the command blocks.

## no-UI behavior and local artifacts

When `ctx.hasUI` is false, public writes block because no approval prompt can be shown. The block guidance asks the agent to prepare reviewable local artifacts under `.tmp/`, such as:

- `.tmp/body.md` for issue, PR, comment, or review text;
- `.tmp/notes.md` for release notes;
- `.tmp/payload.json` for `gh api --input file.json`;
- the exact `gh` command to run manually;
- a local diff/stat or patch for PR creation review.

Read-only commands and private repo writes do not need public-write approval.

## validation advice shown in prompts

Approval prompts include deterministic validation hints when relevant:

- `gh pr create`: `--dry-run` is not trusted as safe because it may still push; prefer an explicitly pushed branch and review local diff/stat;
- `gh pr merge`: prefer `--match-head-commit`;
- `gh release create`: prefer `--verify-tag`;
- body/comment/review writes: prefer `--body-file` and review the local file contents against the payload digest;
- release notes: prefer `--notes-file` and review the local file contents against the payload digest;
- `gh api`: prefer `--input file.json`; opaque stdin is blocked, and prompts ask reviewers to compare the local JSON payload with the digest.

## prompt redaction and payload digests

Prompts and durable summaries do not display raw inline payload values or secret values. Inline values from flags such as `--body`, `--notes`, `-f`, `-F`, `--field`, and `--raw-field` are shown as redacted text with a SHA-256 digest. File-backed payloads show the flag, file path, and SHA-256 digest of the file contents. The signature input remains content-based and exact even though the prompt display is redacted.

## QA

Run the root gate from the extension bundle:

```bash
cd /Users/alex/workspace/aidev/pi-extensions
npm run check
npm test
npm run test:fixtures
```
