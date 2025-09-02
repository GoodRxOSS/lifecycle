/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Knex } from 'knex';

export async function up(knex: Knex): Promise<any> {
  const IS_DEV = process.env.APP_ENV === 'dev';
  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS _knex_migrations_id_seq;
    CREATE TABLE IF NOT EXISTS _knex_migrations (
      id integer DEFAULT nextval('_knex_migrations_id_seq'::regclass) NOT NULL PRIMARY KEY,
      name varchar(255),
      batch integer,
      migration_time timestamp(6) with time zone
    );
    ALTER TABLE _knex_migrations OWNER TO lifecycle;
    ALTER SEQUENCE _knex_migrations_id_seq OWNED BY _knex_migrations.id;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS _knex_migrations_lock (
      index integer NOT NULL PRIMARY KEY,
      is_locked integer
    );
    ALTER TABLE _knex_migrations_lock OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS environments_id_seq;  
    CREATE TABLE IF NOT EXISTS environments (
      id integer DEFAULT nextval('environments_id_seq'::regclass) NOT NULL PRIMARY KEY,
      name varchar(255),
      uuid varchar(255),
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "enableFullYaml" boolean DEFAULT false,
      "classicModeOnly" boolean DEFAULT false,
      "autoDeploy" boolean DEFAULT false
    );
    ALTER TABLE environments OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
  CREATE SEQUENCE IF NOT EXISTS repositories_id_seq;
    CREATE TABLE IF NOT EXISTS repositories (
      id integer DEFAULT nextval('repositories_id_seq'::regclass) NOT NULL PRIMARY KEY,
      "githubRepositoryId" integer NOT NULL,
      "githubInstallationId" integer NOT NULL,
      "defaultEnvId" integer,
      "fullName" varchar(255),
      "htmlUrl" varchar(255),
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "ownerId" integer
    );
    ALTER TABLE repositories OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS pr_id_seq;
    CREATE TABLE IF NOT EXISTS pull_requests (
      id integer DEFAULT nextval('pr_id_seq'::regclass) NOT NULL PRIMARY KEY,
      "githubPullRequestId" bigint NOT NULL,
      title varchar(255),
      status varchar(255),
      "repositoryId" integer NOT NULL,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "deployOnUpdate" boolean,
      "pullRequestNumber" integer,
      "commentId" bigint,
      "fullName" varchar(255),
      etag varchar(255),
      "consoleId" bigint,
      "statusCommentId" bigint,
      "githubLogin" varchar(255),
      "branchName" varchar(255),
      labels json DEFAULT '[]'::json,
      config json DEFAULT '{}'::json,
      "latestCommit" varchar(255) DEFAULT ''::character varying
    );
    ALTER TABLE pull_requests OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS builds_id_seq;
    CREATE TABLE IF NOT EXISTS builds (
      id integer DEFAULT nextval('builds_id_seq'::regclass) NOT NULL PRIMARY KEY,
      uuid varchar(255),
      status varchar(255),
      "statusMessage" text,
      manifest text,
      "environmentId" integer,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "pullRequestId" integer,
      "buildRequestId" integer,
      sha varchar(255),
      "commentRuntimeEnv" json DEFAULT '{}'::json,
      "commentInitEnv" json DEFAULT '{}'::json,
      "runUUID" varchar(255),
      "trackDefaultBranches" boolean DEFAULT false,
      "capacityType" varchar(255),
      "enableFullYaml" boolean DEFAULT false,
      "webhooksYaml" varchar(4096),
      "dashboardLinks" json DEFAULT '{}'::json,
      "enabledFeatures" json DEFAULT '[]'::json,
      "isStatic" boolean DEFAULT false,
      "githubDeployments" boolean DEFAULT false,
      "hasGithubStatusComment" boolean DEFAULT false,
      "dependencyGraph" jsonb DEFAULT '{}'::jsonb,
      namespace text DEFAULT 'lifecycle-deployments'::text
    );
    ALTER TABLE builds OWNER TO lifecycle;
    INSERT INTO builds (
      uuid, status, "statusMessage", "environmentId", 
      "createdAt", "updatedAt", sha, namespace
    )
    VALUES (
      'dev-0', 'pending', 'Build is pending', 1,
      NOW(), NOW(), 'abc123', 'env-dev-0'
    )
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS services_id_seq;
    CREATE TABLE IF NOT EXISTS services (
      id integer DEFAULT nextval('services_id_seq'::regclass) NOT NULL PRIMARY KEY,
      name varchar(255),
      layer varchar(255),
      type text,
      "dockerImage" varchar(255),
      "repositoryId" varchar(255),
      "defaultTag" varchar(255),
      "dockerfilePath" varchar(255),
      "buildArgs" varchar(255),
      port varchar(255),
      command varchar(255),
      arguments varchar(4096),
      env json,
      "createdById" integer,
      "environmentId" integer,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "branchName" varchar(255),
      public boolean NOT NULL,
      "cpuRequest" varchar(255),
      "memoryRequest" varchar(255),
      "cpuLimit" varchar(255),
      "memoryLimit" varchar(255),
      "readinessInitialDelaySeconds" integer,
      "readinessPeriodSeconds" integer,
      "readinessTimeoutSeconds" integer,
      "readinessSuccessThreshold" integer,
      "readinessFailureThreshold" integer,
      "readinessTcpSocketPort" integer,
      "readinessHttpGetPath" varchar(255),
      "readinessHttpGetPort" integer,
      host varchar(255),
      "acmARN" varchar(255),
      "initDockerfilePath" varchar(255),
      "initCommand" varchar(255),
      "initArguments" varchar(255),
      "initEnv" json,
      "hostPortMapping" json DEFAULT '{}'::json,
      "defaultInternalHostname" varchar(255),
      "defaultPublicUrl" varchar(255),
      "dependsOnServiceId" integer,
      "deployPipelineId" varchar(255),
      "deployTrigger" varchar(255),
      "destroyPipelineId" varchar(255),
      "destroyTrigger" varchar(255),
      "ipWhitelist" text[],
      "scaleToZero" boolean DEFAULT false,
      "scaleToZeroMetricsCheckInterval" integer DEFAULT 1800,
      "pathPortMapping" json DEFAULT '{}'::json,
      "afterBuildPipelineId" varchar(255) DEFAULT NULL::character varying,
      "detatchAfterBuildPipeline" boolean DEFAULT false,
      grpc boolean DEFAULT false,
      "grpcHost" varchar(255),
      "defaultGrpcHost" varchar(255),
      "defaultUUID" varchar(255) DEFAULT 'dev-0'::character varying,
      "capacityType" varchar(255) DEFAULT 'ON_DEMAND'::character varying,
      "runtimeName" varchar(255) DEFAULT ''::character varying,
      "dockerBuildPipelineName" varchar(255) DEFAULT ''::character varying,
      "appShort" varchar(255) DEFAULT NULL::character varying,
      "ecr" varchar(255) default NULL::character varying

    );
    ALTER TABLE services OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS services_disks (
      name varchar(255) NOT NULL,
      "mountPath" varchar(255) NOT NULL,
      "accessModes" varchar(255) NOT NULL,
      storage varchar(255) NOT NULL,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "serviceId" integer,
      id integer NOT NULL PRIMARY KEY,
      medium varchar(255) DEFAULT 'DISK'::character varying
    );
    ALTER TABLE services_disks OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS "environmentDefaultServices" (
      "environmentId" integer,
      "serviceId" integer,
      id serial PRIMARY KEY
    );
    ALTER TABLE "environmentDefaultServices" OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS "environmentOptionalServices_id_seq";
    CREATE TABLE IF NOT EXISTS "environmentOptionalServices" (
      "environmentId" integer,
      "serviceId" integer,
      id integer DEFAULT nextval('"environmentOptionalServices_id_seq"'::regclass) NOT NULL PRIMARY KEY
    );
    ALTER TABLE "environmentOptionalServices" OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS configurations (
      id serial PRIMARY KEY,
      "serviceId" integer,
      key varchar(255),
      data json,
      created_at timestamp with time zone,
      updated_at timestamp with time zone
    );
    ALTER TABLE configurations OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS build_service_overrides_id_seq;

    CREATE TABLE IF NOT EXISTS build_service_overrides (
      id integer DEFAULT nextval('build_service_overrides_id_seq'::regclass) NOT NULL PRIMARY KEY,
      "branchName" varchar(255),
      env json,
      "buildId" integer,
      "serviceId" integer,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "tagName" varchar(255)
    );
    ALTER TABLE build_service_overrides OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS deployables (
      id serial PRIMARY KEY,
      "buildUUID" varchar(255),
      "serviceId" integer REFERENCES services ON UPDATE CASCADE ON DELETE CASCADE,
      "buildId" integer REFERENCES builds ON UPDATE CASCADE ON DELETE CASCADE,
      name varchar(255) NOT NULL,
      layer varchar(255),
      type text NOT NULL CHECK (type = ANY (ARRAY ['github', 'docker', 'codefresh', 'externalHTTP', 'aurora-restore', 'configuration', 'helm'])),
      "dockerImage" varchar(255),
      "repositoryId" varchar(255),
      "defaultTag" varchar(255),
      "dockerfilePath" varchar(255),
      "buildArgs" varchar(255) DEFAULT '{}'::character varying,
      port varchar(255),
      command varchar(255),
      arguments varchar(4096),
      env json,
      "environmentId" integer REFERENCES environments ON UPDATE CASCADE ON DELETE CASCADE,
      "createdAt" timestamp with time zone,
      "updatedAt" timestamp with time zone,
      "deletedAt" timestamp with time zone,
      "branchName" varchar(255),
      public boolean DEFAULT false NOT NULL,
      "cpuRequest" varchar(255) DEFAULT '10m'::character varying,
      "memoryRequest" varchar(255) DEFAULT '100Mi'::character varying,
      "cpuLimit" varchar(255),
      "memoryLimit" varchar(255),
      "readinessInitialDelaySeconds" integer DEFAULT 0,
      "readinessPeriodSeconds" integer DEFAULT 10,
      "readinessTimeoutSeconds" integer DEFAULT 1,
      "readinessSuccessThreshold" integer DEFAULT 1,
      "readinessFailureThreshold" integer DEFAULT 3,
      "readinessTcpSocketPort" integer,
      "readinessHttpGetPath" varchar(255),
      "readinessHttpGetPort" integer,
      host varchar(255),
      "acmARN" varchar(255),
      "initDockerfilePath" varchar(255),
      "initCommand" varchar(255),
      "initArguments" varchar(255),
      "initEnv" json DEFAULT '{}'::json,
      "hostPortMapping" json DEFAULT '{}'::json,
      "defaultInternalHostname" varchar(255),
      "defaultPublicUrl" varchar(255),
      "dependsOnServiceId" integer,
      "dependsOnDeployableId" integer,
      "deployPipelineId" varchar(255),
      "deployTrigger" varchar(255),
      "destroyPipelineId" varchar(255),
      "destroyTrigger" varchar(255),
      "ipWhitelist" text[],
      "scaleToZero" boolean DEFAULT false,
      "scaleToZeroMetricsCheckInterval" integer DEFAULT 1800,
      "pathPortMapping" json DEFAULT '{}'::json,
      "afterBuildPipelineId" varchar(255) DEFAULT NULL::character varying,
      "detatchAfterBuildPipeline" boolean DEFAULT false,
      grpc boolean DEFAULT false,
      "grpcHost" varchar(255),
      "defaultGrpcHost" varchar(255),
      "defaultUUID" varchar(255) DEFAULT 'dev-0'::character varying,
      "capacityType" varchar(255),
      "runtimeName" varchar(255) DEFAULT ''::character varying,
      "dockerBuildPipelineName" varchar(255) DEFAULT ''::character varying,
      active boolean DEFAULT true,
      "dependsOnDeployableName" varchar(255),
      "serviceDisksYaml" varchar(4096),
      "yamlConfig" varchar(255),
      "defaultBranchName" varchar(255),
      "commentBranchName" varchar(255) DEFAULT NULL::character varying,
      "ingressAnnotations" json DEFAULT '{}'::json,
      "appShort" varchar(255) DEFAULT NULL::character varying,
      helm json DEFAULT '{}'::json,
      "deploymentDependsOn" text[] DEFAULT ARRAY[]::text[],
      "kedaScaleToZero" json DEFAULT '{}'::json,
      builder jsonb DEFAULT '{}'::jsonb,
      "ecr" varchar(255) default NULL::character varying
    );
    ALTER TABLE deployables OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE SEQUENCE IF NOT EXISTS deploys_id_seq;

    CREATE TABLE IF NOT EXISTS deploys (
      id integer DEFAULT nextval('deploys_id_seq'::regclass) NOT NULL PRIMARY KEY,
      status varchar(255),
      "statusMessage" text,
      uuid varchar(255),
      "dockerImage" varchar(255),
      "internalHostname" varchar(255),
      "publicUrl" varchar(255),
      env json,
      "buildLogs" text,
      "containerLogs" text,
      "serviceId" integer,
      "buildId" integer,
      "createdAt" timestamp(6) with time zone,
      "updatedAt" timestamp(6) with time zone,
      "deletedAt" timestamp(6) with time zone,
      "branchName" varchar(255),
      tag varchar(255),
      "githubRepositoryId" integer,
      sha varchar(255),
      "initDockerImage" varchar(255),
      "initEnv" json,
      active boolean,
      cname varchar(255),
      "runUUID" varchar(255),
      "replicaCount" integer DEFAULT 1,
      "yamlConfig" text,
      "deployableId" integer REFERENCES deployables ON UPDATE CASCADE ON DELETE CASCADE,
      "isRunningLatest" boolean DEFAULT false,
      "runningImage" varchar(255) DEFAULT NULL::character varying,
      "githubDeploymentId" integer,
      "deployPipelineId" varchar(255) DEFAULT NULL::character varying,
      "kedaScaleToZero" json DEFAULT '{}'::json,
      "buildPipelineId" text,
      "buildOutput" text,
      "deployOutput" text,
      "buildJobName" text
    );
    ALTER TABLE deploys OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS webhook_invocations (
      id serial PRIMARY KEY,
      "buildId" integer NOT NULL REFERENCES builds ON DELETE CASCADE,
      "runUUID" text NOT NULL,
      name text NOT NULL,
      type text DEFAULT 'codefresh'::text,
      state text NOT NULL,
      "yamlConfig" text NOT NULL,
      owner text DEFAULT 'build'::text,
      metadata jsonb,
      status text NOT NULL,
      "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "deletedAt" timestamp with time zone
    );
    ALTER TABLE webhook_invocations OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS "botUsers" (
      id serial PRIMARY KEY,
      "githubUser" varchar(255) NOT NULL,
      "createdAt" timestamp with time zone,
      "updatedAt" timestamp with time zone,
      "deletedAt" timestamp with time zone
    );
    ALTER TABLE "botUsers" OWNER TO lifecycle;
  `);

  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS global_config (
      id serial PRIMARY KEY,
      key varchar(255) NOT NULL UNIQUE,
      config json,
      "createdAt" timestamp with time zone,
      "updatedAt" timestamp with time zone,
      "deletedAt" timestamp with time zone,
      description varchar(255) DEFAULT ''::character varying
    );
    ALTER TABLE global_config OWNER TO lifecycle;

    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('postgresql', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"postgresql","repoUrl":"https://charts.bitnami.com/bitnami","version":"12.9.0","values":["auth.username=postgres_user","auth.password=mysecretpassword","auth.database=postgres_db","auth.enablePostgresUser=true","primary.extraPodSpec.enableServiceLinks=false"],"valueFiles":[]},"label":"primary.persistence.labels","tolerations":"primary.tolerations","affinity":"primary.affinity","nodeSelector":"primary.nodeSelector"}', now(), now(), null, 'Postgresql bitnami helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('mysql', '{"version":"3.7.2","args":"--force --timeout 60m0s","action":"install","chart":{"name":"mysql","repoUrl":"https://charts.bitnami.com/bitnami","version":"9.10.4","values":["master.replicaCount=1","ingress.enabled=true","data.replicaCount=0","coordinating.replicaCount=0","ingest.enabled=false","master.readinessProbe.timeoutSeconds=20","master.livenessProbe.timeoutSeconds=20","master.startupProbe.timeoutSeconds=20"],"valueFiles":[]},"tolerations":"primary.tolerations","affinity":"primary.affinity","nodeSelector":"primary.nodeSelector"}', now(), now(), null, 'Mysql bitnami helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('redis', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"redis","repoUrl":"https://charts.bitnami.com/bitnami","version":"20.3.0","values":["replica.replicaCount=0","replica.persistence.enabled=false","auth.enabled=false","master.resourcesPreset=none","master.readinessProbe.timeoutSeconds=20","master.readinessProbe.periodSeconds=15","master.livenessProbe.timeoutSeconds=20","master.livenessProbe.periodSeconds=15"],"valueFiles":[]},"label":"master.persistence.labels","tolerations":"master.tolerations","affinity":"master.affinity","nodeSelector":"master.nodeSelector"}', now(), now(), null, 'Redis bitnami helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('elasticsearch', '{"version":"3.7.2","args":"--force --timeout 15m0s --wait","action":"install","chart":{"name":"elasticsearch","repoUrl":"https://charts.bitnami.com/bitnami","version":"19.10.9","values":["master.replicaCount=1","ingress.enabled=true","data.replicaCount=0","coordinating.replicaCount=0","ingest.enabled=false","master.readinessProbe.timeoutSeconds=20","master.livenessProbe.timeoutSeconds=20","master.startupProbe.timeoutSeconds=20"],"valueFiles":[]},"tolerations":"master.tolerations","affinity":"master.affinity","nodeSelector":"nodeSelector"}', now(), now(), null, 'Elasticsearch bitnami helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('publicChart', '{"block":false}', now(), now(), null, 'Potential Danger: If set to true lifecycle.yaml will allow any public helm chart to be deployed. Otherwise only charts defined in global_config will be allowed.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('lifecycleDefaults', '{"defaultUUID":"dev-0","defaultPublicUrl":"dev-0.app.0env.com","cfStepType":"helm:1.1.12","ecrDomain":"${
      IS_DEV ? '10.96.188.230:5000' : 'distribution.0env.com'
    }","ecrRegistry":"default","buildPipeline":"","deployCluster":"lifecycle-gke","helmDeployPipeline":"replace_me"}', now(), now(), null, 'Default values for lifecycle');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('helmDefaults', '{"version":"3.12.0","nativeHelm":{"enabled":true,"defaultArgs":"--wait --reset-values --timeout 30m","defaultHelmVersion":"3.12.0"}}', now(), now(), null, 'Default configuration for helm deployments.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('socat-tunneller', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"isotoma/socat-tunneller","repoUrl":" https://isotoma.github.io/charts","version":"0.2.0","values":[],"valueFiles":[]},"label":"podAnnotations","tolerations":"tolerations","affinity":"affinity","nodeSelector":"nodeSelector"}', now(), now(), null, 'soca-tunneller configuration for db-tunnels with helm');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('lifecycleIgnores', '{"github":{"branches":[],"events":["closed","deleted"],"organizations":[],"botUsers":[]}}', now(), now(), null, 'Data values for Lifecycle to ignore');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('deletePendingHelmReleaseStep', '{"delete":true,"static_delete":true}', now(), now(), null, 'If deletePendingHelmReleaseStep is set to true');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('redpanda', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"redpanda","repoUrl":"https://charts.redpanda.com","version":"5.9.0","values":[],"valueFiles":[]},"tolerations":"tolerations","affinity":"affinity","nodeSelector":"nodeSelector"}', now(), now(), null, 'Redpanda helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('kedaScaleToZero', '{"type":"http","replicas":{"min":1,"max":3},"scaledownPeriod":10800,"maxRetries":10,"scalingMetric":{"requestRate":{"granularity":"1m","targetValue":30,"window":"1m"},"concurrency":{"targetValue":100}}}', now(), now(), null, 'This is the default configuration for Keda Scale To Zero');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('mongodb', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"mongodb","repoUrl":"https://charts.bitnami.com/bitnami","version":"16.3.0","values":["auth.rootPassword=rootpassword","replicaCount=1","timeoutSeconds=20","periodSeconds=15","timeoutSeconds=20","periodSeconds=15","useStatefulSet=true"],"valueFiles":[]},"label":"labels","tolerations":"tolerations","affinity":"affinity","nodeSelector":"nodeSelector"}', now(), now(), null, 'MongoDB bitnami helm chart configuration default values.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('serviceDefaults', '{"dockerfilePath":"Dockerfile","cpuRequest":"10m","memoryRequest":"100Mi","readinessInitialDelaySeconds":0,"readinessPeriodSeconds":10,"readinessTimeoutSeconds":1,"readinessSuccessThreshold":1,"readinessFailureThreshold":30,"readinessTcpSocketPort":8090,"readinessHttpGetPort":8080,"readinessHttpGetPath":"/__lbheartbeat__","acmARN":"replace_me","scaleToZero":false,"scaleToZeroMetricsCheckInterval":1800,"grpc":false,"defaultIPWhiteList":"{ 0.0.0.0/0 }"}', now(), now(), null, 'Default configuration for services for values that are not set in the configuration file');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('domainDefaults', '{"http":"app.local","grpc":"app-grpc.local"}', now(), now(), null, 'Default domain hostnames for the lifecycle deployments');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('orgChart', '{"name":"replace_me"}', now(), now(), null, 'Default internal helm chart for the org.');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('auroraRestoreSettings', '{"vpcId":"","accountId":"","region":"us-west-2","securityGroupIds":[],"subnetGroupName":"","engine":"aurora-mysql","engineVersion":"8.0.mysql_aurora.3.06.0","tagMatch":{"key":"restore-for"},"instanceSize":"db.t3.medium","restoreSize":"db.t3.small"}', now(), now(), null, 'Default aurora database settings to use for restore');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('rdsRestoreSettings', '{"vpcId":"","accountId":"","region":"us-west-2","securityGroupIds":[],"subnetGroupName":"","engine":"mysql","engineVersion":"8.0.33","tagMatch":{"key":"restore-for"},"instanceSize":"db.t3.small","restoreSize":"db.t3.small"}', now(), now(), null, 'Default RDS database settings to use for restore');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('minio', '{"version":"3.7.2","args":"--force --timeout 60m0s --wait","action":"install","chart":{"name":"minio","repoUrl":"https://charts.bitnami.com/bitnami","version":"15.0.7","values":[],"valueFiles":[]},"label":"labels","tolerations":"tolerations","affinity":"affinity","nodeSelector":"nodeSelector"}', now(), now(), null, 'Default minio s3 compatible bucket');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('features', '{"namespace":true}', now(), now(), null, 'Configuration for feature flags controlled from database');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('serviceAccount', '{"name": "default","role":"replace_me"}', now(), now(), null, 'Default IAM role name to be used to annotate service account');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('app_setup', '{"state":"","created":false,"installed":false,"restarted":false,"org":"","url":"","name":""}', now(), now(), null, 'Application setup state');
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description) VALUES ('labels', '{"deploy":["lifecycle-deploy!"],"disabled":["lifecycle-disabled!"],"statusComments":["lifecycle-status-comments!"],"defaultStatusComments":true,"defaultControlComments":true}', now(), now(), null, 'Configurable PR labels for deploy, disabled, and status comments');
  `);

  await knex.schema.raw(`
    CREATE OR REPLACE VIEW "deploySummary" AS
    SELECT deployables.id AS "deployableID",
           deployables.name,
           deployables."buildId",
           deployables."buildUUID",
           deployables."branchName",
           deployables.type,
           deploys.active,
           deployables."serviceId",
           CASE
             WHEN (deployables."serviceId" IN (
               SELECT eo."serviceId" FROM "environmentDefaultServices" eo
               WHERE eo."environmentId" = builds."environmentId"
             )) THEN true ELSE false END AS defaultenv,
           deploys.status,
           deploys."publicUrl",
           deployables.public,
           deployables."hostPortMapping",
           environments."enableFullYaml",
           deployables.grpc,
           deployables."capacityType"
    FROM deployables
    JOIN deploys ON deployables.id = deploys."deployableId"
    FULL JOIN environments ON deployables."environmentId" = environments.id
    JOIN builds ON deployables."buildUUID"::text = builds.uuid::text;
    ALTER VIEW "deploySummary" OWNER TO lifecycle;
  `);
}

export async function down(knex: Knex): Promise<any> {
  await knex.schema.raw('DROP VIEW IF EXISTS "deploySummary";');

  await knex.schema.raw('DROP TABLE IF EXISTS deploys CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS webhook_invocations CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS deployables CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS build_service_overrides CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS configurations CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS "environmentOptionalServices" CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS "environmentDefaultServices" CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS services_disks CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS services CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS builds CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS pull_requests CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS repositories CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS environments CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS "botUsers" CASCADE;');
  await knex.schema.raw('DROP TABLE IF EXISTS global_config CASCADE;');

  await knex.schema.raw('DROP SEQUENCE IF EXISTS deploys_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS build_service_overrides_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS "environmentOptionalServices_id_seq";');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS services_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS builds_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS pr_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS repositories_id_seq;');
  await knex.schema.raw('DROP SEQUENCE IF EXISTS environments_id_seq;');
}
