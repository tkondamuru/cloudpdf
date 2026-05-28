# Q&A: Azure Container Deployment

This document contains a curated list of questions and answers regarding building, packaging, and deploying our .NET Playwright application to Azure.

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

#### **How to Rollback the Container App**
Once you have the Digest hash, deploy/update the Container App by targeting the specific Digest instead of a tag. This forces the container environment to pull that exact byte-for-byte copy:

```bash
# Update the Container App to run the specific digest
az containerapp update \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --image ${ACR_NAME}.azurecr.io/cloudpdf-processor@$PREVIOUS_DIGEST
```
*Note: If you copied the digest from the portal manually, replace `$PREVIOUS_DIGEST` with the string, e.g. `...cloudpdf-processor@sha256:abcdef...`*

---

### **Q6: How fast is the rollback process in Azure Container Apps, and does it natively implement a Blue-Green deployment model during updates and rollbacks?**

**Answer:**

#### **1. How quick is the rollback?**
The rollback is extremely fast—typically taking **under 10 to 30 seconds**. This is because:
* **No Code Compilation**: The container is already built and sitting in ACR.
* **Cached Base Layers**: The Azure servers running your Container App already have the heavy base layers (like the OS and .NET SDK runtime) cached from the previous run. It only has to download the tiny, modified application layer.
* **Immediate Traffic Shifting**: The traffic is routed instantly at the load balancer level as soon as the container is marked active.

#### **2. Is this a Blue-Green deployment?**
**Yes, natively (referred to as a zero-downtime rolling update).** 

Azure Container Apps uses the concept of **Revisions** (immutable snapshots of your container configuration). 

When you trigger a rollback or deploy a new version:
1. **Background Provisioning (Green)**: ACA spins up the new configuration (Revision B) in the background. Meanwhile, your current live container (Revision A / Blue) continues to serve all incoming HTTP traffic.
2. **Health Probes check**: ACA waits for the new container (Green) to start and successfully pass its readiness and liveness checks.
3. **Instant Swap**: Once the new container is healthy, ACA's internal ingress (load balancer) instantly switches 100% of the traffic from Blue to Green.
4. **Teardown**: The old container (Blue) is then cleanly powered down.

#### **Advanced Blue-Green (Traffic Splitting)**
If you change the Container App's configuration to **Multiple Revision Mode**, you can gain full control over this traffic. You can keep both Blue and Green running simultaneously and split traffic manually:
```bash
# Split traffic: 95% to your safe old revision, 5% to your new buggy revision for testing
az containerapp ingress traffic set \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --revision-weight "revision-safe=95" "revision-new=5"
```
Once you verify the new revision is stable, you can adjust the weights to 100% with a single command.

---

### **Q7: Does enabling the `--admin-enabled true` flag on Azure Container Registry automatically generate a username and password, and what alternative secure authentication methods are available to connect other services to ACR?**

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

### **Q8: Why do we need to create an Azure Container App Environment, and what is its underlying architectural purpose in our deployment?**

**Answer:**

The **Container App Environment** acts as a **secure boundary and virtual network wrapper** around a group of Container Apps. In the deployment script, we pass it during creation using the `--environment pdf-env` parameter.

#### **What does the Environment do?**
1. **Shared Network Boundary**: All Container Apps running in the same Environment share the same Virtual Network (VNet) and private IP space.
2. **Secure Service-to-Service Communication**: Apps in the same environment can talk to each other securely using internal DNS names (e.g. `http://billing-service` or `http://pdf-worker`) without exposing their ports to the public internet. Only the "gateway" or "frontend" containers are exposed externally.
3. **Unified Logging**: All containers in the same environment automatically stream their stdout/stderr logs to the same shared Azure Log Analytics Workspace, making debugging simple.
4. **Billing & Resource Grouping**: It serves as a logical grouping for related microservices, simplifying resource allocation.

#### **Analogy:**
Think of the **Container App Environment** as a **gated apartment complex** (VNet/Kubernetes namespace) and the **Container Apps** as the **individual apartments** (containers). 
* The apartments share the same security gate, swimming pool (network/billing), and maintenance staff (logging).
* The apartments can talk to each other internally (knocking on doors), but outsiders can only enter if they go through the main security check-in (public ingress).
* In our simple app, we only have one container, but if we later add an LLM API container or an admin dashboard container, we will deploy them to this same environment.

---

### **Q9: How does service discovery work inside an Azure Container App Environment, and are the internal URLs for container communication automatically created and managed by Azure?**

**Answer:**

