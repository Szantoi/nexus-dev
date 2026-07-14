/**
 * skillFactory.ts - Automated terminal skill generation
 *
 * MCP Phase 2: Create skills from workflow patterns
 * MSG-NEXUS-005
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  location?: 'user' | 'system';
}

export interface CreateSkillParams {
  terminal?: string;          // Optional: specific terminal (e.g., 'backend', 'frontend')
  name: string;               // Skill name (kebab-case)
  trigger_patterns?: string[]; // Trigger patterns (e.g., ["git conflict", "merge issue"])
  template: string;           // Skill content (markdown)
  description?: string;       // Short description
}

export interface SkillCreationResult {
  success: boolean;
  skill_path?: string;
  skill_name?: string;
  error?: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const getSpaceOSRoot = () => process.env.SPACEOS_ROOT || '/opt/spaceos';
const getSkillsPath = () => path.join(getSpaceOSRoot(), '.claude/skills');

// ─── Skill Name Validation ───────────────────────────────────────────────────

/**
 * Validate and normalize skill name
 * - Must be kebab-case
 * - Only alphanumeric and hyphens
 * - No leading/trailing hyphens
 */
function validateSkillName(name: string): { valid: boolean; normalized: string; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, normalized: '', error: 'Skill name cannot be empty' };
  }

  // Normalize: trim, lowercase, replace spaces/underscores with hyphens
  let normalized = name.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  // Remove leading/trailing hyphens
  normalized = normalized.replace(/^-+|-+$/g, '');

  if (normalized.length === 0) {
    return { valid: false, normalized: '', error: 'Skill name contains no valid characters' };
  }

  if (normalized.length > 50) {
    return { valid: false, normalized: '', error: 'Skill name too long (max 50 chars)' };
  }

  return { valid: true, normalized };
}

// ─── Skill Template Generation ───────────────────────────────────────────────

/**
 * Generate SKILL.md frontmatter
 */
function generateFrontmatter(params: CreateSkillParams): string {
  const metadata: SkillMetadata = {
    name: params.name,
    description: params.description || `Skill: ${params.name}`,
    location: 'user',
  };

  if (params.trigger_patterns && params.trigger_patterns.length > 0) {
    metadata.triggers = params.trigger_patterns;
  }

  const frontmatter = yaml.dump(metadata, { lineWidth: -1 });
  return `---\n${frontmatter}---\n`;
}

/**
 * Generate full SKILL.md content
 */
function generateSkillContent(params: CreateSkillParams): string {
  const frontmatter = generateFrontmatter(params);
  const content = params.template.trim();

  return `${frontmatter}\n${content}\n`;
}

// ─── Skill Creation ──────────────────────────────────────────────────────────

/**
 * Create a new skill in .claude/skills/
 *
 * @param params Skill creation parameters
 * @returns Success status and skill path
 */
export async function createSkill(params: CreateSkillParams): Promise<SkillCreationResult> {
  try {
    // Validate skill name
    const validation = validateSkillName(params.name);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || 'Invalid skill name',
      };
    }

    const skillName = validation.normalized;
    const skillsPath = getSkillsPath();
    const skillDir = path.join(skillsPath, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');

    // Check if skill already exists
    try {
      await fs.access(skillFile);
      return {
        success: false,
        error: `Skill already exists: ${skillName}`,
      };
    } catch {
      // Skill doesn't exist, continue
    }

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Generate and write SKILL.md
    const skillContent = generateSkillContent({
      ...params,
      name: skillName,
    });

    await fs.writeFile(skillFile, skillContent, 'utf-8');

    console.log(`[SkillFactory] ✓ Created skill: ${skillName}`);

    return {
      success: true,
      skill_path: skillFile,
      skill_name: skillName,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SkillFactory] Error creating skill:`, error);
    return {
      success: false,
      error: `Failed to create skill: ${msg}`,
    };
  }
}

// ─── Skill Registry Management ───────────────────────────────────────────────

/**
 * List all installed skills
 */
export async function listSkills(): Promise<string[]> {
  try {
    const skillsPath = getSkillsPath();
    const dirs = await fs.readdir(skillsPath, { withFileTypes: true });

    const skills: string[] = [];
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const skillFile = path.join(skillsPath, dir.name, 'SKILL.md');
        try {
          await fs.access(skillFile);
          skills.push(dir.name);
        } catch {
          // Directory exists but no SKILL.md - skip
        }
      }
    }

    return skills.sort();
  } catch (error) {
    console.error(`[SkillFactory] Error listing skills:`, error);
    return [];
  }
}

/**
 * Get skill metadata
 */
export async function getSkillMetadata(skillName: string): Promise<SkillMetadata | null> {
  try {
    const skillsPath = getSkillsPath();
    const skillFile = path.join(skillsPath, skillName, 'SKILL.md');

    const content = await fs.readFile(skillFile, 'utf-8');

    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const metadata = yaml.load(frontmatterMatch[1]) as SkillMetadata;
    return metadata;
  } catch (error) {
    console.error(`[SkillFactory] Error reading skill metadata:`, error);
    return null;
  }
}

/**
 * Delete a skill
 */
export async function deleteSkill(skillName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const skillsPath = getSkillsPath();
    const skillDir = path.join(skillsPath, skillName);

    // Verify skill exists
    try {
      await fs.access(path.join(skillDir, 'SKILL.md'));
    } catch {
      return {
        success: false,
        error: `Skill not found: ${skillName}`,
      };
    }

    // Delete skill directory
    await fs.rm(skillDir, { recursive: true, force: true });

    console.log(`[SkillFactory] ✓ Deleted skill: ${skillName}`);

    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SkillFactory] Error deleting skill:`, error);
    return {
      success: false,
      error: `Failed to delete skill: ${msg}`,
    };
  }
}
