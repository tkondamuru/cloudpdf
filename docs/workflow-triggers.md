# GitHub Actions Workflow Triggers: Push vs. Pull Request

This document explains the structural and security differences between using the `on: push` and `on: pull_request: types: [closed]` triggers in our GitHub Actions pipelines (specifically looking at the **Dev** and **QA** environment deployments).

---

## Comparison Matrix

| Feature | `on: push` (Used in QA) | `on: pull_request` (Used in Dev) |
| :--- | :--- | :--- |
| **Trigger Mechanism** | Fires when a commit is pushed directly **OR** when a Pull Request is successfully merged. | Fires when a Pull Request is closed (either by **merging** it or by **closing/declining** it). |
| **Workflow Code Requirements** | Simple setup. No condition checking needed. Runs automatically on the resulting commit. | Requires an `if` condition check: `if: github.event.pull_request.merged == true` to prevent run on canceled PRs. |
| **Git Ref Context** | Executes in the target branch context (`refs/heads/qa`). | Executes in a temporary GitHub merge preview context (`refs/pull/PR_NUMBER/merge`). |
| **OIDC Subject Claim** | `repo:<org>/<repo>:ref:refs/heads/qa` (Includes target branch name). | `repo:<org>/<repo>:pull_request` (Does **not** include target branch name). |

---

## Detailed Analysis

### 1. Why `on: push` is Required for OIDC (QA Environment)
When using OpenID Connect (OIDC) federated trust to connect to Azure:
1. GitHub requests a JWT token from Azure.
2. Azure verifies the token's **Subject Claim** before authorizing the run.
3. If the workflow uses `on: push`, GitHub issues a token with the subject containing `ref:refs/heads/qa`. Azure can check this branch name and securely authorize the login.
4. If the workflow uses `on: pull_request`, GitHub issues a token with the generic subject `pull_request`. Because this subject is identical regardless of the target branch, you cannot easily configure branch-level security in Azure AD.

Therefore, for OIDC pipelines, **`on: push` is the secure and recommended trigger.**

### 2. Why `on: pull_request` works for Dev (Service Principal)
Since the Dev pipeline uses a traditional, static Azure Service Principal password/secret (`AZURE_CREDENTIALS`), it does not go through the OIDC cryptographic handshake:
* Azure accepts the password secret directly.
* Since Azure is not validating an OIDC token subject, it does not care about the trigger context (`pull_request` vs. `push`).

---

## Restricting Direct Pushes to Protected Branches

If you want to ensure that code is only deployed via merged Pull Requests (and not by developers pushing directly to `qa` or `dev` from their terminals), you should configure **GitHub Branch Protection Rules**:

1. In your GitHub repository, navigate to **Settings** -> **Branches**.
2. Click **Add branch protection rule**.
3. Set the **Branch name pattern** to `qa` (or `dev`).
4. Check **Require a pull request before merging**.
5. Save the rule.

By setting up Branch Protection, a `push` trigger becomes **conceptually identical** to a "merged pull request" trigger since direct pushes are blocked by GitHub's access controls.
