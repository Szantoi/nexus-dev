/**
 * API Endpoint Scaffolder (Track B)
 *
 * Generates API endpoint with:
 * - Command
 * - Command Handler
 * - Validator
 * - Endpoint registration (APPEND mode)
 * - Test skeleton
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { toPascalCase, toCamelCase } from './utils/casing';
import { GeneratedFile, Property } from './types';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const BACKEND_DIR = process.env.BACKEND_DIR || `${SPACEOS_ROOT}/backend`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GenerateEndpointParams {
  module: string;           // spaceos-modules-procurement
  aggregate: string;        // SupplierComplaint
  action: string;           // submit, resolve, approve
  http: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  route: string;            // /api/complaints/{id}/submit
  requestBody?: Property[];
  responseType?: string;
}



export interface GenerateEndpointResult {
  success: boolean;
  filesCreated: string[];
  filesAppended: string[];
  filesSkipped: string[];
  errors: string[];
}

// ─── Main Generator Function ────────────────────────────────────────────────

/**
 * Generate API endpoint with command, handler, validator, and tests
 */
export async function generateEndpoint(params: GenerateEndpointParams): Promise<GenerateEndpointResult> {
  const files: GeneratedFile[] = [];
  const { module, aggregate, action, http, route, requestBody, responseType } = params;

  const modulePath = `${BACKEND_DIR}/${module}`;
  const pascalAggregate = toPascalCase(aggregate);
  const pascalAction = toPascalCase(action);

  console.log(`[GenerateEndpoint] Generating endpoint: ${http} ${route}`);

  // 1. Generate Command
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}Command.cs`,
    content: generateCommand(pascalAggregate, action, requestBody, responseType),
    mode: 'create',
  });

  // 2. Generate Command Handler
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}CommandHandler.cs`,
    content: generateCommandHandler(pascalAggregate, action, responseType),
    mode: 'create',
  });

  // 3. Generate Validator
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}Validator.cs`,
    content: generateValidator(pascalAggregate, action, requestBody),
    mode: 'create',
  });

  // 4. Append to Endpoints file
  const endpointSnippet = generateEndpointRegistration(pascalAggregate, action, http, route, requestBody);
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Api/Endpoints/${pascalAggregate}Endpoints.cs`,
    content: endpointSnippet,
    mode: 'append',
  });

  // 5. Generate Test
  files.push({
    path: `${modulePath}/tests/${pascalAggregate}.Tests/Api/${pascalAction}${pascalAggregate}Tests.cs`,
    content: generateEndpointTest(pascalAggregate, action, http, route),
    mode: 'create',
  });

  // Write all files
  const filesCreated: string[] = [];
  const filesAppended: string[] = [];
  const filesSkipped: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const result = await writeGeneratedFile(file);
      if (result.status === 'created') {
        filesCreated.push(file.path);
      } else if (result.status === 'appended') {
        filesAppended.push(file.path);
      } else if (result.status === 'skipped') {
        filesSkipped.push(file.path);
      }
    } catch (error) {
      errors.push(`${file.path}: ${error}`);
      console.error(`[GenerateEndpoint] Error writing ${file.path}:`, error);
    }
  }

  console.log(`[GenerateEndpoint] Created ${filesCreated.length}, appended ${filesAppended.length}, skipped ${filesSkipped.length}`);

  return {
    success: errors.length === 0,
    filesCreated,
    filesAppended,
    filesSkipped,
    errors,
  };
}

// ─── Template Generators ────────────────────────────────────────────────────

