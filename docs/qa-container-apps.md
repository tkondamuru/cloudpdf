# Q&A: Azure Container Apps, Environments & Revisions

This document contains a curated list of questions and answers regarding environments, networking, service discovery, ports, revision management, and rollback mechanisms in **Azure Container Apps (ACA)**.

---

### **Q1: Why do we need to create an Azure Container App Environment, and what is its underlying architectural purpose in our deployment?**

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

---

### **Q2: How does service discovery work inside an Azure Container App Environment, and are the internal URLs for container communication automatically created and managed by Azure?**

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

### **Q3: How is the "simple app name" identified during deployment, is port 8080 a default port in container communications, and how/where do we specify these configurations?**

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
   In our `Dockerfile`, we specify the environment variable telling the ASP.NET Core server to listen on port `8080`, and document it:
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

### **Q4: How are image tags assigned during the container build process, and are these tags used as deployment versions to identify which image version is currently running in production?**

**Answer:**

#### **1. How do we assign image tags?**
You specify the tag during the build process using the format `repository-name:tag-name` within the `--image` parameter of the `az acr build` command:
```bash
az acr build --registry $ACR_NAME --image cloudpdf-processor:v1 .
```
In this command:
* `cloudpdf-processor` is the **Repository** (the name of the application).
* `v1` is the **Tag** (the version label).

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

### **Q5: How fast is the rollback process in Azure Container Apps, and does it natively implement a Blue-Green deployment model during updates and rollbacks?**

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

---

### **Q6: In the Azure Portal, what is the quickest way to check what image versions/tags a container has run under, and how do we switch (roll back) between different versions using the Portal vs the Azure CLI?**

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
2. In the revisions table, locate the target inactive revision (e.g., `cloudpdf-service--0000001`).
3. If the revision is in **Single Revision Mode**:
   * Select it and click **Activate** in the toolbar. Azure shifts 100% of traffic to it and deactivates the current revision.
4. If the revision is in **Multiple Revision Mode**:
   * Make sure it is active, and then adjust the **Traffic (%)** weights column (e.g. set the target revision to `100%` and the buggy one to `0%`).
   * Click **Save** to apply the shift instantly.

##### **Method B: Using the Azure CLI**
You can instantly change traffic routing to an older revision in Multiple Revision Mode:
```bash
# Shift 100% of traffic to a specific past revision name
az containerapp ingress traffic set \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --revision-weight "cloudpdf-service--oldrevisionname=100"
```

If you are in **Single Revision Mode**, you switch versions by pointing the app back to the older image tag or digest directly:
```bash
az containerapp update \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --image ${ACR_NAME}.azurecr.io/cloudpdf-processor:v1
```

---

### **Q7: How are the revision suffixes (like `cloudpdf-service--nyjabj4` vs. `cloudpdf-service--0000001`) generated in Azure Container Apps, and can we customize them?**

**Answer:**
Azure Container Apps constructs Revision names using the format: `<container-app-name>--<suffix>`. The suffix is generated in two different ways depending on how the update was triggered:

#### **1. Random Alphanumeric Suffix (e.g. `nyjabj4`)**
* **Trigger**: Generated when you run a direct Azure CLI update (like `az containerapp update`) or modify settings manually in the Azure Portal without specifying a custom suffix.
* **Mechanism**: Azure's server-side platform generates a random 7-character alphanumeric string to guarantee uniqueness.

#### **2. Sequential Suffix (e.g. `0000001`, `0000002`)**
* **Trigger**: Commonly generated when you deploy updates using declarative templates or CI/CD pipelines (e.g. `azure/containerapps-deploy-action`).
* **Mechanism**: The deployment engine keeps track of the active version numbers and appends an auto-incremented, 7-digit numeric string starting at `0000001`.

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

* **Via GitHub Actions**: If you are deploying using a custom YAML configuration, you can pass the timestamp or short SHA to generate traceable revision names:
  ```yaml
  --revision-suffix t${{ steps.vars.outputs.timestamp }}
  ```
