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

import { Command } from 'commander';
import RDS, { TagList } from 'aws-sdk/clients/rds';
import pino from 'pino';
import pinoCaller from 'pino-caller';

export const enabled = process.env.PINO_LOGGER === 'false' ? false : true;
export const LIFECYCLE_ENV = process.env.ENVIRONMENT || 'production';
export const level = 'info';

const initLogger = pino({
  level,
  enabled,
});

const loggerCaller = pinoCaller(initLogger);
const logger = loggerCaller.child({
  filename: 'scripts/aurora-helper.ts',
});

const program = new Command();

/**
 * Clones a source RDS cluster. It uses the source tag information to find the host cluster,
 * and then creates a new cluster, which is tagged, based on the stack information (buildUUID, stack Name, service name)
 */
program
  .command('deploy')
  .option('-b, --buildUUID <string>', 'The Build UUID')
  .option('-s, --stackName <string>', 'The Stack Name')
  .option('-sn, --serviceName <string>', 'The Service Name')
  .option('-sk, --sourceTagKey <string>', 'The Source Tag Key')
  .option('-sv, --sourceTagValue <string>', 'The Source Tag Value')
  .option('-as, --appShort <string>', 'The app short for the application. Used for cost attribution purposes')
  .option('-ev, --engineVersion <string>', 'The RDS engine version')
  .option('-ev, --engineVersion <string>', 'The RDS engine version')
  .option('-set, --settings <string>', 'Settings or Configuration to use for database')
  .allowUnknownOption()
  .action(clone);

program
  .command('destroy')
  .option('-b, --buildUUID <string>', 'The Build UUID')
  .option('-s, --stackName <string>', 'The Stack Name')
  .option('-sn, --serviceName <string>', 'The Service Name')
  .allowUnknownOption()
  .action(destroy);

program.parseAsync(process.argv);

interface Stack {
  stackName: string;
  buildUUID: string;
  serviceName: string;
  sourceDB?: string;
  appShort?: string;
  engineVersion?: string;
  settings?: Record<string, any>;
}

/**
 * Returns the newest source cluster from which to clone from
 * @param identifier matches database snapshots that include the given string
 */
async function getMostRecentAurora(sourceTagKey: string, sourceTagValue: string): Promise<RDS.DBCluster> {
  try {
    const rdsClient = new RDS();
    const clusterList = await rdsClient.describeDBClusters().promise();
    const potentialSourceClusters =
      clusterList.DBClusters?.filter((cluster) => {
        const tags =
          cluster.TagList?.filter((tag) => {
            return tag.Key === sourceTagKey && tag.Value === sourceTagValue;
          }) || [];
        return tags.length > 0;
      }) || [];
    return potentialSourceClusters?.reduce((prev, current) => {
      const minDate = new Date(-8640000000000000);
      return (prev.ClusterCreateTime ?? minDate) > (current.ClusterCreateTime ?? minDate) ? prev : current;
    }, {});
  } catch (error) {
    logger.child({ error, sourceTagKey, sourceTagValue }).error('[aurora][getMostRecentAurora] Error');
    return {};
  }
}

/**
 * Creates the TagList for the stack
 * @param stack
 */
function getTagsForStack(stack: Stack): TagList {
  return [
    {
      Key: 'BuildUUID',
      Value: stack.buildUUID,
    },
    {
      Key: 'StackName',
      Value: stack.stackName,
    },
    {
      Key: 'ServiceName',
      Value: stack.serviceName,
    },
    {
      Key: 'SourceDatabase',
      Value: stack.sourceDB,
    },
    {
      Key: 'app-short',
      Value: stack.appShort,
    },
  ];
}

/**
 * Returns an Aurora cluster that is tagged, based on the provided stack
 * @param stack
 */
