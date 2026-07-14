/**
 * Trajectory Comparison (agent-eval suite).
 *
 * WHY: TrajectoryAccuracy (per the agent-testing research) scores an agent's
 * ACTUAL step sequence against a golden reference. Deterministic, explainable
 * scoring — not an LLM judging an LLM: we use edit distance over the lifecycle
 * step sequences and enumerate every deviation, so a low score always comes with
 * the concrete reason (missing / extra / substituted step).
 */

export interface TrajectoryDeviation {
  kind: 'missing' | 'extra' | 'substituted';
  index: number;        // position in the golden (missing/substituted) or actual (extra) sequence
  expected?: string;    // the golden step (for missing/substituted)
  actual?: string;      // the actual step (for extra/substituted)
}

export interface TrajectoryScore {
  score: number;                    // 0.0 – 1.0 (1 = exact match)
  distance: number;                 // raw edit distance
  golden: string[];
  actual: string[];
  deviations: TrajectoryDeviation[];
}

/**
 * Levenshtein distance with backtrace so we can name each deviation.
 * Sequences are short (lifecycle steps), so O(n*m) is more than fine.
 */
export function compareTrajectory(actual: string[], golden: string[]): TrajectoryScore {
  const n = golden.length, m = actual.length;
  // dp[i][j] = edit distance between golden[0..i) and actual[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = golden[i - 1] === actual[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + sub);
    }
  }

  // Backtrace to enumerate deviations (explainability, not just a number).
  const deviations: TrajectoryDeviation[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && golden[i - 1] === actual[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      deviations.push({ kind: 'substituted', index: i - 1, expected: golden[i - 1], actual: actual[j - 1] });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deviations.push({ kind: 'missing', index: i - 1, expected: golden[i - 1] });
      i--;
    } else {
      deviations.push({ kind: 'extra', index: j - 1, actual: actual[j - 1] });
      j--;
    }
  }
  deviations.reverse();

  const maxLen = Math.max(n, m, 1);
  const distance = dp[n][m];
  return {
    score: Math.round((1 - distance / maxLen) * 1000) / 1000,
    distance,
    golden,
    actual,
    deviations,
  };
}
