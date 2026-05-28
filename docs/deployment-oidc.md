# Azure OIDC Federated Authentication Setup Guide

This guide details how to configure **OpenID Connect (OIDC) Federated Trust** between GitHub Actions and Microsoft Entra ID (Azure Active Directory). This allows the QA deployment pipeline to deploy to Azure Container Apps **without storing any long-lived secrets or passwords** in GitHub.

---

## Architecture Overview

With OIDC, the workflow doesn't use a password. Instead:
1. When the QA workflow runs, GitHub's OIDC provider issues a temporary, cryptographically signed JSON Web Token (JWT).
2. GitHub Actions passes this token to Azure via the `azure/login@v2` action.
3. Microsoft Entra ID verifies the token signature and checks if the token attributes (repository name, branch, etc.) match a pre-configured **Federated Credential** on the App Registration.
4. If they match, Azure issues a short-lived access token to the runner, which expires automatically after the deployment steps finish.

---

## Setup Option 1: Using the Azure CLI (Recommended)

Run these commands in Azure Cloud Shell to register the federated credential on your existing Service Principal:

### 1. Retrieve the App Registration Object ID and Subscription ID
```bash
# Define variables
RESOURCE_GROUP="pdf-processor-rg"
APP_NAME="cloudpdf-github-actions" # The name of your existing Service Principal

# Get your Subscription ID and Tenant ID
SUBSCRIPTION_ID=$(az account show --query id --output tsv)
TENANT_ID=$(az account show --query tenantId --output tsv)

# Get the Application (Client) ID of your Service Principal
CLIENT_ID=$(az ad sp list --display-name "$APP_NAME" --query "[0].appId" --output tsv)

# Get the Object ID of the App Registration (needed to add federated credentials)
APPLICATION_OBJECT_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].id" --output tsv)
```

### 2. Create the Federated Credential Definition JSON
Save this JSON configuration as `credential-qa-branch.json` inside your Cloud Shell:
```json
{
  "name": "github-actions-qa-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:tkondamuru/cloudpdf:ref:refs/heads/qa",
  "description": "Federated trust for GitHub Actions on the qa branch",
  "audiences": [
    "api://AzureADTokenExchange"
  ]
}
```
> [!IMPORTANT]
> Change `tkondamuru/cloudpdf` in the `subject` field if you are deploying from a different GitHub repository fork.

### 3. Apply the Federated Credential to the App Registration
```bash
az ad app federated-credential create \
  --id $APPLICATION_OBJECT_ID \
  --parameters @credential-qa-branch.json
```

---

## Setup Option 2: Using the Azure Portal

If you prefer to configure the trust relationship visually:

1. Open the **Azure Portal** and navigate to **Microsoft Entra ID**.
2. Click on **App registrations** in the left sidebar, and select the **All applications** tab.
3. Search for and click on your Service Principal (e.g., `cloudpdf-github-actions`).
4. Click on **Certificates & secrets** in the left sidebar.
5. Select the **Federated credentials** tab, then click **Add credential**.
6. In the **Federated credential scenario** dropdown, select **GitHub Actions**.
7. Fill in the following details:
   - **Organization**: `tkondamuru` (your GitHub username)
   - **Repository**: `cloudpdf` (your repository name)
   - **Entity type**: `Branch`
   - **Branch name**: `qa`
   - **Credential details Name**: `github-actions-qa-branch`
   - **Description**: `Federated trust for GitHub Actions on the qa branch`
8. Click **Add**.

---

## Configuring GitHub Environment Variables

Since we are not storing secrets, we store the public IDs as plain-text **Variables** in your GitHub repository:

1. Go to your GitHub repository and navigate to **Settings** -> **Secrets and variables** -> **Actions**.
2. Click the **Variables** tab (next to the *Secrets* tab).
3. Click **New repository variable** for each of the following:

| Variable Name | Value |
| :--- | :--- |
| `AZURE_CLIENT_ID` | The Application (Client) ID of your Service Principal |
| `AZURE_TENANT_ID` | Your Microsoft Entra ID Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Your Azure Subscription ID |

---

## Verifying the Workflow

Once the variables are configured and the federated credential is added, any Pull Request merged into the `qa` branch will trigger [.github/workflows/deploy-qa.yml](../.github/workflows/deploy-qa.yml). 

The login step will execute using the OIDC handshake, showing in the runner logs:
```
Federated token received successfully.
Logged in to Azure environment: AzureCloud
```