async function getClusterForStack(stack: Stack) {
  try {
    const rdsClient = new RDS();
    const clusters = (await rdsClient.describeDBClusters().promise()).DBClusters;
    logger.child({ clusters }).info('[aurora][getClusterForStack] Clusters');
    return clusters.find((c) => {
      logger.child({ tagList: c.TagList }).info('[getClusterForStack] TagList');
      const buildTag = c.TagList.find((t) => t.Key === 'BuildUUID' && t.Value === stack.buildUUID);
      const serviceTag = c.TagList.find((t) => t.Key === 'ServiceName' && t.Value === stack.serviceName);
      return buildTag !== undefined && buildTag !== null && serviceTag !== undefined && serviceTag !== null;
    });
  } catch (error) {
    // Couldn't find pre-existing cluster
    logger.child({ error }).error('[aurora][getClusterForStack] Error pulling cluster');
    return null;
  }
}

/**
 * Retrieves all of the instances for an aurora cluster
 * @param cluster the cluster to retrieve the instances from
 */
async function instancesForCluster(cluster: RDS.DBCluster): Promise<RDS.DBInstanceList> {
  try {
    const rdsClient = new RDS();
    const result = await rdsClient
      .describeDBInstances({
        Filters: [
          {
            Name: 'db-cluster-id',
            Values: [cluster.DBClusterIdentifier],
          },
        ],
      })
      .promise();
    return result.DBInstances;
  } catch (error) {
    logger.child({ cluster, error }).error('[aurora][instancesForCluster] Error retrieving instances');
    return [];
  }
}

async function cloneAuroraInstance(sourceCluster: RDS.DBCluster, stack: Stack) {
  const text = '[aurora][cloneAuroraInstance]';
  const rdsClient = new RDS();
  const databaseIdentifier = `${stack.serviceName}-${stack.buildUUID}`;
  let cluster: RDS.DBCluster;
  const tags = getTagsForStack(stack);
  const settings = stack.settings;

  try {
    cluster = await getClusterForStack(stack);

    if (!cluster) {
      logger.child({ stack }).info(`${text} Creating new DB cluster with ID: ${databaseIdentifier}`);
      const result = await rdsClient
        .restoreDBClusterToPointInTime({
          SourceDBClusterIdentifier: sourceCluster.DBClusterIdentifier,
          DBClusterIdentifier: databaseIdentifier,
          DBSubnetGroupName: settings.subnetGroupName,
          VpcSecurityGroupIds: settings.securityGroupIds,
          UseLatestRestorableTime: true,
          RestoreType: 'copy-on-write',
          Tags: tags,
        })
        .promise();
      cluster = result.DBCluster;
    }
  } catch (error) {
    if (error.code === 'DBInstanceAlreadyExists') {
      logger.child({ error, stack }).warn(`${text} DB instance exists. Skipping`);
    } else {
      logger.child({ error, stack }).error(`${text} Error creating DB instance`);
      throw error;
    }
  }

  try {
    const instances = cluster ? await instancesForCluster(cluster) : [];
    if (instances?.length === 0) {
      const instance = await rdsClient
        .createDBInstance({
          DBClusterIdentifier: cluster.DBClusterIdentifier,
          DBInstanceClass: settings.instanceSize,
          DBInstanceIdentifier: databaseIdentifier,
          Engine: settings.engine,
          EngineVersion: stack.engineVersion || settings.engineVersion,
          Tags: tags,
        })
        .promise();
      await rdsClient
        .waitFor('dBInstanceAvailable', {
          DBInstanceIdentifier: instance.DBInstance.DBInstanceIdentifier,
          $waiter: {
            delay: 50,
            maxAttempts: 100,
          },
        })
        .promise();
      await rdsClient
        .modifyDBInstance({
          DBInstanceIdentifier: instance.DBInstance.DBInstanceIdentifier,
          CACertificateIdentifier: 'rds-ca-rsa2048-g1',
          ApplyImmediately: true,
        })
        .promise();
    } else {
      logger.info('This cluster already has an instance. There is nothing to be done.');
      await rdsClient
        .waitFor('dBInstanceAvailable', {
          DBInstanceIdentifier: instances[0].DBInstanceIdentifier,
          $waiter: {
            delay: 50,
            maxAttempts: 100,
          },
        })
        .promise();
    }
  } catch (error) {
    logger.child({ error, stack }).error(`${text} Error creating DB instance`);
    throw error;
  }
}

