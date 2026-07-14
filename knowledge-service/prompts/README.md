# Autonomous Development Prompt Templates

Token-optimized prompt templates for the autonomous development scheduler.

## Templates

| File | Size | Description |
|------|------|-------------|
| `autonomous-dev-base.txt` | ~150 tokens | Core instructions (always included) |
| `autonomous-dev-architect.txt` | ~100 tokens | Architect coordination guidance |
| `autonomous-dev-mcp.txt` | ~80 tokens | MCP tool usage examples |
| `autonomous-dev-queue.txt` | ~70 tokens | Empty queue handling |

## Token Budget

Default budget: **300 tokens** (configurable via `AUTONOMOUS_DEV_TOKEN_BUDGET`)

**Before optimization:** ~500 tokens (verbose markdown)
**After optimization:** ~150-250 tokens (50% reduction)

## Configuration

Templates are conditionally included based on `.env` configuration:

### Base Template (Always)
```
{{cycleId}}, {{focusFile}}, core tasks, rules
```

### Architect Guidance
- `AUTONOMOUS_DEV_INCLUDE_ARCHITECT_GUIDANCE=always` — include every cycle
- `AUTONOMOUS_DEV_INCLUDE_ARCHITECT_GUIDANCE=auto` — include every 5th cycle (default)
- `AUTONOMOUS_DEV_INCLUDE_ARCHITECT_GUIDANCE=never` — never include

### MCP Examples
- `AUTONOMOUS_DEV_INCLUDE_MCP_EXAMPLES=always` — include every cycle
- `AUTONOMOUS_DEV_INCLUDE_MCP_EXAMPLES=first-3` — first 3 cycles only (default)
- `AUTONOMOUS_DEV_INCLUDE_MCP_EXAMPLES=never` — never include

### Queue Guidance
- `AUTONOMOUS_DEV_INCLUDE_QUEUE_GUIDANCE=always` — include every cycle
- `AUTONOMOUS_DEV_INCLUDE_QUEUE_GUIDANCE=auto` — include every 10th cycle (default)
- `AUTONOMOUS_DEV_INCLUDE_QUEUE_GUIDANCE=never` — never include

## Template Variables

Templates support simple string replacement:
- `{{cycleId}}` → cycle number (e.g., "1", "2", "3")
- `{{focusFile}}` → focus document path

## Editing Templates

1. Keep templates concise (aim for <200 chars per template)
2. Use markdown sparingly (only essential formatting)
3. Avoid repeated context (assume Conductor has session memory)
4. Test token count after edits:
   ```bash
   node -e "const fs=require('fs'); const t=fs.readFileSync('prompts/autonomous-dev-base.txt','utf8'); console.log('Tokens:', Math.ceil(t.length/4))"
   ```

## Token Estimation

Rough estimate: **1 token ≈ 4 characters**

This is approximate. Actual token count varies by model tokenizer (Claude uses BPE).

For accurate counting, consider using `tiktoken` library:
```bash
npm install tiktoken
```

## Usage in Code

```typescript
import { determinePromptContext, buildSmartPrompt } from './autonomousDev';

const context = determinePromptContext(config, cycleId);
const prompt = await buildSmartPrompt(config, cycleId, context);
const tokenCount = estimateTokens(prompt);

console.log(`Prompt: ${tokenCount} tokens / ${config.tokenBudget} budget`);
```

## Testing

Unit tests: `src/__tests__/unit/autonomousDev.test.ts`

```bash
npm test -- autonomousDev.test.ts
```

Tests verify:
- Template file existence
- Token estimation accuracy
- Conditional section inclusion
- Budget compliance
- Auto-detection logic (5th cycle, 10th cycle)
