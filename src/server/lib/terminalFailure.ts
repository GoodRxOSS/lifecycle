import { DeployStatus } from 'shared/constants';

const MAX_STATUS_MESSAGE_LENGTH = 1000;

/** Cuts by code point so a surrogate pair is never split into text that JSON storage rejects. */
export function compactStatusMessage(message: string, maxLength = MAX_STATUS_MESSAGE_LENGTH): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  const points = Array.from(compact);
  return points.length > maxLength ? `${points.slice(0, maxLength - 3).join('')}...` : compact;
}

export function statusMessageFromError(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message) {
    return compactStatusMessage(error.message);
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return compactStatusMessage(error);
  }

  return compactStatusMessage(fallbackMessage);
}

export function fallbackDeployStatusMessage(status: DeployStatus): string {
  switch (status) {
    case DeployStatus.BUILD_FAILED:
      return 'Build failed. Check build logs for details.';
    case DeployStatus.DEPLOY_FAILED:
      return 'Deployment failed. Check deploy logs for details.';
    case DeployStatus.ERROR:
      return 'Deploy failed unexpectedly.';
    default:
      return '';
  }
}