**Yes, absolutely.** Azure Container Apps automatically manages a built-in DNS service inside the environment. 

To enable this, you must configure **Ingress** when creating a Container App. Ingress has two visibility settings:
1. `external`: The app gets a public internet HTTPS URL (accessible by anyone).
2. `internal`: The app is hidden from the internet but visible to other apps in the same environment.

#### **How the internal URL is constructed and resolved:**
For any app where Ingress is enabled (whether internal or external), Azure automatically provisions a fully qualified domain name (FQDN) in this format:
`<app-name>.<environment-unique-id>.<region>.azurecontainerapps.io`

However, **you do not need to use this long URL** for communication between containers in the same environment. 

#### **Simple Service Discovery:**
The environment's built-in DNS allows apps to talk to each other using just the **simple app name** as the hostname.

* If you have a frontend app that needs to call a backend PDF compiler app named `cloudpdf-service` on port `8080`, your frontend code can make HTTP requests directly to:
  `http://cloudpdf-service:8080/api/process`
* The DNS automatically maps `cloudpdf-service` to the private IP address of that container.
* If you scale the `cloudpdf-service` to run 5 instances, Azure automatically load-balances the requests across those 5 private instances transparently.

---

### **Q10: How is the "simple app name" identified during deployment, is port 8080 a default port in container communications, and how/where do we specify these configurations?**

**Answer:**

#### **1. What is the "simple app name"?**
The simple app name is the name you assign to the container app when you deploy it using the `--name` parameter in the `az containerapp create` command.
* In our deployment script: `--name $APP_NAME` (where `$APP_NAME="cloudpdf-service"`).
* Therefore, the simple app name is **`cloudpdf-service`**.

#### **2. Is 8080 the default port?**
No, **there is no default port**. Azure Container Apps does not assume a default port for your container. You must specify which port your containerized application listens on.

#### **3. Where do we note/specify the port?**
The port must match in **two places**:

1. **Inside the Container (Dockerfile)**:
   In our `Dockerfile` (lines 22 and 24), we specify the environment variable telling the ASP.NET Core server to listen on port `8080`, and document it:
   ```dockerfile
   ENV ASPNETCORE_URLS=http://+:8080
   EXPOSE 8080
   ```
2. **In the Azure Deployment Command (`az CLI`)**:
   We specify the `--target-port` parameter in the deployment script:
   ```bash
   --target-port 8080
   ```
   This tells the Azure Container Apps load balancer: *"Forward incoming HTTP/HTTPS traffic on the network interface to port 8080 inside the container."*

#### **How to make internal calls (Ingress Magic):**
Even though the container listens on port `8080` internally, Azure Container Apps' built-in Ingress exposes all apps on standard web ports (`80` for HTTP and `443` for HTTPS) inside the private environment network.

This means you do not even need to type `:8080` in your code! Other containers in the same environment can call your service using standard HTTP port 80:
`http://cloudpdf-service/api/process`

Azure will receive it on port 80 and automatically route it to target port 8080 inside the container.

---

### **Q11: How are image tags assigned during the container build process, and are these tags used as deployment versions to identify which image version is currently running in production?**

**Answer:**

#### **1. How do we assign image tags?**
You specify the tag during the build process using the format `repository-name:tag-name` within the `--image` parameter of the `az acr build` command:
```bash
az acr build --registry $ACR_NAME --image cloudpdf-processor:v1 .
```
In this command:
* `cloudpdf-processor` is the **Repository** (the name of the application).
* `v1` is the **Tag** (the version label).
* You can use any string format for tags (e.g. `v1.0.0`, `latest`, `build-45`, or a Git commit hash like `git-7f8a9bc`).

#### **2. Are image tags used as deployment versions?**
**Yes, absolutely.** When you deploy your Container App, you explicitly define which tagged image to pull:
```bash
--image ${ACR_NAME}.azurecr.io/cloudpdf-processor:v1
```
Azure Container Apps registers this specific image URL in the App's **Revision** configuration. If you look at the Azure Portal under *Container App -> Revision Management*, you can see exactly which tag is deployed.

#### **Important Best Practices for Tags & Deployments:**
1. **Avoid reusing tags in production**: If you push a bug fix and tag it `v1` again (overwriting the previous `v1`), Azure Container Apps will not automatically pull the new version because it thinks it already has `v1` cached.
2. **Increment tags or use Unique IDs**: Best practice is to increment tags (e.g., `v1`, `v2`, `v3`) or use automated build numbers (e.g., `build-101`) or Git commits (e.g. `commit-3a4b5c`) for every build. This ensures:
   * Deployments are 100% uniquely identifiable.
   * Rollbacks are clean and easy.
   * Azure Container Apps instantly detects the new version and pulls it without cache issues.

