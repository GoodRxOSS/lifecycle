import Service from './_service';
import { Queue, Job } from 'bullmq';
import { QUEUE_NAMES } from 'shared/config';
import { redisClient } from 'server/lib/dependencies';
import rootLogger from 'server/lib/logger';
import { waitForColumnValue } from 'shared/utils';
import { updatePullRequestLabels } from 'server/lib/github';
import { getDeployLabel } from 'server/lib/utils';

const logger = rootLogger.child({
  filename: 'services/label.ts',
});

interface LabelJob {
  pullRequestId: number;
  action: 'enable' | 'disable';
  waitForComment: boolean;
  labels: string[];
}

export default class LabelService extends Service {
  /**
   * Queue for managing PR label operations
   */
  labelQueue: Queue<LabelJob> = this.queueManager.registerQueue(QUEUE_NAMES.LABEL, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  /**
   * Process label queue jobs
   */
  processLabelQueue = async (job: Job<LabelJob>) => {
    const { pullRequestId, action, waitForComment, labels: currentLabels } = job.data;

    try {
      const pullRequest = await this.db.models.PullRequest.query()
        .findById(pullRequestId)
        .withGraphFetched('[repository, build]');

      if (!pullRequest) {
        throw new Error(`[BUILD unknown] Pull request with id ${pullRequestId} not found`);
      }

      const { repository, build } = pullRequest;
      const buildUuid = build?.uuid || 'unknown';
      if (!repository) {
        throw new Error(`[BUILD ${buildUuid}] Repository not found for pull request ${pullRequestId}`);
      }

      if (waitForComment && !pullRequest.commentId) {
        logger.debug(`[BUILD ${buildUuid}] Waiting for comment_id to be set before updating labels`);
        // 60 attempts * 5 seconds = 5 minutes
        const updatedPullRequest = await waitForColumnValue(pullRequest, 'commentId', 60, 5000);

        if (!updatedPullRequest) {
          logger.warn(`[BUILD ${buildUuid}] Timeout waiting for comment_id while updating labels after 5 minutes`);
        }
      }

      let updatedLabels: string[];

      const deployLabel = await getDeployLabel();
      if (action === 'enable') {
        if (!currentLabels.includes(deployLabel)) {
          updatedLabels = [...currentLabels, deployLabel];
        } else {
          logger.debug(`[BUILD ${buildUuid}] Deploy label "${deployLabel}" already exists on PR, skipping update`);
          return;
        }
      } else {
        const labelsConfig = await this.db.services.GlobalConfig.getLabels();
        const deployLabels = labelsConfig.deploy || [];
        updatedLabels = currentLabels.filter((label) => !deployLabels.includes(label));
      }

      await updatePullRequestLabels({
        installationId: repository.githubInstallationId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        fullName: pullRequest.fullName,
        labels: updatedLabels,
      });

      logger.info(
        `[BUILD ${buildUuid}] Successfully ${action === 'enable' ? 'added' : 'removed'} ${deployLabel} label`
      );
    } catch (error) {
      logger.error({ error }, `[PR ${pullRequestId}] Failed to process label job`);
      throw error;
    }
  };
}
