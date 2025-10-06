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

# NGROK Configuration
ngrok_authtoken = os.getenv("NGROK_AUTHTOKEN", "")
ngrok_domain = os.getenv("NGROK_LIFECYCLE_DOMAIN", "")
ngrok_keycloak_domain = os.getenv("NGROK_KEYCLOAK_DOMAIN", "")


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
    'keycloak.url={}'.format(ngrok_keycloak_domain or 'localhost'),
    'keycloak.appUrl={}'.format(ngrok_domain or 'localhost:5001'),
    # Update IDP URLs to use ngrok domain or localhost
    'keycloak.companyIdp.tokenUrl=https://{}/realms/company/protocol/openid-connect/token'.format(ngrok_keycloak_domain) if ngrok_keycloak_domain else 'keycloak.companyIdp.tokenUrl=http://localhost:8080/realms/company/protocol/openid-connect/token',
    'keycloak.companyIdp.authorizationUrl=https://{}/realms/company/protocol/openid-connect/auth'.format(ngrok_keycloak_domain) if ngrok_keycloak_domain else 'keycloak.companyIdp.authorizationUrl=http://localhost:8080/realms/company/protocol/openid-connect/auth',
    'keycloak.companyIdp.userInfoUrl=https://{}/realms/company/protocol/openid-connect/userinfo'.format(ngrok_keycloak_domain) if ngrok_keycloak_domain else 'keycloak.companyIdp.userInfoUrl=http://localhost:8080/realms/company/protocol/openid-connect/userinfo',
    'keycloak.companyIdp.jwksUrl=https://{}/realms/company/protocol/openid-connect/certs'.format(ngrok_keycloak_domain) if ngrok_keycloak_domain else 'keycloak.companyIdp.jwksUrl=http://localhost:8080/realms/company/protocol/openid-connect/certs',
    'keycloak.companyIdp.issuer=https://{}/realms/company'.format(ngrok_keycloak_domain) if ngrok_keycloak_domain else 'keycloak.companyIdp.issuer=http://localhost:8080/realms/company',
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
            resource_deps = ['local-postgres', 'redis']
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
