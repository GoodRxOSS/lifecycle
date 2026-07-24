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
  filename: 'scripts/rds-helper.ts',
});

const program = new Command();

/**
 * Clones a source RDS instance. It uses the source tag information to find the host instance,
 * and then creates a new instance, which is tagged, based on the stack information (buildUUID, stack Name, service name)
 */
program
  .command('deploy')
  .option('-b, --buildUUID <string>', 'The Build UUID')
  .option('-s, --stackName <string>', 'The Stack Name')
  .option('-sn, --serviceName <string>', 'The Service Name')
  .option('-sk, --sourceTagKey <string>', 'The Source Tag Key')
  .option('-sv, --sourceTagValue <string>', 'The Source Tag Value')
  .option('-as, --appShort <string>', 'The app short for the application. Used for cost attribution purposes')
  .option('-set, --settings <string>', 'Database configuration settings')
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
  settings?: Record<string, any>;
}

/**
 * Returns the newest source instance from which to clone from
 * @param identifier matches database snapshots that include the given string
 */

async function getMostRecentRds(sourceTagKey: string, sourceTagValue: string): Promise<RDS.DBInstance> {
  const rdsClient = new RDS();
  const instanceList = await rdsClient.describeDBInstances().promise();
  const potentialSourceInstance =
    instanceList.DBInstances?.filter((instance) => {
      const tags =
        instance.TagList?.filter((tag) => {
          return tag.Key === sourceTagKey && tag.Value === sourceTagValue;
        }) || [];
      return tags.length > 0;
    }) || [];
  return potentialSourceInstance?.reduce((prev, current) => {
    const minDate = new Date(-8640000000000000);
    return (prev.InstanceCreateTime ?? minDate) > (current.InstanceCreateTime ?? minDate) ? prev : current;
  }, {});
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
 * Returns an RDS instance that is tagged, based on the provided stack
 * @param stack
 */

async function getInstancesForStack(stack: Stack) {
  const rdsClient = new RDS();
  let filteredInstances: RDS.DBInstance;
  try {
    const instances = (await rdsClient.describeDBInstances().promise()).DBInstances;
    filteredInstances = instances.find((c) => {
      const buildTag = c.TagList.find((t) => t.Key === 'BuildUUID' && t.Value === stack.buildUUID);
      const serviceTag = c.TagList.find((t) => t.Key === 'ServiceName' && t.Value === stack.serviceName);
      return buildTag !== undefined && buildTag !== null && serviceTag !== undefined && serviceTag !== null;
    });
  } catch (error) {
    // Couldn't find pre-existing instance
    logger.child({ error }).error('Error pulling instance');
    filteredInstances = null;
  }
  return filteredInstances;
}

/**
 * Performs a pointInTime restore using the potentialSourceInstance
 * @param sourceInstance
 */
async function cloneRdsInstance(sourceInstance: RDS.DBInstance, stack: Stack) {
  const rdsClient = new RDS();
  let instance: RDS.DBInstance;
  const tags = getTagsForStack(stack);
  const settings = stack.settings;
  instance = await getInstancesForStack(stack);

  if (!instance) {
    const result = await rdsClient
      .restoreDBInstanceToPointInTime({
        SourceDBInstanceIdentifier: sourceInstance.DBInstanceIdentifier,
        TargetDBInstanceIdentifier: `${stack.serviceName}-${stack.buildUUID}`,
        DBSubnetGroupName: settings.subnetGroupName,
        StorageType: 'gp3',
        VpcSecurityGroupIds: settings.securityGroupIds,
        DBInstanceClass: settings.instanceSize,
        UseLatestRestorableTime: true,
        Tags: tags,
        AutoMinorVersionUpgrade: false,
      })
      .promise();
    instance = result.DBInstance;
    await rdsClient
      .waitFor('dBInstanceAvailable', {
        DBInstanceIdentifier: instance.DBInstanceIdentifier,
        $waiter: {
          delay: 30,
          maxAttempts: 60,
        },
      })
      .promise();
    await rdsClient
      .modifyDBInstance({
        DBInstanceIdentifier: instance.DBInstanceIdentifier,
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
        ApplyImmediately: true,
        BackupRetentionPeriod: 0,
      })
      .promise();
  } else {
    logger.child({ stack }).info(`This db instance already exists for stack. There is nothing to be done.`);
    await rdsClient
      .waitFor('dBInstanceAvailable', {
        DBInstanceIdentifier: instance.DBInstanceIdentifier,
        $waiter: {
          delay: 30,
          maxAttempts: 60,
        },
      })
      .promise();
  }
}

async function destroy(options) {
  const stackName = options.stackName;
  const buildUUID = options.buildUUID;
  const serviceName = options.serviceName;
  if (!stackName) throw new Error('A stack name must be defined.');
  if (!buildUUID) throw new Error('A build UUID must be defined.');
  if (!serviceName) throw new Error('A service name must be defined.');
  await destroyRdsInstance({ stackName, buildUUID, serviceName });
}

async function destroyRdsInstance(stack: Stack) {
  const instance = await getInstancesForStack(stack);
  if (instance) {
    logger.info(`Found ${instance.DBInstanceIdentifier} to destroy...`);
    const rdsClient = new RDS();
    await rdsClient
      .deleteDBInstance({
        DBInstanceIdentifier: instance.DBInstanceIdentifier,
        SkipFinalSnapshot: true,
      })
      .promise();
    await rdsClient
      .removeTagsFromResource({
        ResourceName: instance.DBInstanceArn,
        TagKeys: ['StackName', 'BuildUUID', 'serviceName'],
      })
      .promise();
    logger.info(`Destroying the instance...`);
    await rdsClient
      .removeTagsFromResource({
        ResourceName: instance.DBInstanceArn,
        TagKeys: ['StackName', 'BuildUUID', 'serviceName'],
      })
      .promise();
  }
  logger.child({ stack }).info(`No instance found found for stack to destroy`);
}

async function clone(options) {
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
  if (!settings) throw new Error('Database configuration for restore must be defined.');

  const sourceInstance = await getMostRecentRds(sourceTagKey, sourceTagValue);
  if (!sourceInstance?.DBInstanceIdentifier) {
    throw new Error('Instance does not have an identifier that can be used for restore');
  }

  await cloneRdsInstance(sourceInstance, {
    stackName,
    buildUUID,
    serviceName,
    sourceDB: sourceInstance.DBInstanceIdentifier,
    appShort,
    settings,
  });
}
