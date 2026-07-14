/**
 * codegen/index.ts - Export all codegen types and functions
 */

export {
  generateApiClient,
  generateComponent,
  generateModule,
  generateHook,
  validateTypeScript,
  getCodegenStatus,
  type GenerateApiClientParams,
  type GenerateApiClientResult,
  type GenerateComponentParams,
  type GenerateComponentResult,
  type GenerateModuleParams,
  type GenerateModuleResult,
  type GenerateHookParams,
  type GenerateHookResult,
  type PropertyDefinition,
  type EndpointDefinition,
} from './codegenEngine';

// Frontend Verification Tools (MSG-NEXUS-002)
export {
  checkApiClientStatus,
  verifyFrontendBuild,
  analyzeBundleSize,
  type CheckApiClientStatusParams,
  type CheckApiClientStatusResult,
  type VerifyFrontendBuildParams,
  type VerifyFrontendBuildResult,
  type AnalyzeBundleSizeParams,
  type AnalyzeBundleSizeResult,
} from './frontendVerify';

// Pattern-Based Scaffolding (MSG-NEXUS-002)
export {
  scaffoldFromPattern,
  listAvailablePatterns,
  type ScaffoldFromPatternParams,
  type ScaffoldFromPatternResult,
} from './patternScaffold';
