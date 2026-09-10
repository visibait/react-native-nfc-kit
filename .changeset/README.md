# Changesets

A changeset is a note about a change, written when the change is made rather than
reconstructed at release time. Run `npx changeset` and answer two questions: how big
the change is, and what to say about it.

Which bump to pick, for this library specifically:

- **patch** — a fix that changes no API and needs no rebuild.
- **minor** — a new capability, a new `NfcErrorCode`, or anything that bumps
  `CONTRACT_VERSION`. A contract bump means consumers must rebuild their development
  build, so the changeset should say so in as many words.
- **major** — changing the `code` of an existing error, removing an export, or
  changing what an existing call does. Renaming a technology counts.

The changelog is generated from these, which is the point: the library this replaces
has a `CHANGELOG.md` frozen at 3.0.2 from February 2021, with four years of releases
missing from it.
