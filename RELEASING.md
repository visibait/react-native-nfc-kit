# Releasing

There are no npm tokens in this repository, and there should never be. Publishing
goes through npm's trusted publishing: GitHub Actions mints a short-lived OIDC
token, npm accepts it because the package names the release workflow as a trusted
publisher, and provenance attestations are generated without asking.

Classic npm tokens were deprecated on 2025-12-09 and automation tokens lose direct
publish in January 2027, so a token-based pipeline would be one with a known expiry
date.

## One-time setup on npmjs.com

Before the first publish, on the package's settings page under **Trusted
publishers**, add a GitHub Actions publisher with:

| Field                | Value                  |
| -------------------- | ---------------------- |
| Organization or user | `visibait`             |
| Repository           | `react-native-nfc-kit` |
| Workflow filename    | `release.yml`          |

Leave **Environment** empty: this workflow does not use a GitHub environment, and a
value there would never match.

**The workflow filename is part of the trust configuration.** Renaming
`.github/workflows/release.yml` breaks publishing until this is updated, and the
failure looks like an authentication error rather than a configuration one.

**npm does not validate any of this when you save it.** Its own documentation says
so: a wrong repository or filename surfaces only on the first publish attempt. So
check the three values against this table rather than trusting the form.

The package must exist on npm first. For the very first publish, either create it
with a manual `npm publish` from a machine that is logged in, or reserve the name
and then let the workflow take over. `0.9.0` was published that way, which is why it
carries no provenance attestations — those begin with the first release the workflow
makes.

Once trusted publishing has published successfully at least once, tighten the
package's **Settings → Publishing access** to _"Require two-factor authentication and
disallow tokens"_. That is npm's own recommendation, and it is what makes the absence
of a token here a guarantee rather than a preference: with it set, nothing can publish
this package except this workflow.

## The everyday flow

1. **Write a changeset with the change**, not afterwards:

   ```bash
   npx changeset
   ```

   Two questions: how big the change is, and what to say about it. `.changeset/README.md`
   explains which bump to pick — the one to get right is that anything bumping
   `CONTRACT_VERSION` is a **minor** and the note must say that consumers need to
   rebuild their development build, because that is the support question that
   otherwise arrives instead.

2. **Merge to `main`.** The release workflow opens or updates a pull request titled
   `chore: release` that applies every pending changeset: versions bumped,
   `CHANGELOG.md` written, changesets consumed.

3. **Merge that pull request.** The workflow runs again, finds no pending changesets
   and a version not yet on npm, and publishes.

Every gate runs again inside the release job rather than being trusted from the push
that triggered it. A release is the one place where "it passed earlier" is not good
enough: the tree being published is this one.

## Before a 1.0.0

The version is `0.9.0`, and that is deliberate. What is missing is not code:

- **[The device matrix](docs/device-matrix.md) has not been run.** Not one row. A
  `1.0.0` that has not been through it would be a claim this project has not earned,
  and the matrix says as much on its own first line.
- **Row 21 is an unverified inference.** The Android 17 `DISPATCH_NFC_MESSAGE`
  behaviour follows from Google's documentation and has not been checked on an API 37
  device. The default is the conservative one and the docs call it provisional, but
  it should be settled before a stable release.
- **Weeks of real use.** A 1.0.0 that has not survived somebody else's tags is a
  version number, not a promise. The plan for this library said so from the start,
  and it is worth repeating here where the release happens.

Publishing `0.x` releases in the meantime is the point of the version scheme: each
one is usable, and none of them claims more than has been checked.

## Semantic versioning, as applied here

- Adding an `NfcErrorCode` is a **minor**. Nothing that existed changed meaning.
- Changing the `code` an existing failure produces is a **major**, because callers
  branch on codes and a changed code silently takes a branch away.
- Bumping `CONTRACT_VERSION` is a **minor** that requires a rebuild. The runtime says
  so itself — a bundle newer than the installed binary fails with `contractMismatch`
  and a message naming the remedy — but the changelog should not make anyone
  discover it that way.
- Renaming a technology is a **major**. `tag.is('...')` and the config plugin's tech
  lists both take those names.
