# Releasing

Packages are versioned with [Changesets](https://github.com/changesets/changesets) and published
from CI. `@tatara/cli` and `create-tatara` always share a version (`fixed` in
`.changeset/config.json`); every other `@tatara/*` package has its own.

## Day to day

1. In the PR that changes a package, run `pnpm changeset`. Pick the packages and the bump
   (patch / minor / major), and write one line for the changelog. Commit the generated
   `.changeset/*.md` file.
2. When that PR merges, the **Release** workflow (`.github/workflows/release.yml`) opens or
   updates a **"chore: version packages"** PR. That PR bumps versions and writes changelogs.
3. Merging the version PR publishes every package whose version changed, with provenance.
   npm's staged-release approval may still apply: approve the release on npmjs.com if asked.

## One-time setup (npm trusted publishing)

The workflow has no `NPM_TOKEN`. npm trusts GitHub's OIDC token instead, so each package must
list this workflow as a trusted publisher:

1. On npmjs.com, open the package → **Settings** → **Trusted publishing** → **GitHub Actions**.
2. Organization or user: `mohammed-bageri`, repository: `tatara`, workflow file: `release.yml`.

   Or from the command line (npm ≥ 11.15, your 2FA; one trusted publisher per package, so revoke an old one first with `npm trust revoke <pkg> --id=<id>`):
   `npm trust github @tatara/<pkg> --file release.yml --repository mohammed-bageri/tatara --allow-publish --yes`
3. Save. Do this for `@tatara/cli`, `create-tatara`, and every new package.

A brand-new package has to be published once by hand (`pnpm publish --otp <code>` in its folder)
before npm lets you add a trusted publisher to it.
