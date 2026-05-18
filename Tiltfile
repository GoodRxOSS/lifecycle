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
load("ext://secret", "secret_create_generic", "secret_from_dict")
load('ext://dotenv', 'dotenv')

update_settings(k8s_upsert_timeout_secs=180)

# Load .env file if it exists
dotenv()

config.define_string("aws_role", usage='AWS role to use for deployment')
config.define_string(
    "keycloak_chart_source",
    usage='Keycloak chart source: auto, published, or local. auto uses ../helm-charts when present and published charts otherwise.'
)
config.define_string(
    "keycloak_operator_chart_version",
    usage='Optional published keycloak-operator chart version. Empty uses the latest chart from the Helm repo.'
)
config.define_string(
    "lifecycle_keycloak_chart_version",
    usage='Optional published lifecycle-keycloak chart version. Empty uses the latest chart from the Helm repo.'
)
cfg = config.parse();
aws_role = cfg.get("aws_role", "1")
keycloak_chart_source = cfg.get("keycloak_chart_source", "auto")
keycloak_operator_chart_version_override = cfg.get("keycloak_operator_chart_version", "")
lifecycle_keycloak_chart_version_override = cfg.get("lifecycle_keycloak_chart_version", "")
if keycloak_chart_source not in ["auto", "published", "local"]:
    fail('keycloak_chart_source must be one of: auto, published, local')

# set the aws role
if aws_role:
    os.environ["AWS_SDK_LOAD_CONFIG"] = aws_role

##################################
# Variables
##################################
lifecycle_app = 'lifecycle-app'
app_namespace = 'lifecycle-app'
kind_cluster_name = 'lfc'
helm_charts_dir = '../helm-charts/charts'
local_keycloak_operator_chart = '{}/keycloak-operator'.format(helm_charts_dir)
local_lifecycle_keycloak_chart = '{}/lifecycle-keycloak'.format(helm_charts_dir)
lifecycle_keycloak_values = 'sysops/tilt/lifecycle-keycloak-values.yaml'
lifecycle_local_secrets = './helm/environments/local/secrets.yaml'
github_idp_secret_name = 'lifecycle-keycloak-github-idp'
has_local_keycloak_charts = os.path.exists(local_keycloak_operator_chart) and os.path.exists(local_lifecycle_keycloak_chart)
use_local_keycloak_charts = keycloak_chart_source == "local" or (keycloak_chart_source == "auto" and has_local_keycloak_charts)
if keycloak_chart_source == "local" and not has_local_keycloak_charts:
    fail('keycloak_chart_source=local requires ../helm-charts/charts/keycloak-operator and ../helm-charts/charts/lifecycle-keycloak')

keycloak_operator_chart = local_keycloak_operator_chart if use_local_keycloak_charts else 'goodrxoss/keycloak-operator'
lifecycle_keycloak_chart = local_lifecycle_keycloak_chart if use_local_keycloak_charts else 'goodrxoss/lifecycle-keycloak'
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
internal_keycloak_origin = "http://lifecycle-keycloak-service.{}.svc.cluster.local:8080".format(app_namespace)


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
if not use_local_keycloak_charts:
    helm_repo('goodrxoss', 'https://goodrxoss.github.io/helm-charts')

