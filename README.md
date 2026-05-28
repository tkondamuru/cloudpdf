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
* **Goal**: Shift from manual uploads to standard DevOps automation.
* **Mechanism**: Merging a Pull Request into the `dev` branch triggers the GitHub workflow in [.github/workflows/deploy-dev.yml](.github/workflows/deploy-dev.yml). It logs in to Azure using a Service Principal, builds the container using ACR, tags it with the **Short Git Commit SHA**, and pushes the update to the Container App automatically.

### 3. Traffic Splitting & Blue-Green Rollouts (Revisions)
* **Goal**: Achieve zero-downtime updates and safe releases.
* **Mechanism**: Exploring Azure Container App **Revisions** (immutable snapshots of our app configuration). We examine how to:
  * Shift 100% of network traffic instantly back to a previous safe revision in the event of a bug.
  * Split traffic manually (e.g. 95% to the stable version, 5% to the new release/canary) to run live testing before full rollout.
  * Use immutable cryptographic **Digests** (`@sha256:...`) to target and pull specific overwritten or untagged container builds.
