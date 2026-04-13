# Copyright 2025 GoodRx, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

##################################
# Tilt Extensions
##################################
load('ext://helm_resource', 'helm_resource', 'helm_repo')
load("ext://restart_process", "docker_build_with_restart")
load("ext://secret", "secret_create_generic")
load('ext://dotenv', 'dotenv')

# Load .env file if it exists
dotenv()

config.define_string("aws_role", usage='AWS role to use for deployment')
cfg = config.parse();
aws_role = cfg.get("aws_role", "1")

# set the aws role
if aws_role:
    os.environ["AWS_SDK_LOAD_CONFIG"] = aws_role

##################################
# Variables
##################################
lifecycle_app = 'lifecycle-app'
app_namespace = 'lifecycle-app'
kind_cluster_name = 'lfc'
agent_session_workspace_image = 'lifecycle-workspace'
agent_session_workspace_image_ref = '{}:latest'.format(agent_session_workspace_image)
legacy_agent_session_workspace_image_ref = 'lifecycle-agent:latest'
agent_session_workspace_image_deps = [
    '.dockerignore',
    'sysops/dockerfiles/agent.Dockerfile',
    'sysops/workspace-gateway',
]

# NGROK Configuration
ngrok_authtoken = os.getenv("NGROK_AUTHTOKEN", "")
ngrok_domain = os.getenv("NGROK_LIFECYCLE_DOMAIN", "")
ngrok_keycloak_domain = os.getenv("NGROK_KEYCLOAK_DOMAIN", "")
ngrok_ui_domain = os.getenv("NGROK_LIFECYCLE_UI_DOMAIN", "")
keycloak_scheme = "https" if ngrok_keycloak_domain else "http"
app_scheme = "https" if ngrok_domain else "http"
ui_scheme = "https" if ngrok_ui_domain else "http"
keycloak_host = ngrok_keycloak_domain or "localhost:8081"
app_host = ngrok_domain or "localhost:5001"
ui_host = ngrok_ui_domain or "localhost:3000"
company_idp_origin = "{}://{}".format(keycloak_scheme, keycloak_host)
internal_keycloak_origin = "http://lifecycle-keycloak.{}.svc.cluster.local:8080".format(app_namespace)


##################################
# Create Namespace
##################################
k8s_yaml(blob("""apiVersion: v1
kind: Namespace
metadata:
  name: {}
""".format(app_namespace)))

##################################
# AWS Credentials (Generic Secret)
##################################
secret_create_generic(
    "aws-creds",
    namespace=app_namespace,
    from_file=[os.path.join(os.environ["HOME"], ".aws", "credentials")],
)

##################################
# Bitnami Redis (Helm)
##################################
helm_repo('bitnami', 'https://charts.bitnami.com/bitnami')
helm_repo('ingress-nginx-chart', 'https://kubernetes.github.io/ingress-nginx')

helm_resource(
    name='redis',
    chart='bitnami/redis',
    namespace=app_namespace,
    resource_deps=['bitnami'],
    flags=[
        '--set', 'auth.enabled=false',
        '--set', 'replica.replicaCount=0',
        '--set', 'auth.usePasswordFiles=false',
    ],
    labels=["infra"]
)
k8s_resource(
    "redis",
    port_forwards=["6333:6379"],
    labels=["infra"]
)

##################################
# Local Postgres (K8s)
##################################
docker_build(
    'local-postgres',
    context='.',
    dockerfile='./sysops/dockerfiles/db.Dockerfile',
    ignore=[
      "**/*",
      "!sysops/**"
    ]
)
k8s_yaml('sysops/tilt/local-postgres.yaml')
k8s_resource(
    'local-postgres',
    port_forwards=['5434:5432'],
    labels=["infra"]
)

##################################
# Agent Session Workspace Runtime
##################################
local_resource(
    'agent-session-workspace-image',
    cmd='docker build -t {workspace_ref} -t {legacy_ref} -f sysops/dockerfiles/agent.Dockerfile . && kind load docker-image {workspace_ref} {legacy_ref} --name {cluster}'.format(
        workspace_ref=agent_session_workspace_image_ref,
        legacy_ref=legacy_agent_session_workspace_image_ref,
        cluster=kind_cluster_name,
    ),
    deps=agent_session_workspace_image_deps,
    labels=['infra'],
)