helm_resource(
    name='redis',
    chart='bitnami/redis',
    namespace=app_namespace,
    resource_deps=['bitnami'],
    flags=[
        '--version', '25.5.2',
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
# Keycloak Operator + Realm Chart (Helm)
##################################
keycloak_operator_deps = []
keycloak_operator_resource_deps = []
keycloak_operator_flags = []
lifecycle_keycloak_deps = [
    lifecycle_keycloak_values,
    lifecycle_local_secrets,
]
lifecycle_keycloak_resource_deps = [
    'keycloak-operator',
    'legacy-keycloak-cleanup',
]
lifecycle_keycloak_flags = []

def local_secret_value(key):
    return str(local([
        'node',
        '-e',
        'const fs = require("fs"); const [file, key] = process.argv.slice(1); const text = fs.readFileSync(file, "utf8"); const escaped = key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"); const re = new RegExp("^\\\\s*" + escaped + ":\\\\s*[\\\\\\"\\\']?([^\\\\\\"\\\'\\\\n#]+)", "m"); const match = text.match(re); process.stdout.write(match ? match[1].trim() : "");',
        lifecycle_local_secrets,
        key,
    ], quiet=True))

github_idp_client_id = local_secret_value('githubClientId') or os.getenv('GITHUB_CLIENT_ID', 'local-github-client-id')
github_idp_client_secret = local_secret_value('githubClientSecret') or os.getenv('GITHUB_CLIENT_SECRET', 'local-github-client-secret')
if github_idp_client_id == '' or github_idp_client_secret == '':
    github_idp_client_id = 'local-github-client-id'
    github_idp_client_secret = 'local-github-client-secret'
    print('GitHub IDP: GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not configured; GitHub account linking will use placeholders')

k8s_yaml(secret_from_dict(
    github_idp_secret_name,
    namespace=app_namespace,
    inputs={
        'clientId': github_idp_client_id,
        'clientSecret': github_idp_client_secret,
    },
))

if use_local_keycloak_charts:
    keycloak_operator_deps.append(keycloak_operator_chart)
    lifecycle_keycloak_deps.append(lifecycle_keycloak_chart)
    lifecycle_keycloak_resource_deps.append('lifecycle-keycloak-chart-deps')

    local_resource(
        'lifecycle-keycloak-chart-deps',
        cmd='helm dependency update {}'.format(lifecycle_keycloak_chart),
        deps=[
            '{}/Chart.yaml'.format(lifecycle_keycloak_chart),
            '{}/values.yaml'.format(lifecycle_keycloak_chart),
        ],
        resource_deps=['bitnami'],
        labels=['infra'],
    )
else:
    if keycloak_operator_chart_version_override:
        keycloak_operator_flags.extend(['--version', keycloak_operator_chart_version_override])
    keycloak_operator_resource_deps.append('goodrxoss')
    if lifecycle_keycloak_chart_version_override:
        lifecycle_keycloak_flags.extend(['--version', lifecycle_keycloak_chart_version_override])
    lifecycle_keycloak_resource_deps.append('goodrxoss')

helm_resource(
    name='keycloak-operator',
    chart=keycloak_operator_chart,
    namespace=app_namespace,
    deps=keycloak_operator_deps,
    resource_deps=keycloak_operator_resource_deps,
    flags=keycloak_operator_flags,
    labels=['infra'],
)

local_resource(
    'legacy-keycloak-cleanup',
    cmd='kubectl -n {namespace} delete deployment/lifecycle-keycloak service/lifecycle-keycloak configmap/lifecycle-keycloak-config deployment/lifecycle-keycloak-postgresql service/lifecycle-keycloak-postgresql --ignore-not-found=true'.format(
        namespace=app_namespace,
    ),
    labels=['infra'],
)

helm_resource(
    name='lifecycle-keycloak',
    chart=lifecycle_keycloak_chart,
    namespace=app_namespace,
    deps=lifecycle_keycloak_deps,
    resource_deps=lifecycle_keycloak_resource_deps,
    flags=lifecycle_keycloak_flags + [
        '-f', lifecycle_keycloak_values,
        '-f', lifecycle_local_secrets,
        '--set', 'hostname={}'.format(company_idp_origin),
        '--set', 'clients.lifecycleUi.url={}://{}'.format(ui_scheme, ui_host),
        '--set', 'companyIdp.tokenUrl={}/realms/internal/protocol/openid-connect/token'.format(internal_keycloak_origin),
        '--set', 'companyIdp.authorizationUrl={}/realms/internal/protocol/openid-connect/auth'.format(company_idp_origin),
        '--set', 'companyIdp.jwksUrl={}/realms/internal/protocol/openid-connect/certs'.format(internal_keycloak_origin),
        '--set', 'companyIdp.logoutUrl={}/realms/internal/protocol/openid-connect/logout'.format(company_idp_origin),
        '--set', 'companyIdp.issuer={}/realms/internal'.format(company_idp_origin),
    ],
    labels=['infra'],
)

local_resource(
    'lifecycle-keycloak-github-idp-sync',
    cmd='sh sysops/tilt/scripts/sync_keycloak_github_idp.sh {namespace} {secret}'.format(
        namespace=app_namespace,
        secret=github_idp_secret_name,
    ),
    deps=[
        lifecycle_local_secrets,
        'sysops/tilt/scripts/sync_keycloak_github_idp.sh',
    ],
    resource_deps=['lifecycle-keycloak'],
    labels=['infra'],
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
    'keycloak.enabled=false',
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
    'secrets.githubAppAuthCallback={}/realms/lifecycle/broker/github/endpoint'.format(company_idp_origin),
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
            resource_deps = ['local-postgres', 'redis', 'lifecycle-keycloak-github-idp-sync', 'agent-session-workspace-image']
        if "web" in name:
            labels = ["web"]
            port_forwards = ['5001:80']
        elif "gateway" in name:
            labels = ["gateway"]
            port_forwards = ['5002:80']
        elif "worker" in name:
            labels = ["worker"]
            resource_deps.append('lifecycle-web')
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
    labels=["infra"],
    resource_deps=['lifecycle-keycloak']
)

##################################
# Keycloak (deployed via helm-charts lifecycle-keycloak)
##################################
k8s_resource(
    'lifecycle-keycloak',
    port_forwards=['8081:8080'],
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
