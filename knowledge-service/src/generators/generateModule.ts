/**
 * .NET Module Skeleton Generator (Track B)
 *
 * Generates a complete .NET module skeleton with:
 * - Domain layer (aggregate, enums, events, repository interface)
 * - Application layer (DTOs, commands, handlers)
 * - Infrastructure layer (EF configuration, repository implementation)
 * - Test skeletons
 *
 * Generates 9+ files per module.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { GeneratedFile, Property } from './types';
import { toPascalCase, toCamelCase, toSlug } from './utils/casing';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const BACKEND_DIR = process.env.BACKEND_DIR || `${SPACEOS_ROOT}/backend`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GenerateModuleParams {
  module: string;           // spaceos-modules-procurement
  aggregate: string;        // SupplierComplaint
  states: string[];         // ["Draft", "Submitted", "UnderReview", ...]
  endpoints?: string[];     // ["create", "list", "submit", ...]
  properties?: Property[];  // Additional properties beyond Id, TenantId, Status
}



export interface GenerateModuleResult {
  success: boolean;
  filesCreated: string[];
  filesSkipped: string[];
  errors: string[];
}

// ─── Main Generator Function ────────────────────────────────────────────────

/**
 * Generate complete .NET module skeleton
 */
export async function generateModule(params: GenerateModuleParams): Promise<GenerateModuleResult> {
  const files: GeneratedFile[] = [];
  const { module, aggregate, states, endpoints, properties } = params;

  const modulePath = `${BACKEND_DIR}/${module}`;
  const pascalAggregate = toPascalCase(aggregate);
  const camelAggregate = toCamelCase(aggregate);

  console.log(`[GenerateModule] Generating skeleton for ${pascalAggregate} in ${module}`);

  // 1. Generate Status Enum
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Domain/Enums/${pascalAggregate}Status.cs`,
    content: generateStatusEnum(pascalAggregate, states),
    mode: 'create',
  });

  // 2. Generate Aggregate
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Domain/Aggregates/${pascalAggregate}.cs`,
    content: generateAggregate(pascalAggregate, states, properties),
    mode: 'create',
  });

  // 3. Generate Domain Events (one per state transition)
  for (const state of states) {
    files.push({
      path: `${modulePath}/src/${pascalAggregate}.Domain/Events/${pascalAggregate}${state}Event.cs`,
      content: generateDomainEvent(pascalAggregate, state),
      mode: 'create',
    });
  }

  // 4. Generate Repository Interface
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Domain/Interfaces/I${pascalAggregate}Repository.cs`,
    content: generateRepositoryInterface(pascalAggregate),
    mode: 'create',
  });

  // 5. Generate DTOs
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Application/DTOs/${pascalAggregate}Dto.cs`,
    content: generateDto(pascalAggregate, states, properties),
    mode: 'create',
  });

  // 6. Generate Commands (if endpoints specified)
  if (endpoints && endpoints.length > 0) {
    for (const endpoint of endpoints) {
      const pascalAction = toPascalCase(endpoint);

      // Command
      files.push({
        path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}Command.cs`,
        content: generateCommand(pascalAggregate, endpoint),
        mode: 'create',
      });

      // Command Handler
      files.push({
        path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}CommandHandler.cs`,
        content: generateCommandHandler(pascalAggregate, endpoint),
        mode: 'create',
      });

      // Validator
      files.push({
        path: `${modulePath}/src/${pascalAggregate}.Application/Commands/${pascalAction}${pascalAggregate}/${pascalAction}${pascalAggregate}Validator.cs`,
        content: generateValidator(pascalAggregate, endpoint),
        mode: 'create',
      });
    }
  }

  // 7. Generate EF Configuration
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Infrastructure/Persistence/Configurations/${pascalAggregate}Configuration.cs`,
    content: generateEfConfiguration(pascalAggregate, properties),
    mode: 'create',
  });

  // 8. Generate Repository Implementation
  files.push({
    path: `${modulePath}/src/${pascalAggregate}.Infrastructure/Repositories/${pascalAggregate}Repository.cs`,
    content: generateRepositoryImpl(pascalAggregate),
    mode: 'create',
  });

  // 9. Generate Test Skeletons
  files.push({
    path: `${modulePath}/tests/${pascalAggregate}.Tests/Domain/${pascalAggregate}Tests.cs`,
    content: generateDomainTests(pascalAggregate, states),
    mode: 'create',
  });

  // Write all files
  const filesCreated: string[] = [];
  const filesSkipped: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const result = await writeGeneratedFile(file);
      if (result.status === 'created') {
        filesCreated.push(file.path);
      } else if (result.status === 'skipped') {
        filesSkipped.push(file.path);
      }
    } catch (error) {
      errors.push(`${file.path}: ${error}`);
      console.error(`[GenerateModule] Error writing ${file.path}:`, error);
    }
  }

  console.log(`[GenerateModule] Generated ${filesCreated.length} files, skipped ${filesSkipped.length}`);

  return {
    success: errors.length === 0,
    filesCreated,
    filesSkipped,
    errors,
  };
}

// ─── Template Generators ────────────────────────────────────────────────────

function generateStatusEnum(name: string, states: string[]): string {
  return `namespace SpaceOS.Modules.Procurement.Domain.Enums;