---

### **Q12: If an Azure account has access to multiple subscriptions, how do we determine which Subscription ID to target when configuring the Service Principal, and how do we ensure the Azure CLI is set to the correct active subscription?**

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

---

### **Q13: In the Azure Portal, what is the quickest way to check what image versions/tags a container has run under, and how do we switch (roll back) between different versions using the Portal vs the Azure CLI?**

**Answer:**

In Azure Container Apps, every deployment, image change, or configuration update creates a **Revision** (an immutable historical snapshot). Revisions are how we inspect past versions and switch between them.

#### **1. How to check past versions (Tags/Images)**

* **Using the Azure Portal (Visual UI)**:
  1. Open your **Container App** in the portal.
  2. In the left-hand menu, under the **Application** section, click on **Revision management**.
  3. You will see a list of all historical revisions (e.g., `cloudpdf-service--abc1234`).
  4. Click on any revision in the list to open its details panel. Under the **Container** tab, you will see the exact registry image URL, including the tag or digest it ran under.

* **Using the Azure CLI (Cloud Shell)**:
  Run this command to list all revisions, their creation times, and active statuses:
  ```bash
  az containerapp revision list \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --output table
  ```

---

#### **2. How to switch (roll back) between different versions**

You can switch traffic between existing revisions in two ways, depending on how your Container App is configured.

##### **Method A: Using the Azure Portal**
1. Navigate to **Revision management** inside your Container App.
2. Ensure your **Revision mode** is set to **Multiple** (which allows keeping older container revisions alive).
3. In the revisions table, you will see a **Traffic (%)** column.
4. Modify the traffic weights:
   * Locate the old, working revision and set its traffic weight to **100%**.
   * Locate the buggy revision and set its traffic weight to **0%**.
5. Click **Save** at the top. The load balancer instantly shifts 100% of network traffic to the old version.

##### **Method B: Using the Azure CLI**
You can instantly change traffic routing to an older revision using a single command:

```bash
# Shift 100% of traffic to a specific past revision name
az containerapp ingress traffic set \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --revision-weight "cloudpdf-service--oldrevisionname=100"
```

If you are in **Single Revision Mode** (where only one container runs at a time), you switch versions by pointing the app to the older image tag or digest directly:
```bash
az containerapp update \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --image ${ACR_NAME}.azurecr.io/cloudpdf-processor:v1
```

---

### **Q14: How are the revision suffixes (like `cloudpdf-service--nyjabj4` vs. `cloudpdf-service--0000001`) generated in Azure Container Apps, and can we customize them?**

**Answer:**

Azure Container Apps constructs Revision names using the format: `<container-app-name>--<suffix>`. The suffix is generated in two different ways depending on how the update was triggered:

#### **1. Random Alphanumeric Suffix (e.g. `nyjabj4`)**
* **Trigger**: Generated when you run a direct Azure CLI update (like `az containerapp update`) or modify settings manually in the Azure Portal without specifying a custom suffix.
* **Mechanism**: Azure's server-side platform generates a random 7-character alphanumeric string. This guarantees that the revision name is unique and does not collide with any past configurations.

#### **2. Sequential Suffix (e.g. `0000001`, `0000002`)**
* **Trigger**: Commonly generated when you deploy updates using declarative templates (like ARM/Bicep, Terraform, or CI/CD pipelines using actions like `azure/containerapps-deploy-action`).
* **Mechanism**: The deployment engine keeps track of the active version numbers and appends an auto-incremented, 7-digit numeric string starting at `0000001` for the first release, `0000002` for the second, and so on.

---

#### **Can we customize the revision suffix?**
**Yes.** You can explicitly control the revision suffix to make it meaningful (e.g., matching the Git commit SHA or build ID). 

* **Via Azure CLI**: Pass the `--revision-suffix` parameter:
  ```bash
  az containerapp update \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --image ${ACR_NAME}.azurecr.io/cloudpdf-processor:v1 \
    --revision-suffix "v1-0-3"
  ```
  This creates a revision named: `cloudpdf-service--v1-0-3`.

* **Via GitHub Actions**: If you are deploying using the Container Apps Deploy action, you can map the suffix to your short commit ID inside the YAML configuration:
  ```yaml
  with:
    revisionSuffix: ${{ steps.vars.outputs.sha_short }}
  ```
  This results in a clean, traceable revision name: `cloudpdf-service--16a12a2`.