##################################
# Ingress NGINX (Helm)
##################################
helm_resource(
    name='ingress-nginx',
    chart='ingress-nginx-chart/ingress-nginx',
    namespace='ingress-nginx',
    resource_deps=['ingress-nginx-chart'],
    flags=[
        '--create-namespace',
        '--version', '4.15.1',
        '-f', 'sysops/tilt/ingress-nginx-values.yaml',
    ],
    labels=["infra"]
)

##################################
# MinIO (Helm)
##################################
helm_resource(
    name='minio',
    chart='bitnami/minio',
    namespace=app_namespace,
    resource_deps=['bitnami'],
    flags=[
        '--version', '17.0.21',
        '--set', 'auth.rootUser=minioadmin',
        '--set', 'auth.rootPassword=minioadmin',
        '--set', 'defaultBuckets=lifecycle-logs',
        '--set', 'persistence.enabled=false',
        '--set', 'image.repository=bitnamilegacy/minio',
        '--set', 'image.tag=2025.7.23',
        '--set', 'clientImage.repository=bitnamilegacy/minio-client',
        '--set', 'clientImage.tag=2025.7.23',
        '--set', 'console.image.repository=bitnamilegacy/minio-object-browser',
        '--set', 'console.image.tag=2.0.2-debian-12-r3',
        '--set', 'volumePermissions.image.repository=bitnamilegacy/os-shell',
        '--set', 'volumePermissions.image.tag=2025.7.23',
    ],
    labels=["infra"]
)
k8s_resource(
    "minio",
    port_forwards=["9000:9000", "9001:9001"],
    labels=["infra"]
)

##################################
# Worker & Web (Helm, Single Deploy)
##################################

docker_build_with_restart(
    lifecycle_app,
    ".",
    entrypoint=["/app_setup_entrypoint.sh"],
    dockerfile="sysops/dockerfiles/tilt.app.dockerfile",
    build_args={
        "APP_DB_HOST": "local-postgres.{}.svc.cluster.local".format(app_namespace),
        "APP_DB_PORT": "5432",
        "APP_DB_USER": "lifecycle",
        "APP_DB_PASSWORD": "lifecycle",
        "APP_DB_NAME": "lifecycle",
        "APP_DB_SSL": "false",
        "APP_REDIS_HOST": "redis-master.{}.svc.cluster.local".format(app_namespace),
        "APP_REDIS_PORT": "6379",
        "APP_REDIS_PASSWORD": "",
    },
    live_update=[
        sync("./src", "/app/src"),
    ],
)

helm_set_args = [
    'namespace={}'.format(app_namespace),
    'image.repository={}'.format(lifecycle_app),
    'image.tag=dev',
    'keycloak.scheme={}'.format(keycloak_scheme),
    'keycloak.url={}'.format(keycloak_host),
    'keycloak.appUrl={}'.format(app_host),
    'keycloak.uiScheme={}'.format(ui_scheme),
    'keycloak.uiUrl={}'.format(ui_host),
    'secrets.keycloakIssuerPublic={}/realms/lifecycle'.format(company_idp_origin),
    'secrets.keycloakIssuerInternal={}/realms/lifecycle'.format(internal_keycloak_origin),
    # Update IDP URLs to use ngrok domain or localhost
    'keycloak.companyIdp.tokenUrl={}/realms/company/protocol/openid-connect/token'.format(internal_keycloak_origin),
    'keycloak.companyIdp.authorizationUrl={}/realms/company/protocol/openid-connect/auth'.format(company_idp_origin),
    'keycloak.companyIdp.userInfoUrl={}/realms/company/protocol/openid-connect/userinfo'.format(internal_keycloak_origin),
    'keycloak.companyIdp.jwksUrl={}/realms/company/protocol/openid-connect/certs'.format(internal_keycloak_origin),
    'keycloak.companyIdp.issuer={}/realms/company'.format(company_idp_origin),
    'secrets.aiApiKey={}'.format(os.getenv("AI_API_KEY", "")),
    'secrets.geminiApiKey={}'.format(os.getenv("GEMINI_API_KEY", "")),
]