function generateCommand(
  aggregate: string,
  action: string,
  requestBody?: Property[],
  responseType?: string
): string {
  const pascalAction = toPascalCase(action);
  const returnType = responseType || 'Result';

  const propsCode = requestBody
    ? requestBody.map(p => `    public ${p.type}${p.nullable ? '?' : ''} ${p.name} { get; init; }${p.description ? ` // ${p.description}` : ''}`).join('\n')
    : '    // TODO: Add command properties';

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${aggregate};

using MediatR;
using Ardalis.Result;

/// <summary>
/// Command to ${action} ${aggregate}
/// </summary>
public record ${pascalAction}${aggregate}Command : IRequest<${returnType}>
{
    public Guid TenantId { get; init; }
${propsCode}
}
`;
}

function generateCommandHandler(
  aggregate: string,
  action: string,
  responseType?: string
): string {
  const pascalAction = toPascalCase(action);
  const returnType = responseType || 'Result';

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${aggregate};

using MediatR;
using Ardalis.Result;
using SpaceOS.Modules.Procurement.Domain.Interfaces;

/// <summary>
/// Handler for ${pascalAction}${aggregate}Command
/// </summary>
public class ${pascalAction}${aggregate}CommandHandler : IRequestHandler<${pascalAction}${aggregate}Command, ${returnType}>
{
    private readonly I${aggregate}Repository _repository;

    public ${pascalAction}${aggregate}CommandHandler(I${aggregate}Repository repository)
    {
        _repository = repository;
    }

    public async Task<${returnType}> Handle(${pascalAction}${aggregate}Command request, CancellationToken ct)
    {
        // TODO: Implement ${action} logic

        // 1. Load aggregate
        // 2. Execute domain method
        // 3. Save changes

        throw new NotImplementedException("${pascalAction}${aggregate}CommandHandler not implemented");
    }
}
`;
}

function generateValidator(
  aggregate: string,
  action: string,
  requestBody?: Property[]
): string {
  const pascalAction = toPascalCase(action);

  const validationRules = requestBody
    ? requestBody
      .filter(p => !p.nullable)
      .map(p => `        RuleFor(x => x.${p.name}).NotEmpty();`)
      .join('\n')
    : '        // TODO: Add validation rules';

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${aggregate};

using FluentValidation;

/// <summary>
/// Validator for ${pascalAction}${aggregate}Command
/// </summary>
public class ${pascalAction}${aggregate}Validator : AbstractValidator<${pascalAction}${aggregate}Command>
{
    public ${pascalAction}${aggregate}Validator()
    {
        RuleFor(x => x.TenantId).NotEmpty();
${validationRules}
    }
}
`;
}

function generateEndpointRegistration(
  aggregate: string,
  action: string,
  http: string,
  route: string,
  requestBody?: Property[]
): string {
  const pascalAction = toPascalCase(action);
  const camelAction = toCamelCase(action);

  const requestBodyType = requestBody && requestBody.length > 0
    ? `${pascalAction}${aggregate}Request`
    : 'EmptyRequest';

  return `
        // ${http} ${route}
        app.Map${http.charAt(0) + http.slice(1).toLowerCase()}("${route}", async (
            [FromServices] IMediator mediator,
            [FromRoute] Guid id,
            ${requestBodyType !== 'EmptyRequest' ? `[FromBody] ${requestBodyType} request,` : ''}
            CancellationToken ct) =>
        {
            var command = new ${pascalAction}${aggregate}Command
            {
                TenantId = GetTenantId(), // TODO: Implement GetTenantId()
                // TODO: Map request to command
            };

            var result = await mediator.Send(command, ct);

            return result.IsSuccess
                ? Results.Ok(result.Value)
                : Results.BadRequest(result.Errors);
        })
        .WithName("${pascalAction}${aggregate}")
        .WithTags("${aggregate}")
        .RequireAuthorization();
`;
}

function generateEndpointTest(
  aggregate: string,
  action: string,
  http: string,
  route: string
): string {
  const pascalAction = toPascalCase(action);

  return `namespace SpaceOS.Modules.Procurement.Tests.Api;

using Xunit;
using System.Net;
using System.Net.Http.Json;

/// <summary>
/// API tests for ${pascalAction}${aggregate} endpoint
/// </summary>
public class ${pascalAction}${aggregate}Tests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public ${pascalAction}${aggregate}Tests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task ${pascalAction}${aggregate}_ValidRequest_ReturnsOk()
    {
        // Arrange
        var id = Guid.NewGuid();
        var request = new
        {
            // TODO: Add request properties
        };

        // Act
        var response = await _client.${http.charAt(0) + http.slice(1).toLowerCase()}Async(
            $"${route.replace('{id}', '{id}')}",
            ${http === 'GET' || http === 'DELETE' ? '' : 'JsonContent.Create(request),'}
            default);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ${pascalAction}${aggregate}_Unauthorized_Returns401()
    {
        // Arrange
        var unauthorizedClient = new HttpClient { BaseAddress = _client.BaseAddress };
        var id = Guid.NewGuid();

        // Act
        var response = await unauthorizedClient.${http.charAt(0) + http.slice(1).toLowerCase()}Async(
            $"${route.replace('{id}', '{id}')}",
            default);

        // Assert
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // TODO: Add more test cases (validation, business logic, edge cases)
}
`;
}

// ─── File Writing ───────────────────────────────────────────────────────────

async function writeGeneratedFile(file: GeneratedFile): Promise<{
  status: 'created' | 'appended' | 'skipped';
}> {
  const exists = await fs.access(file.path).then(() => true).catch(() => false);

  if (exists) {
    if (file.mode === 'append') {
      // Append mode: add to existing file with marker
      const existing = await fs.readFile(file.path, 'utf-8');
      const marker = '// --- AUTO-GENERATED ENDPOINTS ---';

      if (existing.includes(marker)) {
        // Insert before closing brace
        const lines = existing.split('\n');
        const insertIndex = lines.findIndex(line => line.includes(marker));

        if (insertIndex !== -1) {
          lines.splice(insertIndex + 1, 0, file.content);
          await fs.writeFile(file.path, lines.join('\n'));
          return { status: 'appended' };
        }
      }

      // No marker found, append with marker
      await fs.appendFile(file.path, '\n' + marker + '\n' + file.content);
      return { status: 'appended' };
    } else if (file.mode === 'overwrite') {
      await fs.writeFile(file.path, file.content, 'utf-8');
      return { status: 'created' };
    } else {
      // Skip existing files in 'create' mode
      console.warn(`[Generator] SKIP: File exists: ${file.path}`);
      return { status: 'skipped' };
    }
  }

  // Create new file
  await fs.mkdir(path.dirname(file.path), { recursive: true });
  await fs.writeFile(file.path, file.content, 'utf-8');

  return { status: 'created' };
}