async function destroy(options) {
  try {
    const stackName = options.stackName;
    const buildUUID = options.buildUUID;
    const serviceName = options.serviceName;
    if (!stackName) throw new Error('A stack name must be defined.');
    if (!buildUUID) throw new Error('A build UUID must be defined.');
    if (!serviceName) throw new Error('A service name must be defined.');
    await destroyAuroraInstance({ stackName, buildUUID, serviceName });
  } catch (error) {
    logger.child({ error, options }).error('[aurora][destroy] Error destroying Aurora instance');
    throw error;
  }
}

async function destroyAuroraInstance(stack: Stack) {
  try {
    const cluster = await getClusterForStack(stack);
    if (cluster) {
      const rdsClient = new RDS();
      // Get all instances
      const instances = await instancesForCluster(cluster);
      logger.child({ buildUUID: stack?.buildUUID }).info(`[aurora][destroy] Found ${instances.length} to destroy...`);
      for (const instance of instances) {
        await rdsClient
          .deleteDBInstance({
            DBInstanceIdentifier: instance.DBInstanceIdentifier,
          })
          .promise();
        await rdsClient
          .removeTagsFromResource({
            ResourceName: instance.DBInstanceArn,
            TagKeys: ['StackName', 'BuildUUID', 'serviceName'],
          })
          .promise();
      }
      logger.child({ buildUUID: stack?.buildUUID }).info(`[aurora][destroy] Destroying the cluster...`);
      await rdsClient
        .deleteDBCluster({
          DBClusterIdentifier: cluster.DBClusterIdentifier,
          SkipFinalSnapshot: true,
        })
        .promise();
      await rdsClient
        .removeTagsFromResource({
          ResourceName: cluster.DBClusterArn,
          TagKeys: ['StackName', 'BuildUUID', 'serviceName'],
        })
        .promise();
    }
  } catch (error) {
    logger.child({ stack, error }).error('[aurora][destroy] Error destroying the cluster');
    throw error;
  }
}

async function clone(options) {
  try {
    const stackName = options.stackName;
    const buildUUID = options.buildUUID;
    const serviceName = options.serviceName;
    const sourceTagKey = options.sourceTagKey;
    const sourceTagValue = options.sourceTagValue;
    const appShort = options?.appShort;
    const settings = JSON.parse(options?.settings);
    if (!stackName) throw new Error('A stack name must be defined.');
    if (!buildUUID) throw new Error('A build UUID must be defined.');
    if (!serviceName) throw new Error('A service name must be defined.');
    if (!sourceTagKey) throw new Error('A source tag key must be defined.');
    if (!sourceTagValue) throw new Error('A source tag value must be defined.');
    if (!appShort) throw new Error('An appShort tag value must be defined.');
    if (!settings) throw new Error('Settings are needed to restore the database with');

    const sourceCluster = await getMostRecentAurora(sourceTagKey, sourceTagValue);
    if (!sourceCluster?.DBClusterIdentifier)
      throw new Error('Cluster does not have an identifier that can be used for restore');

    await cloneAuroraInstance(sourceCluster, {
      stackName,
      buildUUID,
      serviceName,
      sourceDB: sourceCluster.DBClusterIdentifier,
      appShort,
      engineVersion: options.engineVersion || settings.engineVersion,
      settings,
    });
    logger.child({ buildUUID }).info('[aurora][clone] buildUUID');
  } catch (error) {
    logger.child({ error, options }).error('[aurora][clone] Error cloning Aurora instance');
    throw error;
  }
}
