# Lifecycle

**Build ephemeral environments from pull requests.**

**What is lifecycle?**  
lifecycle is a tool that transforms pull requests into ephemeral development environments that seamlessly connect to required dependencies while remaining isolated from unrelated changes.

[Get started here](https://goodrxoss.github.io/lifecycle-docs)

**Lifecycle in action**

[Watch it on youtube](https://youtu.be/ld9rWBPU3R8)

<https://github.com/user-attachments/assets/27d7e7a8-298b-43ed-8dc5-85300eeb978c>

**Use Cases:**

- **Development:**  
  Isolated environments for feature branches to develop, without interference from others' work.

- **Testing:**  
  Fully connected and function environments for manual and automated testing.

- **Design Review:**  
  Live environments for product managers and designers to interact with new features.

- **External Sandboxes:**  
  Isolated sandboxes for partners and vendors that share only what’s necessary, avoiding full staging access.

Happy coding! Join the community on [Discord](https://discord.gg/TEtKgCs8T8)


## Development

### Prerequisites

Install the following tools using [Homebrew](https://brew.sh/):

```shell
brew install tilt kind kubectx kubectl
brew install --cask docker
```

### Configuration

-  **Ngrok**:
    The project uses `ngrok` to create a public URL for your local instance. You will need to:
    -   Sign up for an [ngrok account](https://dashboard.ngrok.com/signup) to get an authtoken.
    -   Set the following environment variables. You can add them to your shell profile (e.g., `~/.zshrc` or `~/.bash_profile`).

    ```shell
    export NGROK_AUTHTOKEN="<your_ngrok_authtoken>"
    export NGROK_LIFECYCLE_DOMAIN="<your_ngrok_domain>" # your ngrok domain. needs paid plan to get a static domain
    ```

-  **AWS Credentials**: (Optional, if using AWS ECR)
    Ensure your AWS credentials are set up in `~/.aws/credentials`. The Tilt environment needs this to create a Kubernetes secret for the application.

### Running Locally

-  Create a local Kubernetes cluster using `kind`:
    ```shell
    kind create cluster --config sysops/tilt/kind-config.yaml --name lfc
    ```
> [!IMPORTANT]  
> We need to use a custom `kind` config file to allow insecure registries setup for local development.

-  Switch your Kubernetes context to the newly created cluster:
    ```shell
    kx kind-lfc
    ```

-  Setup local env secrets at `helm/environments/local/secrets.yaml`:
    ```yaml
    secrets:
      databaseUrl: postgresql://lifecycle:lifecycle@local-postgres:5432/lifecycle
      redisUrl: redis://redis-master:6379
      githubPrivateKey: "<private_key_without_new_lines>"
      githubClientSecret: "<client_secret>"
      githubWebhookSecret: "<webhook_secret>"
      githubAppId: "<app_id>"
      githubClientId: "<client_id>"
      githubInstallationId: "<installation_id>"
    ```
> [!NOTE]  
> You can create the GitHub app with the app creation setup flow and then copy the secrets created for local development.

-  Start the development environment using `tilt`:
    ```shell
    tilt up
    ```