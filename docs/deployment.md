# Azure Cloud Shell Deployment Guide

This guide describes how to deploy the Playwright PDF Processor to **Azure Container Apps** using **Azure Cloud Shell**. Because Azure builds the container in the cloud via Azure Container Registry (ACR), you do not need Docker or the .NET SDK installed locally.

---

## Part 1: One-Time Infrastructure Setup

These steps only need to be run once to set up your resource group, registry, and Container App environment in Azure.

### 1. Define Variables
Run these in your Cloud Shell session (choose custom names):
```bash
RESOURCE_GROUP="pdf-processor-rg"
LOCATION="eastus"
ACR_NAME="sat0049pdfregistry" # Must be globally unique
ACA_ENV="pdf-env"
APP_NAME="cloudpdf-service"
```

### 2. Create the Resource Group
```bash
az group create --name $RESOURCE_GROUP --location $LOCATION
```

### 3. Create the Azure Container Registry
We enable the admin user to easily fetch credentials for deployment:
```bash
az acr create --resource-group $RESOURCE_GROUP --name $ACR_NAME --sku Basic --admin-enabled true
```

### 4. Create the Container App Environment
```bash
az containerapp env create --name $ACA_ENV --resource-group $RESOURCE_GROUP --location $LOCATION
```

---

## Part 2: Build & Deploy (Run on Each Code Change)

Whenever you modify your HTML/CSS frontend or C# backend code, run these steps to push the updates.

### 1. Package and Upload the Source Code
On your local machine, run the packaging script:
```powershell
.\package-src.bat
```
This creates a clean zip file containing only source code at `artifacts\cloudpdf-src.zip`.

1. Open **Azure Cloud Shell**.
2. Click the **Upload/Download files** icon in the toolbar.
3. Select and upload `artifacts\cloudpdf-src.zip`.

### 2. Clean and Unzip the Code (in Cloud Shell)
```bash
# Remove previous directory if it exists
cd ..
rm -rf cloudpdf-src

# Unzip the uploaded package
unzip /home/tejasvi/cloudpdf-src.zip -d cloudpdf-src
cd cloudpdf-src
```

### 3. Build the Image in the Cloud (via ACR Tasks)
This command triggers ACR to compile the code and build the Docker image in Azure:
```bash
# Define variables if starting a new Cloud Shell session
RESOURCE_GROUP="pdf-processor-rg"
ACR_NAME="sat0049pdfregistry"
APP_NAME="cloudpdf-service"

# Build the container image in the cloud
az acr build --registry $ACR_NAME --image cloudpdf-processor:v1 .
```

### 4. Update/Deploy the Container App
First, fetch the registry credentials and update the Container App to run the new image:

```bash
# Retrieve registry passwords
ACR_USERNAME=$(az acr credential show --name $ACR_NAME --query username --output tsv)
ACR_PASSWORD=$(az acr credential show --name $ACR_NAME --query passwords[0].value --output tsv)

# Create or Update the Container App
az containerapp create \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment pdf-env \
  --image ${ACR_NAME}.azurecr.io/cloudpdf-processor:v1 \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 3 \
  --registry-server ${ACR_NAME}.azurecr.io \
  --registry-username $ACR_USERNAME \
  --registry-password $ACR_PASSWORD
```

Once the command finishes, it will output the public URL (FQDN) of your application. You can load this URL, upload HTML files, and see the PDF downloads start in real-time.

---

## Part 3: CI/CD Deployment via GitHub Actions

Instead of manually zipping and uploading code, we can automate the build and deployment process using **GitHub Actions** triggered by merging pull requests into the `dev` branch.

### 1. Create an Azure Service Principal
To authorize GitHub to interact with your Azure resources, you need to create a Service Principal. Run this in Azure Cloud Shell:

```bash
# Retrieve your Subscription ID
SUBSCRIPTION_ID=$(az account show --query id --output tsv)

# Create the Service Principal scoped to your Resource Group.
# This grants the 'Contributor' role, allowing the runner to create new resources and update/delete existing ones, restricted exclusively to the 'pdf-processor-rg' resource group.
az ad sp create-for-rbac \
  --name "cloudpdf-github-actions" \
  --role contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID/resourceGroups/pdf-processor-rg \
  --sdk-auth
```
Copy the entire **JSON output block** returned by this command.

