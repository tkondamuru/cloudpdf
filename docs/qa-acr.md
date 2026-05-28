# Q&A: Azure Container Registry & Packaging

This document contains a curated list of questions and answers regarding building, packaging, and managing container images inside **Azure Container Registry (ACR)**.

---

### **Q1: What specific files and folders in a .NET project should be included when zipping the source code for a remote Docker container build in Azure?**

**Answer:**
Because our deployment uses a **multi-stage Dockerfile**, the compilation happens entirely inside Azure's cloud infrastructure (via the `mcr.microsoft.com/dotnet/sdk` container). 

Therefore, we only package the **source code** and **configuration files**, and we must avoid packaging any locally compiled binaries or temporary intermediate folders.

#### **1. Files and Folders to INCLUDE:**
* **Project definition**: `CloudPdf.Processor.csproj` (defines dependencies, SDK targets, and NuGet packages).
* **Source code**: `Program.cs` and the `Services/` folder (contains all C# logic).
* **Web frontend assets**: `wwwroot/` folder (contains HTML, CSS, and JS).
* **Docker configuration**: `Dockerfile` (the build recipe for ACR).
* **Configuration files**: `appsettings.json` and `appsettings.Development.json` (defines port bindings and logging levels).
* **Documentation**: `docs/` folder (contains deployment guides).

#### **2. Files and Folders to EXCLUDE (Crucial to omit):**
* `bin/` (contains local Windows binaries. These are useless to the target Linux container and bloat the upload size).
* `obj/` (contains intermediate local compile state and NuGet restore paths, which will conflict with the restore process inside the Linux Docker engine).
* `.git/` (your local git database and logs).
* `.vs/` and `.vscode/` (local editor configurations).
* `artifacts/` (the folder where the zip itself is stored, to prevent recursive zipping).

---

### **Q2: What is Azure Container Registry (ACR), is it free, and what is the purpose of the `--admin-enabled true` flag during its creation?**

**Answer:**

#### **1. What does Azure Container Registry (ACR) contain?**
ACR is a secure, private hosting service (a registry) for Docker container images in Azure. It contains the compiled, layered images of our application (built via `az acr build`). When a deployment occurs, Azure Container Apps pulls the docker image from ACR to run it.

#### **2. Is ACR free?**
No, ACR does **not have a free tier**. However, it is very inexpensive for development:
* The **Basic SKU** we use costs roughly **$0.16/day** (about **$5.00/month**).
* This tier includes 10 GB of container storage, which is more than enough to store many versions of our application.

#### **3. What does `--admin-enabled true` do, and why do we need it?**
By default, ACR is locked down. Only users/services authenticated via complex Azure Active Directory (Entra ID) or Managed Identities can pull images from it. 

Enabling the **Admin Account** (`--admin-enabled true`) creates a single username (the registry name) and two auto-generated, rotatable passwords for the registry. 

**Why we need it:**
Azure Container Apps needs credentials to pull our private container image. While using Managed Identities is recommended for production environments, utilizing the **Admin Credentials** is the easiest and fastest way to authorize the Container App to pull from the registry in dev/test setups. We fetch these passwords in Cloud Shell and feed them directly into the Container App deployment command.

---

### **Q3: Is it necessary to provision a separate Azure Container Registry (ACR) for every individual container/microservice, and how should we manage the 10 GB storage limit across multiple images?**

**Answer:**

#### **1. Do we need a separate ACR for each container?**
No, **absolutely not**. A single Azure Container Registry can host **thousands of different container images** (known as **Repositories**) and multiple versions (known as **Tags**) for each image. 

For example, you can host your entire company's microservices in a single registry:
* `${ACR_NAME}.azurecr.io/cloudpdf-processor:v1`
* `${ACR_NAME}.azurecr.io/ecombot-api:v2`
* `${ACR_NAME}.azurecr.io/identity-service:latest`

This means you only pay the **$5.00/month basic fee once** for your entire project suite or organization, rather than paying per container.

#### **2. Managing the 10 GB Storage across images**
While a single container image is usually between 200MB to 800MB, the 10 GB limit can eventually be reached because of **image tag history**:
* Every time you rebuild your container (e.g., updating a bug and pushing a new image), ACR keeps the old version of the image layers in storage.
* If you rebuild the app 20 times, you will have 20 different versions of the image layers occupying space, even if you are only running the latest one.

**Best Practices for Storage:**
1. **Share the Registry**: Use one registry for all apps to maximize the value of the 10 GB storage.
2. **Clean up untagged images**: When you overwrite an image tag (like pushing `v1` repeatedly), the old image layers become "untagged" or "orphaned". You can clear them manually using the portal or automate it via Azure CLI:
   ```bash
   # Delete images older than 7 days that are not currently tagged
   az acr run --registry $ACR_NAME --cmd "acr purge --filter '.*:.*' --untagged --ago 7d" /dev/null
   ```

---

### **Q4: When building container images repeatedly, is each build stored as a separate copy, and how are these copies identified and differentiated from one another in the registry?**

**Answer:**

**Yes, they are stored as separate copies** (or revisions). However, to save storage space, Docker registries reuse identical layers (e.g. if the base OS and .NET SDK layers haven't changed, they are not duplicated). Only the modified application layers are stored.

We differentiate between these image copies in two ways:

#### **1. Tags (Mutable Labels)**
Tags are human-readable text labels you attach to a build (e.g., `v1`, `v2`, `latest`, `build-45`).
* **If you change the tag for each build** (e.g., `v1`, then `v2`): Both copies remain in the registry under their respective tags.
* **If you reuse the same tag** (e.g., pushing `v1` on Monday and rebuilding and pushing `v1` on Tuesday): The `v1` label moves to point to Tuesday's build. Monday's build is **still preserved** in the registry, but it now has **no tag** (often referred to as an "untagged", "orphaned", or "dangling" image).

#### **2. Digests (Immutable Hashes)**
Every time an image is built, the registry generates a **Digest**, which is a unique cryptographic SHA-256 hash representing the exact binary content of that image (e.g., `sha256:7bf58cd791...`).
* The Digest is **permanent and cannot be changed or moved**. 
* Even if an image becomes **untagged** (because you reused its tag), it still keeps its unique Digest.
* You can reference or pull an image explicitly by its Digest instead of its tag:
  `mypdfregistry.azurecr.io/cloudpdf-processor@sha256:7bf58cd791...`
* When running registry cleanup scripts (like `acr purge`), Azure uses these Digests to identify and delete the untagged images that are no longer needed.

---

### **Q5: If a new container build accidentally overwrites an existing tag, causing a buggy release, how can we retrieve the SHA-256 Digest of the previous untagged version in Azure Container Registry to perform a quick rollback?**

**Answer:**

To roll back to a version that has lost its tag, you must reference it using its **Digest** (`@sha256:hash`). You can retrieve the correct Digest using either the Azure CLI (best for Cloud Shell) or the Azure Portal.

#### **Method 1: Find the Digest using Azure CLI (Cloud Shell)**
You can query your registry's manifests, filter for untagged images, sort them chronologically by timestamp, and extract the most recent one (which is the one you just accidentally overwrote):

```bash
# Query the registry to find the last modified untagged image
PREVIOUS_DIGEST=$(az acr repository show-manifests \
  --name $ACR_NAME \
  --repository cloudpdf-processor \
  --query "[?tags==null] | sort_by(@, &timestamp)[-1].digest" \
  --output tsv)

echo "Previous Image Digest: $PREVIOUS_DIGEST"
```

#### **Method 2: Find the Digest using the Azure Portal**
1. Navigate to your **Azure Container Registry** resource.
2. In the left menu, select **Repositories** (under *Services*).
3. Click on the repository name (e.g. `cloudpdf-processor`).
4. Look down the list of images. The image that was just overwritten will have an **empty (blank) tag** column.
5. Click on the Digest hash link for that row, and copy the **Manifest Digest** string (e.g. `sha256:7bf58cd791...`).

---

### **Q6: Does enabling the `--admin-enabled true` flag on Azure Container Registry automatically generate a username and password, and what alternative secure authentication methods are available to connect other services to ACR?**

**Answer:**

#### **1. Does `--admin-enabled true` auto-generate credentials?**
**Yes.** 
* **Username**: The username is static and is always the exact name of your registry (e.g. `pdfregistry`).
* **Passwords**: Azure automatically generates **two passwords** (primary and secondary). You can view, rotate, or disable them at any time in the portal or via CLI:
  `az acr credential show --name $ACR_NAME`

#### **2. What are the alternative, more secure authentication methods?**
For production environments, security best practices dictate that you **disable the admin account** (`--admin-enabled false`) to prevent static credential leakage. Instead, you can use these alternatives:

##### **A. Managed Identities (Highly Recommended)**
This is the most secure method for Azure-to-Azure communication (e.g. Azure Container App pulling from Azure Container Registry).
* You assign a **Managed Identity** (System or User assigned) to the Container App.
* You grant that identity the **AcrPull** role on the Container Registry.
* The Container App uses a secure Azure AD token to authenticate behind the scenes. No passwords, client ids, or secrets are written in code or configs.

##### **B. Service Principals**
Used when external build servers or third-party platforms (like GitLab CI, GitHub Actions, or local Jenkins servers) need to push or pull images.
* You register an App in Azure AD (Service Principal).
* Assign it the **AcrPush** (for building/uploading) or **AcrPull** (for pulling) role on your registry.
* You use the Service Principal's `Application ID` (as username) and `Client Secret` (as password) to authenticate.

##### **C. ACR Registry Tokens (Repository Scopes)**
Used to grant granular access to specific images inside the registry.
* Instead of full access, you create a scoped token linked to a "Scope Map".
* For example, you can create a token that only has read permissions to the `cloudpdf-processor` repository, preventing the holder from pulling or pushing to other repositories in the same registry.

---

### **Q7: If an Azure account has access to multiple subscriptions, how do we determine which Subscription ID to target when configuring the Service Principal, and how do we ensure the Azure CLI is set to the correct active subscription?**

**Answer:**

You must select and target the specific Azure subscription **that hosts the Resource Group (`pdf-processor-rg`)** containing your project infrastructure (Container Registry, Environment, and Container App). 

If you create the Service Principal under the wrong subscription, the GitHub Actions deployment will fail with a "Resource Group Not Found" or "Authorization Failed" error.

#### **How to find and switch to the correct subscription in Azure Cloud Shell:**

1. **List all subscriptions you have access to**:
   ```bash
   az account list --output table
   ```
   This will display a table containing the `Name`, `SubscriptionId`, and whether it is currently active (`IsDefault`).

2. **Select and switch the active subscription**:
   Identify the subscription name or ID where your resources are located, and set it as the default:
   ```bash
   # Switch using the subscription name
   az account set --subscription "My-Project-Subscription"

   # OR switch using the Subscription ID directly
   az account set --subscription "12345678-abcd-1234-abcd-1234567890ab"
   ```

3. **Verify the change**:
   Run the show command to confirm that the active subscription has updated:
   ```bash
   az account show --query "{Name:name, ID:id}"
   ```

Once you have verified that the active subscription context is correct, you can run the Service Principal creation command. The `az account show --query id` variable will automatically capture the correct ID, and the Service Principal will be granted permissions on the correct subscription.
