// hashUtils.ts - SHA-256 file hashing and integrity verification
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

/**
 * Compute SHA-256 hash of file contents
 */
export async function sha256File(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  } catch (error) {
    throw new Error(`Failed to hash file ${filePath}: ${error}`);
  }
}

/**
 * Compute SHA-256 hash of string content
 */
export function sha256String(content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Verify file integrity against expected hash
 */
export async function verifyFileIntegrity(
  filePath: string,
  expectedHash: string
): Promise<boolean> {
  const actualHash = await sha256File(filePath);
  return actualHash === expectedHash;
}