lifecycle_deployment = decode_yaml_stream(helm(
    './helm/web-app/',
    name='lifecycle',
    namespace=app_namespace,
    values=['./helm/environments/local/lifecycle.yaml', './helm/environments/local/secrets.yaml'],
    set=helm_set_args
))

patched_deploy = []
for r in lifecycle_deployment:
    if r.get("kind") == "Deployment":
        if r["spec"]["template"]["spec"].get("volumes") == None:
            r["spec"]["template"]["spec"]["volumes"] = []
        r["spec"]["template"]["spec"]["volumes"].append({
            "name": "aws-creds",
            "secret": {"secretName": "aws-creds"}
        })
        containers = r["spec"]["template"]["spec"].get("containers", [])
        if len(containers) > 0:
            container = containers[0]
            if container.get("volumeMounts") == None:
                container["volumeMounts"] = []
            container["volumeMounts"].append({
                "name": "aws-creds",
                "mountPath": "/root/.aws/credentials",
                "subPath": "credentials",
                "readOnly": False
            })
    patched_deploy.append(r)

k8s_yaml(encode_yaml_stream(patched_deploy))

# Register both resources for port-forwarding and labels
for r in patched_deploy:
    if r.get("kind") == "Deployment":
        name = r["metadata"]["name"]
        labels = []
        port_forwards = []
        resource_deps = []

        # Don't add postgres/redis deps for keycloak resources
        if "keycloak" not in name:
            resource_deps = ['local-postgres', 'redis', 'agent-session-workspace-image']
        if "web" in name:
            labels = ["web"]
            port_forwards = ['5001:80']
        elif "worker" in name:
            labels = ["worker"]
        k8s_resource(
            name,
            resource_deps=resource_deps,
            labels=labels,
            port_forwards=port_forwards
        )

##################################
# NGROK
##################################

ngrok_secret_yaml = """
apiVersion: v1
kind: Secret
metadata:
  name: ngrok-secret
  namespace: {}
type: Opaque
stringData:
  NGROK_AUTHTOKEN: "{}"
  NGROK_LIFECYCLE_DOMAIN: "{}"
  NGROK_KEYCLOAK_DOMAIN: "{}"
""".format(app_namespace, ngrok_authtoken, ngrok_domain, ngrok_keycloak_domain)

ngrok_secret_obj = decode_yaml_stream(ngrok_secret_yaml)
k8s_yaml(encode_yaml_stream(ngrok_secret_obj))

# Main app ngrok
k8s_yaml('sysops/tilt/ngrok.yaml')
k8s_resource(
    'ngrok',
    port_forwards=['4040:4040'],
    labels=["infra"]
)

# Ngrok for Keycloak
k8s_yaml('sysops/tilt/ngrok-keycloak.yaml')
k8s_resource(
    'ngrok-keycloak',
    port_forwards=['4041:4040'],  # Different local port for Keycloak ngrok admin
    labels=["infra"]
)

##################################
# Keycloak (deployed via Helm)
##################################
# Keycloak is deployed as part of the lifecycle helm release
# We just need to configure the resources for Tilt UI
k8s_resource(
    'lifecycle-keycloak',
    port_forwards=['8081:8080'],
    labels=["infra"],
    resource_deps=['lifecycle-keycloak-postgresql']
)
k8s_resource(
    'lifecycle-keycloak-postgresql',
    labels=["infra"]
)

##################################
# DISTRIBUTION
##################################
k8s_yaml('sysops/tilt/distribution.yaml')
k8s_resource(
    'distribution', 
    port_forwards=["8088:5000"], 
    labels=["infra"]
)

##################################
# BUILDKIT
##################################
k8s_yaml('sysops/tilt/buildkit.yaml')
k8s_resource(
    'buildkit', 
    port_forwards=["1234:1234"], 
    resource_deps=['distribution'],
    labels=["infra"]
)
