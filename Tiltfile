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
        "DATABASE_URL": "postgresql://lifecycle:lifecycle@local-postgres.{}.svc.cluster.local:5432/lifecycle".format(app_namespace),
        "REDIS_URL": "redis://redis-master.{}.svc.cluster.local:6379".format(app_namespace),
    },
    live_update=[
        sync("./src", "/app/src"),
    ],
)

lifecycle_deployment = decode_yaml_stream(helm(
    './helm/web-app/',
    name='lifecycle',
    namespace=app_namespace,
    values=['./helm/environments/local/lifecycle.yaml', './helm/environments/local/secrets.yaml'],
    set=[
        'namespace={}'.format(app_namespace),
        'image.repository={}'.format(lifecycle_app),
        'image.tag=dev',
    ]
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
        if "web" in name:
            labels = ["web"]
            port_forwards = ['5001:80']
        elif "worker" in name:
            labels = ["worker"]
        k8s_resource(
            name,
            resource_deps=['local-postgres', 'redis'],
            labels=labels,
            port_forwards=port_forwards
        )

##################################
# NGROK
##################################
ngrok_authtoken = os.getenv("NGROK_AUTHTOKEN", "")
ngrok_domain = os.getenv("NGROK_LIFECYCLE_DOMAIN", "")

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
""".format(app_namespace, ngrok_authtoken, ngrok_domain)

ngrok_secret_obj = decode_yaml_stream(ngrok_secret_yaml)
k8s_yaml(encode_yaml_stream(ngrok_secret_obj))
k8s_yaml('sysops/tilt/ngrok.yaml')
k8s_resource(
    'ngrok',
    port_forwards=['4040:4040'],
    labels=["infra"]
)

# Helper function to add namespace to kubernetes resources
def kustomize_with_helm(yaml_path, namespace):
    yaml = helm(
        None,
        name="custom-namespace",
        namespace=namespace,
        template=[yaml_path],
        set=["namespace={}".format(namespace)]
    )
    return yaml

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