### 2. Configure GitHub Secrets
1. Go to your repository on GitHub.
2. Navigate to **Settings** -> **Secrets and variables** -> **Actions**.
3. Click **New repository secret**.
4. Set the name to: `AZURE_CREDENTIALS`
5. Paste the copied JSON block into the secret value field.
6. Click **Add secret**.

### 3. Pipeline Trigger and Versioning
The workflow is defined at `.github/workflows/deploy-dev.yml`.
* **Trigger**: Automatically runs when a Pull Request targeting the `dev` branch is **closed and merged**.
* **Versioning**: The build version uses the **Short Git Commit SHA** (e.g. `sha-9dfb4da`) as the image tag. This ensures that every deployment is uniquely identifiable and rollback is simple.

---

## Part 4: Managing and Rolling Back Revisions

Every time a deployment occurs (whether via Cloud Shell or GitHub Actions), Azure Container Apps creates a **Revision** (an immutable version snapshot). We can list these historical revisions and switch network traffic between them instantly.

### 1. List All Active and Inactive Revisions
Run this in Cloud Shell to see the names of all historical configurations:
```bash
az containerapp revision list \
  --name cloudpdf-service \
  --resource-group pdf-processor-rg \
  --output table
```
This will print a table showing revision names like `cloudpdf-service--t0528050455` and `cloudpdf-service--0000001`, their status, and current traffic allocation.

### 2. Switch Traffic Between Revisions (Instant Rollback)

How you rollback depends on your Container App's **Revision Mode** (Single vs. Multiple).

#### **Option A: If in Single Revision Mode (Default)**
In Single Revision Mode, only one container configuration can be active at a time. You can roll back using either the Azure Portal or the Azure CLI:

* **Method 1: Using the Azure Portal (easiest)**:
  1. Navigate to **Revision management** inside your Container App.
  2. In the revisions table, locate the previous working revision (e.g. `cloudpdf-service--0000001`) which is currently marked as **Inactive** (`Active = False`).
  3. Click on the checkbox or row for that revision.
  4. Click **Activate** in the top toolbar. 
  5. Azure will automatically set this older revision to Active, route 100% of traffic to it, and deactivate your buggy one.

* **Method 2: Using the Azure CLI**:
  If you don't have the Portal open, update the Container App to run the previous image tag or digest. This automatically deactivates the buggy revision and provisions a new revision running the old image:
  ```bash
  az containerapp update \
    --name cloudpdf-service \
    --resource-group pdf-processor-rg \
    --image sat0049pdfregistry.azurecr.io/cloudpdf-processor:v1
  ```

#### **Option B: If in Multiple Revision Mode**
If you want to keep multiple historical container revisions alive and route traffic between them instantly without creating new deployments:

You can switch traffic between revisions using either the Azure Portal or the Azure CLI:

* **Method 1: Using the Azure Portal**:
  1. Navigate to **Revision management** inside your Container App.
  2. If the older revision is currently marked as **Inactive**, select it and click **Activate** in the toolbar.
  3. Under the **Traffic allocation** or **Traffic weight** column/section (or by clicking **Edit and deploy** / **Manage traffic** depending on your UI version), adjust the percentage values (e.g., set your target revision to `100` and the buggy revision to `0`).
  4. Click **Save** (or **Apply**) to route the traffic instantly.

* **Method 2: Using the Azure CLI**:
  1. **Set the App Revision Mode to Multiple**:
     ```bash
     az containerapp revision set-mode \
       --name cloudpdf-service \
       --resource-group pdf-processor-rg \
       --mode multiple
     ```

  2. **Direct 100% of network traffic back to your older revision name**:
     ```bash
     az containerapp ingress traffic set \
       --name cloudpdf-service \
       --resource-group pdf-processor-rg \
       --revision-weight "cloudpdf-service--0000001=100"
     ```



