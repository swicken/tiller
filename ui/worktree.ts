import { finished, type NodeView } from '../src/shared/protocol';

/** A worktree node with commits or files its base does not have yet, once its work has stopped: someone should merge or close it. */
export const hasChanges = (node: NodeView): boolean => {
  const g = node.status.git;
  return !!g && !g.mergedAt && g.ahead + g.dirty > 0 && finished(node.status);
};

/** A worktree node whose branch has commits for its base, with no uncommitted files and no turn running: what the daemon's merge accepts. */
export const canMerge = (node: NodeView): boolean => {
  const g = node.status.git;
  return !!g?.branch && !g.mergedAt && g.ahead > 0 && g.dirty === 0 && (!!node.status.exited || node.status.state !== 'working');
};
