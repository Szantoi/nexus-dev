// reviewLog.ts - Immutable append-only review decision log
import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT } from './common';

export interface ReviewDecision {
  timestamp: string;
  review_id: string;
  inbox_file: string;
  inbox_hash: string;
  done_file: string;
  done_hash: string;
  task_type: string;
  review_attempt: number;
  reviewer_a: {
    model: string;
    verdict: 'APPROVE' | 'REJECT' | 'ERROR' | 'UNKNOWN';
    feedback_hash: string;
  };
  reviewer_b: {
    model: string;
    verdict: 'APPROVE' | 'REJECT' | 'ERROR' | 'UNKNOWN';
    feedback_hash: string;
  };
  final_verdict: 'APPROVED' | 'REJECTED' | 'ERROR';
  reject_inbox_created?: string;
  escalated?: boolean;
  escalation_msg?: string;
  git_commit?: string;
}

const REVIEW_LOG_PATH = path.join(SPACEOS_ROOT, 'logs/reviews/decisions.jsonl');

/**
 * Append review decision to immutable log (JSONL format)
 */
export async function appendReviewDecision(decision: ReviewDecision): Promise<void> {
  const logDir = path.dirname(REVIEW_LOG_PATH);
  await fs.mkdir(logDir, { recursive: true });

  const line = JSON.stringify(decision) + '\n';
  await fs.appendFile(REVIEW_LOG_PATH, line, 'utf-8');
}

/**
 * Query review log for previous attempts on same inbox
 */
export async function queryReviewLog(query: {
  inbox_hash?: string;
  done_hash?: string;
  review_id?: string;
}): Promise<ReviewDecision[]> {
  try {
    const content = await fs.readFile(REVIEW_LOG_PATH, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);

    const decisions: ReviewDecision[] = lines.map(line => JSON.parse(line));

    return decisions.filter(d => {
      if (query.inbox_hash && d.inbox_hash !== query.inbox_hash) return false;
      if (query.done_hash && d.done_hash !== query.done_hash) return false;
      if (query.review_id && d.review_id !== query.review_id) return false;
      return true;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Log file doesn't exist yet
      return [];
    }
    throw error;
  }
}

/**
 * Generate unique review ID
 */
export function generateReviewId(): string {
  const date = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `REV-${date}-${timestamp}-${random}`;
}

/**
 * Get review attempt count for inbox
 */
export async function getReviewAttemptCount(inboxHash: string): Promise<number> {
  const previousReviews = await queryReviewLog({ inbox_hash: inboxHash });
  return previousReviews.length;
}
