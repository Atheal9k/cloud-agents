---
name: do-ticket
description: Complete one implementation ticket from the cloud-agents plan, from a fresh branch through direct verification and an opened pull request. Use when the user invokes do-ticket with a CA ticket ID or asks for the next unfinished ticket.
---

# Do ticket

Work from the repository root and use `docs/plans/cloud-agents-tickets.md` as the
ticket source.

Accept an optional ticket name or ID. Match it against a `### CA-...` heading in the
plan. When no ticket is supplied, scan the ticket headings in document order and choose
the first ticket without a `Status: Done` line after the completed run at the start of
the plan. State which ticket was selected.

Do not use Linear or the pstack tickets workflow.

## Workflow

1. Read the repository instructions and the full selected ticket, including its
   dependencies and acceptance criteria. Confirm the dependencies are marked done.
2. Inspect the worktree before changing branches. Preserve unrelated user changes. If
   the worktree is clean, switch to `main`, pull it fast-forward-only from `origin`, and
   create a new branch named for the ticket and its subject. Do not implement on `main`.
3. Inspect the existing implementation and make the smallest complete change that meets
   the ticket. Follow every repository skill or verification rule that applies to the
   files touched.
4. Prove it works before declaring the work complete. Build as needed, then exercise the
   real feature path and inspect its actual outputs; a passing test alone is not proof.
   Run only focused tests, lint, and type checks. Do not use repo-wide checks unless
   requested.
5. Review the diff and confirm that no secrets, generated state, planning scratch files,
   or unrelated edits are included.
6. Commit with a conventional commit title, push the branch, and open a pull request.
   The PR body must state the problem, the fix, the direct verification performed, and
   the model and harness used. Add required UI evidence when the change affects UI.
7. After the pull request exists, add this line to the selected ticket in the plan:
   `Status: Done on <date> in [PR #<number>](<url>).` Commit and push that plan change
   on the same branch so the pull request itself contains the link. Do not mark the
   ticket done before its pull request URL is known.
8. Register the pull request with the active T3 thread when that capability is available.
   Confirm the linked status commit appears in the pull request, then report the branch,
   commits, PR URL, and verification results.

Opening and linking the pull request are authorized by an explicit invocation of this
skill. Never merge it unless the user separately asks.
