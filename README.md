# ☁️ CloudPDF Processor

An educational playground demonstrating how to host **headless browser workloads (`Microsoft.Playwright`)** inside C# .NET containers, while exploring multiple deployment pipelines, registry configurations, and rollback models in **Azure Container Apps**.

---

## 🚀 Application Overview

The project provides a single-container ASP.NET Core web application that compiles HTML files into PDF documents.

* **Backend**: An ASP.NET Core Minimal API that reads uploaded HTML files from the request stream, passes them to a thread-safe, lazily initialized singleton Chromium browser context managed by **Playwright**, prints the layout to PDF bytes in memory, and streams the finished file back using **Server-Sent Events (SSE)** as Base64 strings.
* **Frontend**: A modern, dark-themed user interface featuring glassmorphic cards, a drag-and-drop HTML upload target, a real-time progress dashboard, and automated file downloads.


## 🧪 Azure Deployment Pathways Explored

This repository is designed to explore the different ways a containerized application can be deployed, versioned, and managed in Azure:

### 1. Manual Cloud Build (ACR Tasks + Zip Uploads)
* **Goal**: Build and run containers without installing Docker or the .NET SDK locally.
* **Mechanism**: Use the local [package-src.bat](package-src.bat) script to bundle C# files into a clean zip, upload it to Azure Cloud Shell, and run `az acr build`. Azure compiles the container in the cloud and registers it inside Azure Container Registry (ACR).

### 2. Automated Git-Ops (GitHub Actions CI/CD)
We support two deployment environments using different Git-Ops branches and authentication models:

* **Dev Environment**: Merging a Pull Request into the `dev` branch triggers [.github/workflows/deploy-dev.yml](.github/workflows/deploy-dev.yml). It connects to Azure using a traditional **Service Principal Secret** stored in GitHub Secrets.
* **QA Environment**: Merging a Pull Request into the `qa` branch triggers [.github/workflows/deploy-qa.yml](.github/workflows/deploy-qa.yml). It connects using **OIDC Federated Credentials** (zero long-lived credentials stored in GitHub).

Both environments compile code in the cloud via ACR Tasks, tag images using the **Short Git Commit SHA**, and deploy revisions using a custom timestamp suffix in the US Eastern Time Zone (EST/EDT) in the format `MMDDHHMMSS` (using `TZ=America/New_York date +'%m%d%H%M%S'`).

#### OIDC vs. Traditional Service Principal Login

| Feature | Dev Pipeline (Service Principal Password) | QA Pipeline (OIDC Federated Trust) |
| :--- | :--- | :--- |
| **Authentication** | GitHub uses a long-lived **Client Secret / Password** (stored in `AZURE_CREDENTIALS`). | GitHub performs a live cryptographic handshake with Azure using a **Federated Trust**. |
| **Secret Expiry** | Secrets typically expire in 1–2 years, requiring manual rotation. | **Zero secrets**. Token is temporary and expires immediately after the job finishes. |
| **Security Risk** | If your GitHub repo secrets are compromised, attackers obtain full access to deploy to your Azure resource group. | No secret exists to be stolen. Azure only trusts tokens requested by your specific GitHub repository and branch. |

Refer to [docs/deployment-oidc.md](docs/deployment-oidc.md) for full configuration steps.

### 3. Traffic Splitting & Blue-Green Rollouts (Revisions)
* **Goal**: Achieve zero-downtime updates and safe releases.
* **Mechanism**: Exploring Azure Container App **Revisions** (immutable snapshots of our app configuration). We examine how to:
  * Shift 100% of network traffic instantly back to a previous safe revision in the event of a bug.
  * Split traffic manually (e.g. 95% to the stable version, 5% to the new release/canary) to run live testing before full rollout.
  * Use immutable cryptographic **Digests** (`@sha256:...`) to target and pull specific overwritten or untagged container builds.

---

## 📚 Additional Resources

For deep-dives into specific Azure infrastructure and operations, refer to our compiled Q&A resources:
* [Azure Container Registry & Packaging Q&A](docs/qa-acr.md): Details on file inclusion/exclusion for container builds, ACR costs, image tags vs. digests, retrieving overwritten manifests, registry security, and multiple subscriptions.
* [Azure Container Apps, Environments & Revisions Q&A](docs/qa-container-apps.md): Architectural guide covering Container App Environments, service discovery, port mappings, rolling updates (Blue-Green), revision suffixes, and rollback operations.
* [GitHub Actions Workflow Triggers: Push vs. Pull Request](docs/workflow-triggers.md): Structural and security breakdown explaining why OIDC requires `on: push` scoping, how it compares to standard PR triggers, and how to restrict deployments using GitHub Branch Protection.
