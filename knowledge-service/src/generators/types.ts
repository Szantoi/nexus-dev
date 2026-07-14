/**
 * Shared types for generators (Track B)
 */

export interface GeneratedFile {
  path: string;
  content: string;
  mode?: 'create' | 'append' | 'overwrite';
}

export interface Property {
  name: string;
  type: string;
  nullable?: boolean;
  description?: string;
}

export interface GenerateResult {
  success: boolean;
  filesCreated: string[];
  filesSkipped: string[];
  errors: string[];
}
