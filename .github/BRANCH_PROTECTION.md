# Recommended branch protection for `main`

Branch protection is a GitHub setting and cannot be applied from code. Configure it at
Settings -> Branches -> Add rule (or Rulesets) for `main`:

- Require a pull request before merging, with 1 approving review
  - Dismiss stale approvals on new commits
  - Require review from Code Owners (see `.github/CODEOWNERS`)
- Require status checks to pass, branch up to date before merging:
  - `test`, `gitleaks`, `sbom` (CI) and `analyze` (CodeQL)
- Require signed commits
- Require conversation resolution before merging
- Require linear history (optional, keeps log readable)
- Do not allow force pushes
- Do not allow deletions
- Include administrators (so the rules apply to the owner too)

Also enable under Settings -> Code security: Dependabot alerts and security updates,
secret scanning with push protection, and private vulnerability reporting.