/// <summary>
/// Status values for ${name}
/// </summary>
public enum ${name}Status
{
${states.map((s, i) => `    /// <summary>${s} status</summary>\n    ${s} = ${i}`).join(',\n')}
}
`;
}

function generateAggregate(name: string, states: string[], properties?: Property[]): string {
  const propsCode = properties
    ? properties.map(p => `    public ${p.type}${p.nullable ? '?' : ''} ${p.name} { get; private set; }`).join('\n')
    : '';

  return `namespace SpaceOS.Modules.Procurement.Domain.Aggregates;

using SpaceOS.Modules.Procurement.Domain.Enums;
using SpaceOS.Modules.Procurement.Domain.Events;
using Ardalis.Result;

/// <summary>
/// ${name} aggregate root
/// </summary>
public class ${name} : AggregateRoot
{
    public Guid Id { get; private set; }
    public Guid TenantId { get; private set; }
    public ${name}Status Status { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? UpdatedAt { get; private set; }
${propsCode ? '\n' + propsCode + '\n' : ''}
    private ${name}() { } // EF Core

    /// <summary>
    /// Create new ${name}
    /// </summary>
    public static Result<${name}> Create(Guid tenantId)
    {
        var entity = new ${name}
        {
            Id = Guid.NewGuid(),
            TenantId = tenantId,
            Status = ${name}Status.${states[0]},
            CreatedAt = DateTimeOffset.UtcNow,
        };

        entity.AddDomainEvent(new ${name}CreatedEvent(entity.Id, entity.TenantId));
        return Result.Success(entity);
    }

${states.slice(1).map(state => `    /// <summary>
    /// Transition to ${state} status
    /// </summary>
    public Result ${state}()
    {
        // TODO: Add business logic validation and FSM guards
        Status = ${name}Status.${state};
        UpdatedAt = DateTimeOffset.UtcNow;
        AddDomainEvent(new ${name}${state}Event(Id, TenantId));
        return Result.Success();
    }
`).join('\n')}
}
`;
}

function generateDomainEvent(name: string, state: string): string {
  return `namespace SpaceOS.Modules.Procurement.Domain.Events;

/// <summary>
/// Event raised when ${name} transitions to ${state}
/// </summary>
public record ${name}${state}Event(Guid AggregateId, Guid TenantId) : DomainEvent;
`;
}

function generateRepositoryInterface(name: string): string {
  return `namespace SpaceOS.Modules.Procurement.Domain.Interfaces;

/// <summary>
/// Repository interface for ${name}
/// </summary>
public interface I${name}Repository
{
    Task<${name}?> GetByIdAsync(Guid id, CancellationToken ct = default);
    Task<IReadOnlyList<${name}>> GetByTenantAsync(Guid tenantId, CancellationToken ct = default);
    Task AddAsync(${name} entity, CancellationToken ct = default);
    Task UpdateAsync(${name} entity, CancellationToken ct = default);
    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
`;
}

function generateDto(name: string, states: string[], properties?: Property[]): string {
  const propsCode = properties
    ? properties.map(p => `    public ${p.type}${p.nullable ? '?' : ''} ${p.name} { get; init; }`).join('\n')
    : '';

  return `namespace SpaceOS.Modules.Procurement.Application.DTOs;

/// <summary>
/// DTO for ${name}
/// </summary>
public record ${name}Dto
{
    public Guid Id { get; init; }
    public Guid TenantId { get; init; }
    public string Status { get; init; } = string.Empty;
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? UpdatedAt { get; init; }
${propsCode ? '\n' + propsCode : ''}
}
`;
}

function generateCommand(name: string, action: string): string {
  const pascalAction = toPascalCase(action);

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${name};

using MediatR;
using Ardalis.Result;

/// <summary>
/// Command to ${action} ${name}
/// </summary>
public record ${pascalAction}${name}Command : IRequest<Result>
{
    public Guid TenantId { get; init; }
    // TODO: Add command properties
}
`;
}

function generateCommandHandler(name: string, action: string): string {
  const pascalAction = toPascalCase(action);

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${name};

using MediatR;
using Ardalis.Result;
using SpaceOS.Modules.Procurement.Domain.Interfaces;

/// <summary>
/// Handler for ${pascalAction}${name}Command
/// </summary>
public class ${pascalAction}${name}CommandHandler : IRequestHandler<${pascalAction}${name}Command, Result>
{
    private readonly I${name}Repository _repository;

    public ${pascalAction}${name}CommandHandler(I${name}Repository repository)
    {
        _repository = repository;
    }

    public async Task<Result> Handle(${pascalAction}${name}Command request, CancellationToken ct)
    {
        // TODO: Implement command logic
        throw new NotImplementedException();
    }
}
`;
}

function generateValidator(name: string, action: string): string {
  const pascalAction = toPascalCase(action);

  return `namespace SpaceOS.Modules.Procurement.Application.Commands.${pascalAction}${name};

using FluentValidation;

/// <summary>
/// Validator for ${pascalAction}${name}Command
/// </summary>
public class ${pascalAction}${name}Validator : AbstractValidator<${pascalAction}${name}Command>
{
    public ${pascalAction}${name}Validator()
    {
        // TODO: Add validation rules
        RuleFor(x => x.TenantId).NotEmpty();
    }
}
`;
}

function generateEfConfiguration(name: string, properties?: Property[]): string {
  const propsConfig = properties
    ? properties.map(p => `        builder.Property(e => e.${p.name})${p.nullable ? '' : '\n            .IsRequired()'};`).join('\n')
    : '';

  return `namespace SpaceOS.Modules.Procurement.Infrastructure.Persistence.Configurations;

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SpaceOS.Modules.Procurement.Domain.Aggregates;

/// <summary>
/// EF Core configuration for ${name}
/// </summary>
public class ${name}Configuration : IEntityTypeConfiguration<${name}>
{
    public void Configure(EntityTypeBuilder<${name}> builder)
    {
        builder.ToTable("${name}s");

        builder.HasKey(e => e.Id);

        builder.Property(e => e.TenantId)
            .IsRequired();

        builder.Property(e => e.Status)
            .IsRequired();

        builder.Property(e => e.CreatedAt)
            .IsRequired();

${propsConfig ? propsConfig + '\n\n' : ''}        // Indexes
        builder.HasIndex(e => new { e.TenantId, e.Status });
    }
}
`;
}

function generateRepositoryImpl(name: string): string {
  return `namespace SpaceOS.Modules.Procurement.Infrastructure.Repositories;

using Microsoft.EntityFrameworkCore;
using SpaceOS.Modules.Procurement.Domain.Aggregates;
using SpaceOS.Modules.Procurement.Domain.Interfaces;
using SpaceOS.Modules.Procurement.Infrastructure.Persistence;

/// <summary>
/// Repository implementation for ${name}
/// </summary>
public class ${name}Repository : I${name}Repository
{
    private readonly ProcurementDbContext _context;

    public ${name}Repository(ProcurementDbContext context)
    {
        _context = context;
    }

    public async Task<${name}?> GetByIdAsync(Guid id, CancellationToken ct = default)
    {
        return await _context.Set<${name}>()
            .AsNoTracking()
            .FirstOrDefaultAsync(e => e.Id == id, ct)
            .ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<${name}>> GetByTenantAsync(Guid tenantId, CancellationToken ct = default)
    {
        return await _context.Set<${name}>()
            .AsNoTracking()
            .Where(e => e.TenantId == tenantId)
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    public async Task AddAsync(${name} entity, CancellationToken ct = default)
    {
        await _context.Set<${name}>().AddAsync(entity, ct).ConfigureAwait(false);
    }

    public Task UpdateAsync(${name} entity, CancellationToken ct = default)
    {
        _context.Set<${name}>().Update(entity);
        return Task.CompletedTask;
    }

    public async Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        return await _context.SaveChangesAsync(ct).ConfigureAwait(false);
    }
}
`;
}

function generateDomainTests(name: string, states: string[]): string {
  return `namespace SpaceOS.Modules.Procurement.Tests.Domain;

using Xunit;
using SpaceOS.Modules.Procurement.Domain.Aggregates;
using SpaceOS.Modules.Procurement.Domain.Enums;

/// <summary>
/// Domain tests for ${name}
/// </summary>
public class ${name}Tests
{
    [Fact]
    public void Create_ValidData_ReturnsSuccess()
    {
        // Arrange
        var tenantId = Guid.NewGuid();

        // Act
        var result = ${name}.Create(tenantId);

        // Assert
        Assert.True(result.IsSuccess);
        Assert.Equal(${name}Status.${states[0]}, result.Value.Status);
        Assert.Equal(tenantId, result.Value.TenantId);
    }

${states.slice(1).map(state => `    [Fact]
    public void ${state}_From${states[0]}_Success()
    {
        // Arrange
        var entity = ${name}.Create(Guid.NewGuid()).Value;

        // Act
        var result = entity.${state}();

        // Assert
        Assert.True(result.IsSuccess);
        Assert.Equal(${name}Status.${state}, entity.Status);
    }
`).join('\n')}
    // TODO: Add FSM guard tests (invalid transitions)
}
`;
}

// ─── File Writing ───────────────────────────────────────────────────────────

async function writeGeneratedFile(file: GeneratedFile): Promise<{ status: 'created' | 'skipped' | 'appended' }> {
  const exists = await fs.access(file.path).then(() => true).catch(() => false);

  if (exists && file.mode !== 'overwrite') {
    console.warn(`[Generator] SKIP: File exists: ${file.path}`);
    return { status: 'skipped' };
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(file.path), { recursive: true });

  // Write file
  await fs.writeFile(file.path, file.content, 'utf-8');

  return { status: 'created' };
}
