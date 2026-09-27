---
name: operators
description: Add, create, list, disable, enable, remove, delete or reset a platform operator (a user in the Supply Checkout operator pool, ADR 0015), including a stolen operator password or token. Use when the owner asks to add or remove an operator, give someone ops access, see who the operators are, or lock out or reset an operator. Hands the owner the exact `npm run operators` command to run; never runs prod changes itself.
---

# Operators

`npm run operators` (`scripts/operators.mjs`) manages the people in the operator pool with the AWS CLI. Details: "Operators" in `docs/infrastructure.md`.

```bash
npm run operators -- add <username> [--email <addr>] [--send-email]
npm run operators -- list [--emails]
npm run operators -- disable <username>
npm run operators -- enable <username>
npm run operators -- remove <username> [--yes]      # delete only with --yes
npm run operators -- reset <username> [--send-email] [--keep-disabled]
```

Options on every command: `--env <env>` (default `prod`), `--profile <aws profile>` (default `$AWS_PROFILE`, else `supply-prod`), `--region`, `--pool-id`, `--dry-run`.

Usernames: 1 to 64 lowercase letters, digits, `.`, `_` or `-`, for example `alex`. Use example names (alex, alex@example.com) in anything committed: this repo is public.

## These are the owner's prod admin actions

Every command except `--dry-run` changes, or reads, the production operator pool under the owner's SSO administrator role. Claude never runs them. Claude:

1. Works out the exact command from what the owner asked.
2. May run it with `--dry-run` first, to show the AWS CLI calls it will make (passwords are redacted, and a dry run makes no AWS call, not even the SSM read).
3. Hands the owner the line to run:
   - `list`, `disable`, `enable`, `remove`, and `add`/`reset` **with `--send-email`**: as a `!` line the owner can run in this session, e.g. `! npm run operators -- disable alex`.
   - `add` and `reset` **without `--send-email`** print a temporary password. Give these as a command for **a terminal of their own**, not a `!` line: `!` output goes into this session's transcript, which is saved on disk. The script refuses to print a password when stdout isn't a terminal, so under `!` it stops before changing anything. Don't suggest `--print-password` to get around that.
4. If the owner isn't signed in, the command fails with an SSO error: they run `aws sso login --profile supply-prod` (in a terminal of their own) and try again.

Never ask for, repeat, store or write down a temporary password, and never put one in a bead, a commit, a PR or memory. If the owner pastes one, don't echo it back; suggest a `reset` if it may have gone further than intended.

## After each command

- **P1 alerts are expected.** The script says which calls alert (`AdminCreateUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminSetUserPassword`, `AdminSetUserMFAPreference`, `AdminEnableUser`): remind the owner they'll get those P1 messages for this change, and that one they can't match to a change is worth a look.
- **After `add`:** the owner hands the temporary password over in person (not by email or chat) unless they used `--send-email`. It expires in 1 day. At their first sign-in (`npm run ops`, or `ops-auth.supplycheckout.com`) the new operator chooses a new password and sets up TOTP with an authenticator app on their phone, not in the same password manager as the password. Then `list` should show them `CONFIRMED`, `TOTP`, `operators`.
- **After `remove`** without `--yes`: the user is out of the group, signed out and disabled but still in the pool; `remove <username> --yes` deletes them.
- **After `reset`** (a stolen password or token): the script prints the next steps. The operator deletes the old authenticator entry, signs in with the new temporary password and sets up TOTP again. The owner reads what the account did (`npm run ops -- audit`, `--team PLATFORM`, the ops function's logs, CloudTrail) and ends comps it shouldn't have made. With `--keep-disabled`, `enable <username>` once they've a clean device.

## If a command stops part-way

It says what's done, what isn't, and how to finish or undo (for example, a user created but not added to the group). Relay that; the fix is another `npm run operators` command or the one `aws` command it prints, again for the owner to run.
